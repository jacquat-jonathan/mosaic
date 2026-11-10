use crate::{AppState, CmdResult};
use chrono::{DateTime, SecondsFormat, Utc};
use mosaic_core::Error;
use mosaic_core::planner::{OverlayOccurrence, overlay_occurrences, validate_ical};
use mosaic_core::settings::Settings;
use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const SERVICE: &str = "com.mosaic.calendar-subscription";
const SETTINGS_KEY: &str = "calendar_subscriptions";
const MAX_FEED_BYTES: usize = 10 * 1024 * 1024;

fn io_error(path: impl Into<String>, source: std::io::Error) -> Error {
    Error::Io {
        path: path.into(),
        source,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Subscription {
    id: String,
    name: String,
    color: String,
    visible: bool,
    refresh_minutes: u32,
    etag: Option<String>,
    last_modified: Option<String>,
    last_success: Option<String>,
    last_error: Option<String>,
    cache_file: String,
    #[serde(default)]
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SubscriptionStore {
    vaults: HashMap<String, Vec<Subscription>>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct SubscriptionView {
    id: String,
    name: String,
    color: String,
    visible: bool,
    refresh_minutes: u32,
    last_success: Option<String>,
    last_error: Option<String>,
    has_cache: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct OverlayRange {
    subscriptions: Vec<SubscriptionView>,
    occurrences: Vec<OverlayOccurrence>,
}

fn app_directory(app: &AppHandle) -> CmdResult<PathBuf> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| Error::Invalid(format!("calendar data directory unavailable: {error}")))?;
    fs::create_dir_all(&path).map_err(|error| io_error(path.display().to_string(), error))?;
    Ok(path)
}

fn cache_directory(app: &AppHandle) -> CmdResult<PathBuf> {
    let path = app_directory(app)?.join("calendar-cache");
    fs::create_dir_all(&path).map_err(|error| io_error(path.display().to_string(), error))?;
    Ok(path)
}

fn decode(settings: &Settings) -> CmdResult<SubscriptionStore> {
    match settings.other.get(SETTINGS_KEY) {
        None => Ok(SubscriptionStore::default()),
        Some(value) => serde_json::from_value(value.clone()).map_err(|error| {
            Error::Invalid(format!(
                "calendar subscription metadata is invalid: {error}"
            ))
        }),
    }
}

fn load(_app: &AppHandle) -> CmdResult<SubscriptionStore> {
    decode(&Settings::try_load().map_err(|e| io_error("settings.json", e))?)
}

fn mutate<T>(change: impl FnOnce(&mut SubscriptionStore) -> CmdResult<T>) -> CmdResult<T> {
    // Settings::try_update holds the cross-process lock through decoding, mutation and persistence.
    Settings::try_update(|settings| mutate_settings(settings, change))
        .map_err(|e| io_error("settings.json", e))?
}

fn mutate_settings<T>(
    settings: &mut Settings,
    change: impl FnOnce(&mut SubscriptionStore) -> CmdResult<T>,
) -> std::io::Result<(CmdResult<T>, bool)> {
    // Domain failures retain their wire error codes and do not persist partially mutated state.
    let result = (|| {
        let mut store = decode(settings)?;
        let result = change(&mut store)?;
        let value = serde_json::to_value(store).map_err(|e| Error::Invalid(e.to_string()))?;
        Ok((result, value))
    })();
    match result {
        Ok((result, value)) => {
            settings.other.insert(SETTINGS_KEY.into(), value);
            Ok((Ok(result), true))
        }
        Err(error) => Ok((Err(error), false)),
    }
}

/// Commit only download-owned fields, provided this is still the feed/version that was fetched.
fn merge_refresh(
    store: &mut SubscriptionStore,
    key: &str,
    before: &Subscription,
    fetched: &Subscription,
) -> bool {
    let Some(current) = store
        .vaults
        .get_mut(key)
        .and_then(|items| items.iter_mut().find(|s| s.id == before.id))
    else {
        return false;
    };
    if current.revision != before.revision || current.cache_file != before.cache_file {
        return false;
    }
    current.etag = fetched.etag.clone();
    current.last_modified = fetched.last_modified.clone();
    current.last_success = fetched.last_success.clone();
    current.last_error = fetched.last_error.clone();
    current.cache_file = fetched.cache_file.clone();
    current.revision += 1;
    true
}

fn vault_key(state: &State<AppState>) -> CmdResult<String> {
    Ok(state.get()?.vault.root().display().to_string())
}

fn cache_path(app: &AppHandle, subscription: &Subscription) -> CmdResult<PathBuf> {
    Ok(cache_directory(app)?.join(&subscription.cache_file))
}

fn view(app: &AppHandle, subscription: &Subscription) -> CmdResult<SubscriptionView> {
    Ok(SubscriptionView {
        id: subscription.id.clone(),
        name: subscription.name.clone(),
        color: subscription.color.clone(),
        visible: subscription.visible,
        refresh_minutes: subscription.refresh_minutes,
        last_success: subscription.last_success.clone(),
        last_error: subscription.last_error.clone(),
        has_cache: cache_path(app, subscription)?.is_file(),
    })
}

#[cfg(target_os = "macos")]
fn set_secret(id: &str, value: &str) -> CmdResult<()> {
    let status = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            SERVICE,
            "-a",
            id,
            "-w",
            value,
        ])
        .status()
        .map_err(|error| Error::Invalid(format!("could not access Keychain: {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Invalid(
            "Keychain refused the calendar subscription secret".into(),
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn set_secret(_id: &str, _value: &str) -> CmdResult<()> {
    Err(Error::Invalid(
        "calendar subscriptions currently require macOS Keychain".into(),
    ))
}

#[cfg(target_os = "macos")]
fn get_secret(id: &str) -> CmdResult<String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", SERVICE, "-a", id, "-w"])
        .output()
        .map_err(|error| Error::Invalid(format!("could not access Keychain: {error}")))?;
    if !output.status.success() {
        return Err(Error::Invalid(
            "calendar subscription secret is missing from Keychain".into(),
        ));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|_| Error::Invalid("calendar subscription secret is invalid".into()))
}

#[cfg(not(target_os = "macos"))]
fn get_secret(_id: &str) -> CmdResult<String> {
    Err(Error::Invalid(
        "calendar subscriptions currently require macOS Keychain".into(),
    ))
}

#[cfg(target_os = "macos")]
fn delete_secret(id: &str) {
    let _ = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", id])
        .status();
}

#[cfg(not(target_os = "macos"))]
fn delete_secret(_id: &str) {}

fn due(subscription: &Subscription) -> bool {
    let Some(last) = subscription.last_success.as_deref() else {
        return true;
    };
    DateTime::parse_from_rfc3339(last)
        .map(|last| {
            Utc::now()
                .signed_duration_since(last.with_timezone(&Utc))
                .num_minutes()
                >= i64::from(subscription.refresh_minutes)
        })
        .unwrap_or(true)
}

fn normalized_url(value: &str) -> CmdResult<reqwest::Url> {
    let value = value.trim();
    let normalized = if let Some(rest) = value.strip_prefix("webcal://") {
        format!("https://{rest}")
    } else {
        value.to_string()
    };
    let parsed = reqwest::Url::parse(&normalized)
        .map_err(|_| Error::Invalid("calendar subscription URL is invalid".into()))?;
    if parsed.scheme() != "https" {
        return Err(Error::Invalid(
            "calendar subscriptions require an HTTPS or webcal URL".into(),
        ));
    }
    Ok(parsed)
}

async fn refresh_one(
    app: &AppHandle,
    subscription: &mut Subscription,
    force: bool,
) -> CmdResult<()> {
    if !force && !due(subscription) {
        return Ok(());
    }
    let url = get_secret(
        subscription
            .secret_id
            .as_deref()
            .unwrap_or(&subscription.id),
    )?;
    let parsed = normalized_url(&url)?;
    let client = crate::http::client(Duration::from_secs(15))
        .map_err(|_| Error::Invalid("could not initialize calendar download".into()))?;
    let mut request = client.get(parsed);
    if let Some(etag) = &subscription.etag {
        request = request.header(IF_NONE_MATCH, etag);
    }
    if let Some(last_modified) = &subscription.last_modified {
        request = request.header(IF_MODIFIED_SINCE, last_modified);
    }
    let response = request
        .send()
        .await
        .map_err(|_| Error::Invalid("calendar feed could not be reached".into()))?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        subscription.last_success = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        subscription.last_error = None;
        return Ok(());
    }
    if !response.status().is_success() {
        return Err(Error::Invalid(format!(
            "calendar feed returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let last_modified = response
        .headers()
        .get(LAST_MODIFIED)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut bytes = Vec::new();
    crate::http::read_capped(response, MAX_FEED_BYTES as u64, |chunk, _| {
        bytes.extend_from_slice(chunk);
        Ok(())
    })
    .await
    .map_err(|e| {
        Error::Invalid(if e.contains("larger") {
            "calendar feed is larger than 10 MB".into()
        } else {
            "calendar feed download was interrupted".into()
        })
    })?;
    let content = std::str::from_utf8(&bytes)
        .map_err(|_| Error::Invalid("calendar feed is not UTF-8".into()))?;
    validate_ical(content, "UTC")?;
    let directory = cache_directory(app)?;
    let mut temporary = tempfile::Builder::new()
        .prefix("feed-")
        .suffix(".ics")
        .tempfile_in(&directory)
        .map_err(|e| io_error(directory.display().to_string(), e))?;
    std::io::Write::write_all(&mut temporary, &bytes).map_err(|e| io_error("calendar cache", e))?;
    let (_, path) = temporary
        .keep()
        .map_err(|e| io_error("calendar cache", e.error))?;
    subscription.cache_file = path.file_name().unwrap().to_string_lossy().into_owned();
    subscription.etag = etag;
    subscription.last_modified = last_modified;
    subscription.last_success = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    subscription.last_error = None;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn calendar_subscriptions(
    app: AppHandle,
    state: State<AppState>,
) -> CmdResult<Vec<SubscriptionView>> {
    let key = vault_key(&state)?;
    load(&app)?
        .vaults
        .get(&key)
        .into_iter()
        .flatten()
        .map(|subscription| view(&app, subscription))
        .collect()
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn add_calendar_subscription(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    url: String,
    color: String,
    refresh_minutes: u32,
) -> CmdResult<SubscriptionView> {
    let name = name.trim();
    if name.is_empty() || refresh_minutes < 5 {
        return Err(Error::Invalid(
            "subscription name is required and refresh must be at least five minutes".into(),
        ));
    }
    let parsed = normalized_url(&url)?;
    let key = vault_key(&state)?;
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    hasher.update(name.as_bytes());
    hasher.update(
        Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
            .to_be_bytes(),
    );
    let digest = hasher.finalize();
    let id = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    set_secret(&id, parsed.as_str())?;
    let mut subscription = Subscription {
        id: id.clone(),
        name: name.to_string(),
        color,
        visible: true,
        refresh_minutes,
        etag: None,
        last_modified: None,
        last_success: None,
        last_error: None,
        cache_file: format!("{id}.ics"),
        revision: 0,
        secret_id: None,
    };
    let refresh = refresh_one(&app, &mut subscription, true).await;
    if let Err(error) = refresh {
        subscription.last_error = Some(error.to_string());
    }
    if let Err(error) = mutate(|store| {
        store
            .vaults
            .entry(key)
            .or_default()
            .push(subscription.clone());
        Ok(())
    }) {
        delete_secret(&id);
        if let Ok(path) = cache_path(&app, &subscription) {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    view(&app, &subscription)
}

#[tauri::command(async)]
#[specta::specta]
// Tauri injects app/state alongside the flat arguments shared with the generated UI bindings.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_calendar_subscription(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    name: String,
    color: String,
    visible: bool,
    refresh_minutes: u32,
    url: Option<String>,
) -> CmdResult<SubscriptionView> {
    if name.trim().is_empty() || refresh_minutes < 5 {
        return Err(Error::Invalid(
            "invalid calendar subscription settings".into(),
        ));
    }
    let key = vault_key(&state)?;
    let replacement = url
        .filter(|url| !url.trim().is_empty())
        .map(|url| normalized_url(&url))
        .transpose()?;
    // Stage credentials under a new key outside the metadata lock. Publishing the key with the
    // feed revision is atomic; a failed commit cannot roll back another writer's credentials.
    static NEXT_SECRET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let replacement_key = if let Some(url) = &replacement {
        let key = format!(
            "{id}-{}-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            NEXT_SECRET.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        set_secret(&key, url.as_str())?;
        Some(key)
    } else {
        None
    };
    let mut previous_secret = None;
    let mut previous_cache = None;
    let result = mutate(|store| {
        let subscription = store
            .vaults
            .get_mut(&key)
            .and_then(|items| items.iter_mut().find(|item| item.id == id))
            .ok_or_else(|| Error::NotFound(format!("calendar subscription/{id}")))?;
        if let Some(key) = &replacement_key {
            previous_secret = Some(subscription.secret_id.clone().unwrap_or_else(|| id.clone()));
            previous_cache = Some(subscription.cache_file.clone());
            subscription.secret_id = Some(key.clone());
            invalidate_feed(subscription);
            subscription.revision += 1;
        }
        subscription.name = name.trim().to_string();
        subscription.color = color;
        subscription.visible = visible;
        subscription.refresh_minutes = refresh_minutes;
        Ok(subscription.clone())
    });
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            if let Some(key) = replacement_key {
                delete_secret(&key);
            }
            return Err(error);
        }
    };
    if let Some(key) = previous_secret {
        delete_secret(&key);
    }
    if let Some(file) = previous_cache {
        let _ = fs::remove_file(cache_directory(&app)?.join(file));
    }
    view(&app, &result)
}

fn invalidate_feed(subscription: &mut Subscription) {
    subscription.cache_file = format!(
        "{}-{}.ics",
        subscription.id,
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    subscription.etag = None;
    subscription.last_modified = None;
    subscription.last_success = None;
    subscription.last_error = None;
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn remove_calendar_subscription(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> CmdResult<()> {
    let key = vault_key(&state)?;
    let subscription = mutate(|store| {
        let items = store.vaults.entry(key).or_default();
        let index = items
            .iter()
            .position(|item| item.id == id)
            .ok_or_else(|| Error::NotFound(format!("calendar subscription/{id}")))?;
        Ok(items.remove(index))
    })?;
    delete_secret(subscription.secret_id.as_deref().unwrap_or(&id));
    let path = cache_path(&app, &subscription)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|error| io_error(path.display().to_string(), error))?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn refresh_calendar_subscriptions(
    app: AppHandle,
    state: State<'_, AppState>,
    force: bool,
) -> CmdResult<Vec<SubscriptionView>> {
    let key = vault_key(&state)?;
    let store = load(&app)?;
    for before in store.vaults.get(&key).into_iter().flatten() {
        if (!before.visible && !force) || (!force && !due(before)) {
            continue;
        }
        let mut fetched = before.clone();
        if let Err(error) = refresh_one(&app, &mut fetched, force).await {
            fetched.last_error = Some(error.to_string());
        }
        let committed = mutate(|store| Ok(merge_refresh(store, &key, before, &fetched)));
        let accepted = committed.as_ref().is_ok_and(|accepted| *accepted);
        if fetched.cache_file != before.cache_file {
            let obsolete = if accepted { before } else { &fetched };
            let _ = fs::remove_file(cache_path(&app, obsolete)?);
        }
        committed?;
    }
    load(&app)?
        .vaults
        .get(&key)
        .into_iter()
        .flatten()
        .map(|s| view(&app, s))
        .collect()
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn calendar_overlay_range(
    app: AppHandle,
    state: State<AppState>,
    from: String,
    to: String,
    timezone: String,
) -> CmdResult<OverlayRange> {
    let key = vault_key(&state)?;
    let store = load(&app)?;
    let mut items = store.vaults.get(&key).cloned().unwrap_or_default();
    let occurrences = cached_overlays(&mut items, &cache_directory(&app)?, &from, &to, &timezone);
    Ok(OverlayRange {
        subscriptions: items
            .iter()
            .map(|subscription| view(&app, subscription))
            .collect::<CmdResult<Vec<_>>>()?,
        occurrences,
    })
}

fn cached_overlays(
    items: &mut [Subscription],
    directory: &Path,
    from: &str,
    to: &str,
    timezone: &str,
) -> Vec<OverlayOccurrence> {
    let mut occurrences = Vec::new();
    for subscription in items.iter_mut().filter(|item| item.visible) {
        let path = directory.join(&subscription.cache_file);
        if !path.is_file() {
            continue;
        }
        let result = fs::read_to_string(&path)
            .map_err(|error| io_error(path.display().to_string(), error))
            .and_then(|content| {
                overlay_occurrences(
                    &content,
                    &subscription.id,
                    &subscription.name,
                    Some(subscription.color.clone()),
                    from,
                    to,
                    timezone,
                )
            });
        match result {
            Ok(events) => occurrences.extend(events),
            Err(error) => subscription.last_error = Some(error.to_string()),
        }
    }
    occurrences.sort_by(|a, b| a.start_value.cmp(&b.start_value));
    occurrences
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscription(id: &str) -> Subscription {
        Subscription {
            id: id.into(),
            name: "Original".into(),
            color: "blue".into(),
            visible: true,
            refresh_minutes: 30,
            etag: None,
            last_modified: None,
            last_success: None,
            last_error: None,
            cache_file: format!("{id}.ics"),
            revision: 0,
            secret_id: None,
        }
    }

    #[test]
    fn rejected_calendar_mutations_keep_error_codes_and_original_state() {
        let dir = tempfile::tempdir().unwrap();
        Settings::try_update_in(dir.path(), |settings| {
            let mut store = SubscriptionStore::default();
            store
                .vaults
                .insert("vault".into(), vec![subscription("one")]);
            settings
                .other
                .insert(SETTINGS_KEY.into(), serde_json::to_value(store)?);
            Ok(((), true))
        })
        .unwrap();
        let original = fs::read(dir.path().join("settings.json")).unwrap();
        let rejected: CmdResult<()> = Settings::try_update_in(dir.path(), |settings| {
            mutate_settings(settings, |store| {
                store.vaults.clear();
                Err(Error::NotFound("calendar subscription/missing".into()))
            })
        })
        .unwrap();
        assert_eq!(rejected.unwrap_err().code(), "not_found");
        assert_eq!(
            fs::read(dir.path().join("settings.json")).unwrap(),
            original
        );

        let mut malformed = Settings::default();
        malformed
            .other
            .insert(SETTINGS_KEY.into(), serde_json::json!({"vaults": false}));
        let (result, changed) = mutate_settings(&mut malformed, |_| Ok(())).unwrap();
        assert!(!changed);
        assert_eq!(result.unwrap_err().code(), "invalid");
    }

    #[test]
    fn old_metadata_keeps_its_existing_keychain_identity() {
        let mut value = serde_json::to_value(subscription("legacy")).unwrap();
        value.as_object_mut().unwrap().remove("revision");
        value.as_object_mut().unwrap().remove("secret_id");
        let decoded: Subscription = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.revision, 0);
        assert_eq!(
            decoded.secret_id.as_deref().unwrap_or(&decoded.id),
            "legacy"
        );
    }

    #[test]
    fn delayed_refresh_preserves_rename_add_and_delete() {
        let before = subscription("one");
        let mut fetched = before.clone();
        fetched.last_success = Some("now".into());
        fetched.cache_file = "download.ics".into();
        let mut store = SubscriptionStore::default();
        store.vaults.insert("vault".into(), vec![before.clone()]);
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                barrier.wait(); // download started
                barrier.wait(); // user edits completed
                fetched
            });
            barrier.wait();
            store.vaults.get_mut("vault").unwrap()[0].name = "Renamed".into();
            store
                .vaults
                .get_mut("vault")
                .unwrap()
                .push(subscription("two"));
            barrier.wait();
            let fetched = worker.join().unwrap();
            assert!(merge_refresh(&mut store, "vault", &before, &fetched));
            assert_eq!(store.vaults["vault"][0].name, "Renamed");
            assert_eq!(
                store.vaults["vault"][0].last_success.as_deref(),
                Some("now")
            );
            assert_eq!(store.vaults["vault"][1].id, "two");
            store.vaults.get_mut("vault").unwrap().remove(0);
            assert!(!merge_refresh(&mut store, "vault", &before, &fetched));
            assert_eq!(store.vaults["vault"].len(), 1);
        });
    }

    #[test]
    fn replaced_feed_and_overlapping_refresh_reject_stale_downloads() {
        let before = subscription("one");
        let mut fetched = before.clone();
        fetched.cache_file = "download.ics".into();
        let mut store = SubscriptionStore::default();
        store.vaults.insert("vault".into(), vec![before.clone()]);
        assert!(merge_refresh(&mut store, "vault", &before, &fetched));
        assert!(!merge_refresh(&mut store, "vault", &before, &fetched));
        store.vaults.get_mut("vault").unwrap()[0] = before.clone();
        invalidate_feed(&mut store.vaults.get_mut("vault").unwrap()[0]);
        assert!(!merge_refresh(&mut store, "vault", &before, &fetched));
        assert!(store.vaults["vault"][0].last_success.is_none());
    }

    #[test]
    fn invalid_subscription_metadata_is_not_defaults() {
        let mut settings = Settings::default();
        settings
            .other
            .insert(SETTINGS_KEY.into(), serde_json::json!({"vaults": false}));
        assert!(decode(&settings).is_err());
    }

    #[test]
    fn malformed_cached_calendars_keep_the_list_and_other_calendars_events() {
        let directory = tempfile::tempdir().unwrap();
        let base = Subscription {
            id: "good".into(),
            name: "Working calendar".into(),
            color: "#6477d4".into(),
            visible: true,
            refresh_minutes: 30,
            etag: None,
            last_modified: None,
            last_success: None,
            last_error: Some("Refresh unavailable; using cache".into()),
            revision: 0,
            secret_id: None,
            cache_file: "good.ics".into(),
        };
        let mut items = vec![
            base.clone(),
            Subscription {
                id: "bad".into(),
                name: "Broken calendar".into(),
                revision: 0,
                secret_id: None,
                cache_file: "bad.ics".into(),
                last_error: None,
                ..base.clone()
            },
            Subscription {
                id: "corrupt".into(),
                name: "Corrupt calendar".into(),
                revision: 0,
                secret_id: None,
                cache_file: "corrupt.ics".into(),
                last_error: None,
                ..base
            },
        ];
        let good = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:good\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T100000Z\r\nSUMMARY:Working event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        fs::write(directory.path().join("good.ics"), good).unwrap();
        let bad = good.replace(
            "SUMMARY:Working event",
            "RRULE:FREQ=DAILY;BYSETPOS=1\r\nSUMMARY:Unsupported recurrence",
        );
        fs::write(directory.path().join("bad.ics"), &bad).unwrap();
        fs::write(directory.path().join("corrupt.ics"), [0xff, 0xfe]).unwrap();
        let occurrences = cached_overlays(
            &mut items,
            directory.path(),
            "2026-11-03",
            "2026-11-03",
            "UTC",
        );
        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].title, "Working event");
        assert_eq!(occurrences[0].source_id, "good");
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["good", "bad", "corrupt"]
        );
        assert_eq!(
            items[0].last_error.as_deref(),
            Some("Refresh unavailable; using cache")
        );
        // An unsupported recurrence is skipped instead of failing the feed.
        assert!(items[1].last_error.is_none());
        assert!(items[2].last_error.is_some());
        assert_eq!(validate_ical(&bad, "UTC").unwrap(), 0);
        assert_eq!(validate_ical(good, "UTC").unwrap(), 1);
    }

    #[test]
    fn metadata_never_serializes_a_feed_url() {
        let mut subscription = Subscription {
            id: "id".into(),
            name: "Team".into(),
            color: "#5b8def".into(),
            visible: true,
            refresh_minutes: 30,
            etag: None,
            last_modified: None,
            last_success: None,
            last_error: None,
            revision: 0,
            secret_id: None,
            cache_file: "id.ics".into(),
        };
        let encoded = serde_json::to_string(&subscription).unwrap();
        assert!(!encoded.contains("url"));
        assert!(!encoded.contains("https"));
        subscription.etag = Some("old etag".into());
        subscription.last_modified = Some("old modified".into());
        subscription.last_success = Some("2026-11-01T00:00:00Z".into());
        subscription.last_error = Some("old error".into());
        invalidate_feed(&mut subscription);
        assert_ne!(subscription.cache_file, "id.ics");
        assert_eq!(
            std::path::Path::new(&subscription.cache_file)
                .components()
                .count(),
            1
        );
        assert!(subscription.etag.is_none());
        assert!(subscription.last_modified.is_none());
        assert!(subscription.last_success.is_none());
        assert!(subscription.last_error.is_none());
        assert_eq!(subscription.id, "id");
        assert_eq!(subscription.name, "Team");
    }

    #[test]
    fn cache_paths_are_fixed_basenames() {
        let path = std::path::Path::new("calendar-cache").join("abc.ics");
        assert_eq!(path.file_name().unwrap(), "abc.ics");
    }

    #[test]
    fn webcal_is_normalized_and_unsafe_schemes_are_rejected() {
        assert_eq!(
            normalized_url("webcal://calendar.example/team.ics")
                .unwrap()
                .as_str(),
            "https://calendar.example/team.ics"
        );
        assert!(normalized_url("http://calendar.example/team.ics").is_err());
        assert!(normalized_url("file:///private/team.ics").is_err());
    }
}
