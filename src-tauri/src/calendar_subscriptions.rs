use crate::{AppState, CmdResult};
use chrono::{DateTime, SecondsFormat, Utc};
use mosaic_core::Error;
use mosaic_core::planner::{OverlayOccurrence, ical_warnings, overlay_occurrences, validate_ical};
use mosaic_core::settings::Settings;
use reqwest::header::{
    ACCEPT, CONTENT_TYPE, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, USER_AGENT,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
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
    validator_resource_hash: Option<String>,
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
    let normalized = if value
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("webcal://"))
    {
        let rest = &value[9..];
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
    Ok(published_feed_url(parsed))
}

// Outlook's published HTML view has a sibling ICS resource. Resolve it before requesting
// the view: some Outlook servers return 417 for automated requests to the HTML endpoint.
fn published_feed_url(mut url: reqwest::Url) -> reqwest::Url {
    let host = url.host_str().unwrap_or_default();
    if [
        "outlook.office365.com",
        "outlook.office.com",
        "outlook.live.com",
    ]
    .contains(&host)
        && url.path().to_ascii_lowercase().ends_with(".html")
    {
        let path = format!("{}.ics", &url.path()[..url.path().len() - 5]);
        url.set_path(&path);
    }
    url
}

fn html_feed_url(content: &str, page: &reqwest::Url) -> CmdResult<reqwest::Url> {
    let html = scraper::Html::parse_document(content);
    let base_selector = scraper::Selector::parse("base[href]").unwrap();
    let base = html
        .select(&base_selector)
        .next()
        .and_then(|node| node.value().attr("href"))
        .and_then(|href| page.join(href).ok())
        .filter(|url| url.scheme() == "https")
        .unwrap_or_else(|| page.clone());
    let selector = scraper::Selector::parse("link[href], a[href]").unwrap();
    let mut candidates = Vec::new();
    for node in html.select(&selector) {
        let href = node.value().attr("href").unwrap_or_default();
        let calendar_type = node.value().attr("type").is_some_and(|kind| {
            [
                "text/calendar",
                "application/ics",
                "application/ical",
                "text/x-vcalendar",
            ]
            .contains(
                &kind
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
            )
        });
        let webcal = href
            .get(..9)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("webcal://"));
        let url = if webcal {
            normalized_url(href).ok()
        } else {
            base.join(href).ok()
        };
        if let Some(url) = url.map(published_feed_url)
            && url.scheme() == "https"
            && (webcal || calendar_type || url.path().to_ascii_lowercase().ends_with(".ics"))
            && !candidates.contains(&url)
        {
            candidates.push(url);
        }
    }
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        0 => Err(Error::Invalid("This link opens a web page with no iCalendar feed. Copy the calendar provider's ICS or webcal subscription link.".into())),
        _ => Err(Error::Invalid("This page contains several calendars. Copy the ICS or webcal link for the calendar you want.".into())),
    }
}

fn decode_feed(bytes: &[u8], content_type: &str) -> CmdResult<String> {
    let charset = content_type
        .split(';')
        .skip(1)
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| key.eq_ignore_ascii_case("charset"))
        .map(|(_, value)| value.trim().trim_matches('"'));
    let (encoding, offset) = encoding_rs::Encoding::for_bom(bytes)
        .or_else(|| {
            charset
                .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
                .map(|encoding| (encoding, 0))
        })
        .unwrap_or((encoding_rs::UTF_8, 0));
    let (text, errors) = encoding.decode_without_bom_handling(&bytes[offset..]);
    if errors {
        return Err(Error::Invalid(
            "calendar feed contains invalid text for its character encoding".into(),
        ));
    }
    Ok(text.into_owned())
}

