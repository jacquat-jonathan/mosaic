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
use std::path::PathBuf;
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

fn load(_app: &AppHandle) -> CmdResult<SubscriptionStore> {
    let settings = Settings::load();
    let Some(value) = settings.other.get(SETTINGS_KEY) else {
        return Ok(SubscriptionStore::default());
    };
    serde_json::from_value(value.clone()).map_err(|error| {
        Error::Invalid(format!(
            "calendar subscription metadata is invalid: {error}"
        ))
    })
}

fn save(_app: &AppHandle, store: &SubscriptionStore) -> CmdResult<()> {
    let value = serde_json::to_value(store).map_err(|error| Error::Invalid(error.to_string()))?;
    Settings::update(|settings| {
        settings.other.insert(SETTINGS_KEY.into(), value);
        true
    })
    .map_err(|error| io_error("settings.json", error))
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
    let url = get_secret(&subscription.id)?;
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
    let path = cache_path(app, subscription)?;
    let temporary = path.with_extension("ics.tmp");
    fs::write(&temporary, &bytes)
        .map_err(|error| io_error(temporary.display().to_string(), error))?;
    fs::rename(&temporary, &path).map_err(|error| io_error(path.display().to_string(), error))?;
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
    };
    let refresh = refresh_one(&app, &mut subscription, true).await;
    if let Err(error) = refresh {
        subscription.last_error = Some(error.to_string());
    }
    let mut store = load(&app)?;
    store
        .vaults
        .entry(key)
        .or_default()
        .push(subscription.clone());
    save(&app, &store)?;
    view(&app, &subscription)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn update_calendar_subscription(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    name: String,
    color: String,
    visible: bool,
    refresh_minutes: u32,
) -> CmdResult<SubscriptionView> {
    if name.trim().is_empty() || refresh_minutes < 5 {
        return Err(Error::Invalid(
            "invalid calendar subscription settings".into(),
        ));
    }
    let key = vault_key(&state)?;
    let mut store = load(&app)?;
    let subscription = store
        .vaults
        .get_mut(&key)
        .and_then(|items| items.iter_mut().find(|item| item.id == id))
        .ok_or_else(|| Error::NotFound(format!("calendar subscription/{id}")))?;
    subscription.name = name.trim().to_string();
    subscription.color = color;
    subscription.visible = visible;
    subscription.refresh_minutes = refresh_minutes;
    let result = subscription.clone();
    save(&app, &store)?;
    view(&app, &result)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn remove_calendar_subscription(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> CmdResult<()> {
    let key = vault_key(&state)?;
    let mut store = load(&app)?;
    let items = store.vaults.entry(key).or_default();
    let index = items
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| Error::NotFound(format!("calendar subscription/{id}")))?;
    let subscription = items.remove(index);
    let path = cache_path(&app, &subscription)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|error| io_error(path.display().to_string(), error))?;
    }
    delete_secret(&id);
    save(&app, &store)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn refresh_calendar_subscriptions(
    app: AppHandle,
    state: State<'_, AppState>,
    force: bool,
) -> CmdResult<Vec<SubscriptionView>> {
    let key = vault_key(&state)?;
    let mut store = load(&app)?;
    let items = store.vaults.entry(key).or_default();
    for subscription in items.iter_mut() {
        if !subscription.visible && !force {
            continue;
        }
        if let Err(error) = refresh_one(&app, subscription, force).await {
            subscription.last_error = Some(error.to_string());
        }
    }
    let result = items
        .iter()
        .map(|subscription| view(&app, subscription))
        .collect::<CmdResult<Vec<_>>>()?;
    save(&app, &store)?;
    Ok(result)
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
    let items = store.vaults.get(&key).cloned().unwrap_or_default();
    let mut occurrences = Vec::new();
    for subscription in items.iter().filter(|item| item.visible) {
        let path = cache_path(&app, subscription)?;
        if !path.is_file() {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| io_error(path.display().to_string(), error))?;
        occurrences.extend(overlay_occurrences(
            &content,
            &subscription.id,
            &subscription.name,
            Some(subscription.color.clone()),
            &from,
            &to,
            &timezone,
        )?);
    }
    occurrences.sort_by(|a, b| a.start_value.cmp(&b.start_value));
    Ok(OverlayRange {
        subscriptions: items
            .iter()
            .map(|subscription| view(&app, subscription))
            .collect::<CmdResult<Vec<_>>>()?,
        occurrences,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_never_serializes_a_feed_url() {
        let subscription = Subscription {
            id: "id".into(),
            name: "Team".into(),
            color: "#5b8def".into(),
            visible: true,
            refresh_minutes: 30,
            etag: None,
            last_modified: None,
            last_success: None,
            last_error: None,
            cache_file: "id.ics".into(),
        };
        let encoded = serde_json::to_string(&subscription).unwrap();
        assert!(!encoded.contains("url"));
        assert!(!encoded.contains("https"));
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