fn url_hash(url: &reqwest::Url) -> String {
    Sha256::digest(url.as_str().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

struct DownloadedFeed {
    content: String,
    etag: Option<String>,
    last_modified: Option<String>,
    url_hash: String,
}

async fn download_feed(
    client: &reqwest::Client,
    mut url: reqwest::Url,
    subscription: &Subscription,
) -> CmdResult<Option<DownloadedFeed>> {
    let mut visited = HashSet::new();
    for _ in 0..4 {
        if !visited.insert(url.clone()) {
            return Err(Error::Invalid("calendar page links form a loop".into()));
        }
        let hash = url_hash(&url);
        let mut compatible = false;
        let response = loop {
            let mut request = client.get(url.clone()).header(
                ACCEPT,
                "text/calendar, application/ics, text/html;q=0.8, */*;q=0.5",
            );
            if subscription.validator_resource_hash.as_deref() == Some(&hash) {
                if let Some(etag) = &subscription.etag {
                    request = request.header(IF_NONE_MATCH, etag);
                }
                if let Some(modified) = &subscription.last_modified {
                    request = request.header(IF_MODIFIED_SINCE, modified);
                }
            }
            if compatible {
                request = request.header(USER_AGENT, "Mozilla/5.0 (compatible; Mosaic Calendar)");
            }
            let response = request
                .send()
                .await
                .map_err(|_| Error::Invalid("calendar feed could not be reached".into()))?;
            if response.status() == reqwest::StatusCode::EXPECTATION_FAILED && !compatible {
                compatible = true;
                continue;
            }
            break response;
        };
        if response.status() == reqwest::StatusCode::NOT_MODIFIED
            && subscription.validator_resource_hash.as_deref() == Some(&hash)
        {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(Error::Invalid(format!(
                "calendar feed returned HTTP {}. Use the provider's ICS or webcal subscription link; the calendar must allow downloads without signing in.",
                response.status().as_u16()
            )));
        }
        let final_url = response.url().clone();
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        };
        let etag = header(ETAG);
        let last_modified = header(LAST_MODIFIED);
        let content_type = header(CONTENT_TYPE).unwrap_or_default();
        let mut bytes = Vec::new();
        crate::http::read_capped(response, MAX_FEED_BYTES as u64, |chunk, _| {
            bytes.extend_from_slice(chunk);
            Ok(())
        })
        .await
        .map_err(|error| {
            Error::Invalid(if error.contains("larger") {
                "calendar feed is larger than 10 MB".into()
            } else {
                "calendar feed download was interrupted".into()
            })
        })?;
        let content = decode_feed(&bytes, &content_type)?;
        if content
            .trim_start()
            .get(..15)
            .is_some_and(|start| start.eq_ignore_ascii_case("BEGIN:VCALENDAR"))
        {
            return Ok(Some(DownloadedFeed {
                content,
                etag,
                last_modified,
                url_hash: url_hash(&final_url),
            }));
        }
        url = html_feed_url(&content, &final_url)?;
    }
    Err(Error::Invalid(
        "too many calendar page links; use a direct ICS subscription link".into(),
    ))
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
    let cached = fs::read_to_string(cache_path(app, subscription)?).ok();
    let mut request_metadata = subscription.clone();
    if !cached
        .as_deref()
        .is_some_and(|content| validate_ical(content, "UTC").is_ok())
    {
        request_metadata.validator_resource_hash = None;
    }
    let Some(feed) = download_feed(&client, parsed, &request_metadata).await? else {
        subscription.last_success = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        let warnings = cached
            .as_deref()
            .map(|content| ical_warnings(content, "UTC"))
            .transpose()?
            .unwrap_or_default();
        subscription.last_error = (!warnings.is_empty())
            .then(|| format!("Calendar imported with warnings: {}", warnings.join(" ")));
        return Ok(());
    };
    validate_ical(&feed.content, "UTC")?;
    let warnings = ical_warnings(&feed.content, "UTC")?;
    let path = cache_path(app, subscription)?;
    let temporary = path.with_extension("ics.tmp");
    fs::write(&temporary, feed.content.as_bytes())
        .map_err(|error| io_error(temporary.display().to_string(), error))?;
    fs::rename(&temporary, &path).map_err(|error| io_error(path.display().to_string(), error))?;
    subscription.etag = feed.etag;
    subscription.last_modified = feed.last_modified;
    subscription.validator_resource_hash = Some(feed.url_hash);
    subscription.last_success = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    subscription.last_error = (!warnings.is_empty())
        .then(|| format!("Calendar imported with warnings: {}", warnings.join(" ")));
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
        validator_resource_hash: None,
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
    let mut store = load(&app)?;
    let subscription = store
        .vaults
        .get_mut(&key)
        .and_then(|items| items.iter_mut().find(|item| item.id == id))
        .ok_or_else(|| Error::NotFound(format!("calendar subscription/{id}")))?;
    // An omitted URL preserves the Keychain entry. Never send stored feed credentials to the UI.
    let replacement = url
        .filter(|url| !url.trim().is_empty())
        .map(|url| normalized_url(&url))
        .transpose()?;
    let previous_cache = cache_path(&app, subscription)?;
    let previous_url = if let Some(url) = &replacement {
        let previous = get_secret(&id)?;
        set_secret(&id, url.as_str())?;
        Some(previous)
    } else {
        None
    };
    if replacement.is_some() {
        invalidate_feed(subscription);
    }
    subscription.name = name.trim().to_string();
    subscription.color = color;
    subscription.visible = visible;
    subscription.refresh_minutes = refresh_minutes;
    let result = subscription.clone();
    if let Err(error) = save(&app, &store) {
        if let Some(previous) = previous_url {
            set_secret(&id, &previous)?;
        }
        return Err(error);
    }
    if replacement.is_some() {
        let _ = fs::remove_file(previous_cache);
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
    subscription.validator_resource_hash = None;
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
            cache_file: "good.ics".into(),
            validator_resource_hash: None,
        };
        let mut items = vec![
            base.clone(),
            Subscription {
                id: "bad".into(),
                name: "Broken calendar".into(),
                cache_file: "bad.ics".into(),
                last_error: None,
                ..base.clone()
            },
            Subscription {
                id: "corrupt".into(),
                name: "Corrupt calendar".into(),
                cache_file: "corrupt.ics".into(),
                last_error: None,
                ..base
            },
        ];
        let good = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:good\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T100000Z\r\nSUMMARY:Working event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        fs::write(directory.path().join("good.ics"), good).unwrap();
        let bad = good.replace("DTSTART:20261103T090000Z", "DTSTART:not-a-date");
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
        assert!(items[1].last_error.as_deref().unwrap().contains("date"));
        assert!(items[2].last_error.is_some());
        assert!(validate_ical(&bad, "UTC").is_err());
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
            cache_file: "id.ics".into(),
            validator_resource_hash: None,
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

#[cfg(test)]
mod download_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn subscription() -> Subscription {
        Subscription {
            id: "test".into(),
            name: "Test".into(),
            color: "#6477d4".into(),
            visible: true,
            refresh_minutes: 30,
            etag: None,
            last_modified: None,
            last_success: None,
            last_error: None,
            cache_file: "test.ics".into(),
            validator_resource_hash: None,
        }
    }

    /// Opt-in provider check. Keep private URLs and event contents out of fixtures and logs.
    #[test]
    #[ignore = "requires MOSAIC_TEST_CALENDAR_URL and network access"]
    fn live_calendar_subscription_download() {
        let input = std::env::var("MOSAIC_TEST_CALENDAR_URL")
            .expect("set MOSAIC_TEST_CALENDAR_URL to the subscription or calendar page URL");
        let original = reqwest::Url::parse(&input).expect("valid calendar URL");
        let normalized = normalized_url(&input).expect("supported calendar URL");
        let client = crate::http::client(Duration::from_secs(15)).unwrap();
        tauri::async_runtime::block_on(async {
            if original != normalized {
                match client.get(original).send().await {
                    Ok(response) => {
                        eprintln!("Original calendar page HTTP {}", response.status().as_u16())
                    }
                    Err(_) => eprintln!("Original calendar page could not be reached"),
                }
            }
            let feed = download_feed(&client, normalized, &subscription())
                .await
                .expect("calendar download succeeds")
                .expect("initial request downloads a calendar");
            let count = validate_ical(&feed.content, "Europe/Zurich")
                .expect("downloaded calendar can be parsed");
            let warnings = ical_warnings(&feed.content, "Europe/Zurich").unwrap();
            let mut store = mosaic_core::planner::PlannerStore::in_memory().unwrap();
            let preview = store
                .preview_ical_import("live-check", &feed.content, "Europe/Zurich")
                .expect("downloaded calendar can be previewed");
            let today = Utc::now().date_naive();
            let through = today + chrono::Duration::days(31);
            let occurrences = overlay_occurrences(
                &feed.content,
                "live-check",
                "Live check",
                None,
                &today.to_string(),
                &through.to_string(),
                "Europe/Zurich",
            )
            .expect("downloaded calendar can be expanded");
            let selected = preview
                .candidates
                .iter()
                .map(|event| event.key.clone())
                .collect::<Vec<_>>();
            let imported = store
                .import_ical(&preview, &selected, false)
                .expect("all readable events can be imported into a temporary calendar");
            assert_eq!(imported.imported_event_ids.len(), preview.candidates.len());
            let local = store
                .calendar_range(&today.to_string(), &through.to_string())
                .expect("imported events can be expanded");
            assert_eq!(
                local.events.len(),
                occurrences.len(),
                "import preserves the overlay's occurrences"
            );
            let exported = store
                .export_ical()
                .expect("imported calendar can be exported");
            let roundtrip = overlay_occurrences(
                &exported,
                "roundtrip",
                "Round trip",
                None,
                &today.to_string(),
                &through.to_string(),
                "Europe/Zurich",
            )
            .expect("exported calendar can be read again");
            assert_eq!(
                roundtrip.len(),
                local.events.len(),
                "export preserves the imported occurrences"
            );
            eprintln!(
                "Calendar download: {} bytes, {count} parsed events, {} imported events, {} warnings, {} occurrences in the next month; import/export verified",
                feed.content.len(),
                imported.imported_event_ids.len(),
                warnings.len(),
                occurrences.len()
            );
        });
    }

    fn serve(responses: Vec<String>) -> (reqwest::Url, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://{}/calendar.ics",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 1024];
                while !bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let read = stream.read(&mut chunk).unwrap();
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (url, thread)
    }

    #[test]
    fn published_outlook_html_links_resolve_without_requesting_the_html_page() {
        for host in [
            "outlook.office365.com",
            "outlook.office.com",
            "outlook.live.com",
        ] {
            let url = normalized_url(&format!(
                "https://{host}/owa/calendar/secret/calendar.html?x=1"
            ))
            .unwrap();
            assert_eq!(url.path(), "/owa/calendar/secret/calendar.ics");
            assert_eq!(url.query(), Some("x=1"));
        }
        assert_eq!(
            normalized_url("WEBCAL://example.test/feed.ics")
                .unwrap()
                .scheme(),
            "https"
        );
        assert_eq!(
            normalized_url("https://example.test/calendar.html")
                .unwrap()
                .path(),
            "/calendar.html"
        );
    }

    #[test]
    fn calendar_pages_resolve_declared_relative_and_webcal_links() {
        let page = reqwest::Url::parse("https://example.test/calendars/view.html").unwrap();
        for (html, expected) in [
            (
                r#"<link rel="alternate" type="text/calendar" href="../download?token=a&amp;b=2">"#,
                "https://example.test/download?token=a&b=2",
            ),
            (
                r#"<base href="/shared/"><a href="team.ics">Subscribe</a>"#,
                "https://example.test/shared/team.ics",
            ),
            (
                r#"<a href="webcal://example.test/private.ics">Subscribe</a>"#,
                "https://example.test/private.ics",
            ),
            (
                r#"<a href="webcal://example.test/opaque-token">Subscribe</a>"#,
                "https://example.test/opaque-token",
            ),
            (
                r#"<link type="application/ics" href="/download?id=1">"#,
                "https://example.test/download?id=1",
            ),
            (
                r#"<a href="team.ics">A</a><link type="text/calendar" href="team.ics">"#,
                "https://example.test/calendars/team.ics",
            ),
        ] {
            assert_eq!(html_feed_url(html, &page).unwrap().as_str(), expected);
        }
        assert!(
            html_feed_url("<html>Sign in to view this calendar</html>", &page)
                .unwrap_err()
                .to_string()
                .contains("ICS or webcal")
        );
        assert!(
            html_feed_url(
                r#"<a href="one.ics">One</a><a href="two.ics">Two</a>"#,
                &page
            )
            .unwrap_err()
            .to_string()
            .contains("several")
        );
        assert!(html_feed_url(r#"<a href="http://example.test/team.ics">HTTP</a><a href="file:///private/feed.ics">Local</a>"#, &page).is_err());
    }

    #[test]
    fn feed_decoding_handles_declared_encodings_and_utf16_boms() {
        assert_eq!(
            decode_feed(b"SUMMARY:Caf\xe9", "text/calendar; charset=iso-8859-1").unwrap(),
            "SUMMARY:Café"
        );
        let utf16 = [
            vec![0xff, 0xfe],
            "BEGIN:VCALENDAR"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect(),
        ]
        .concat();
        assert_eq!(
            decode_feed(&utf16, "text/calendar").unwrap(),
            "BEGIN:VCALENDAR"
        );
        assert!(decode_feed(&[0xff, 0x80], "text/calendar; charset=utf-8").is_err());
    }

    #[test]
    fn http_417_retries_once_with_compatible_headers_and_downloads_ics() {
        let content = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
        let (url, server) = serve(vec![
            "HTTP/1.1 417 Expectation Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into(),
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/calendar\r\nETag: test-tag\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}",
                content.len()
            ),
        ]);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .user_agent("Mosaic")
            .build()
            .unwrap();
        let feed =
            tauri::async_runtime::block_on(download_feed(&client, url.clone(), &subscription()))
                .unwrap()
                .unwrap();
        assert_eq!(feed.content, content);
        assert_eq!(feed.etag.as_deref(), Some("test-tag"));
        assert_eq!(feed.url_hash, url_hash(&url));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("text/calendar"));
        assert!(requests[1].contains("Mozilla/5.0"));
        assert!(
            requests
                .iter()
                .all(|request| !request.to_ascii_lowercase().contains("\r\nexpect:"))
        );
    }

    #[test]
    fn conditional_requests_only_send_validators_to_the_cached_resource() {
        let (url, server) = serve(vec![
            "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into(),
        ]);
        let mut item = subscription();
        item.etag = Some("cached-tag".into());
        item.last_modified = Some("Wed, 04 Nov 2026 10:00:00 GMT".into());
        item.validator_resource_hash = Some(url_hash(&url));
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        assert!(
            tauri::async_runtime::block_on(download_feed(&client, url, &item))
                .unwrap()
                .is_none()
        );
        let requests = server.join().unwrap();
        assert!(requests[0].contains("if-none-match: cached-tag"));
        assert!(requests[0].contains("if-modified-since:"));

        let body = "BEGIN:VCALENDAR\nEND:VCALENDAR\n";
        let (url, server) = serve(vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )]);
        assert!(
            tauri::async_runtime::block_on(download_feed(&client, url, &item))
                .unwrap()
                .is_some()
        );
        assert!(!server.join().unwrap()[0].contains("if-none-match"));
    }

    #[test]
    fn failed_and_oversized_responses_return_errors_without_echoing_private_urls() {
        for response in [
            "HTTP/1.1 417 Expectation Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_FEED_BYTES + 1
            ),
        ] {
            let responses = if response.contains("417") {
                vec![response.clone(), response]
            } else {
                vec![response]
            };
            let (mut url, server) = serve(responses);
            url.set_query(Some("secret=private-token"));
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            let error =
                tauri::async_runtime::block_on(download_feed(&client, url, &subscription()))
                    .err()
                    .unwrap()
                    .to_string();
            assert!(!error.contains("private-token"));
            assert!(error.contains("417") || error.contains("10 MB"));
            server.join().unwrap();
        }
    }
}
