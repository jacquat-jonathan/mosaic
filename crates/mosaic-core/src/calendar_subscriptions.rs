//! Calendar subscriptions: read-only ICS feeds overlaid on the calendar.
//!
//! Metadata lives in `settings.json` under [`SETTINGS_KEY`], keyed by vault identity. A feed's URL
//! can carry a private token, so it is never stored there: it is kept by a [`SecretStore`] (the
//! macOS Keychain in the app). The last good download of each feed is cached as one `.ics` file in
//! a cache directory chosen by the caller. Downloads go through a [`FeedFetcher`], so the network
//! can be replaced in tests.

use crate::planner::{OverlayOccurrence, ical_warnings, overlay_occurrences, validate_ical};
use crate::settings::Settings;
use crate::{Error, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::header::{
    ACCEPT, CONTENT_TYPE, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, USER_AGENT,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub use reqwest::Url;

/// The `settings.json` key holding subscription metadata.
pub const SETTINGS_KEY: &str = "calendar_subscriptions";
const MAX_FEED_BYTES: usize = 10 * 1024 * 1024;

fn io_error(path: impl Into<String>, source: std::io::Error) -> Error {
    Error::Io {
        path: path.into(),
        source,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    #[serde(default)]
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SubscriptionStore {
    // Retained unchanged as rollback data for pre-identity versions. New writers use vault_ids.
    vaults: HashMap<String, Vec<Subscription>>,
    #[serde(default)]
    vault_ids: HashMap<String, Vec<Subscription>>,
    // A legacy path is consumed once; a different vault at the same path must not inherit it.
    #[serde(default)]
    migrated_paths: HashMap<String, String>,
}

// A subscription as the app and agents see it: no URL, no download validators. (A plain comment:
// doc comments would change the generated UI bindings.)
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SubscriptionView {
    pub id: String,
    pub name: String,
    pub color: String,
    pub visible: bool,
    pub refresh_minutes: u32,
    pub last_success: Option<String>,
    pub last_error: Option<String>,
    pub has_cache: bool,
}

// The subscriptions and their cached events in a date range.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct OverlayRange {
    pub subscriptions: Vec<SubscriptionView>,
    pub occurrences: Vec<OverlayOccurrence>,
}

/// Where feed URLs are kept, by credential id. Feed URLs often embed a private token.
pub trait SecretStore: Sync {
    fn set(&self, id: &str, value: &str) -> Result<()>;
    fn get(&self, id: &str) -> Result<String>;
    /// Best effort: a missing secret is not an error.
    fn delete(&self, id: &str);
}

/// The macOS Keychain. Elsewhere every read and write fails: subscriptions need the Keychain.
#[derive(Debug, Default, Clone, Copy)]
pub struct Keychain;

impl SecretStore for Keychain {
    fn set(&self, id: &str, value: &str) -> Result<()> {
        keychain::set(id, value)
    }

    fn get(&self, id: &str) -> Result<String> {
        keychain::get(id)
    }

    fn delete(&self, id: &str) {
        keychain::delete(id)
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use crate::{Error, Result};
    use std::process::Command;

    const SERVICE: &str = "com.mosaic.calendar-subscription";

    pub(super) fn set(id: &str, value: &str) -> Result<()> {
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

    pub(super) fn get(id: &str) -> Result<String> {
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

    pub(super) fn delete(id: &str) {
        let _ = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", id])
            .status();
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use crate::{Error, Result};

    pub(super) fn set(_id: &str, _value: &str) -> Result<()> {
        Err(Error::Invalid(
            "calendar subscriptions currently require macOS Keychain".into(),
        ))
    }

    pub(super) fn get(_id: &str) -> Result<String> {
        Err(Error::Invalid(
            "calendar subscriptions currently require macOS Keychain".into(),
        ))
    }

    pub(super) fn delete(_id: &str) {}
}

/// Conditional-request validators from the last download. They are only sent to the resource
/// whose URL hash is `resource_hash`, so a moved feed is never answered with "not modified".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Validators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub resource_hash: Option<String>,
}

/// A downloaded iCalendar feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadedFeed {
    pub content: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    /// Hash of the URL that served `content`, after redirects and calendar-page links.
    pub url_hash: String,
}

/// Downloads a feed. `Ok(None)` means the cached copy is still current (HTTP 304).
pub trait FeedFetcher: Sync {
    fn fetch(
        &self,
        url: Url,
        validators: &Validators,
    ) -> impl Future<Output = Result<Option<DownloadedFeed>>> + Send;
}

/// Fetches feeds over HTTPS with [`crate::http::client`].
#[derive(Debug, Clone, Default)]
pub struct HttpFetcher {
    client: Option<reqwest::Client>,
}

impl HttpFetcher {
    /// Uses `client` instead of building the HTTPS-only one per download (tests).
    pub fn with_client(client: reqwest::Client) -> Self {
        Self {
            client: Some(client),
        }
    }
}

impl FeedFetcher for HttpFetcher {
    async fn fetch(&self, url: Url, validators: &Validators) -> Result<Option<DownloadedFeed>> {
        let client = match &self.client {
            Some(client) => client.clone(),
            None => crate::http::client(Duration::from_secs(15))
                .map_err(|_| Error::Invalid("could not initialize calendar download".into()))?,
        };
        download_feed(&client, url, validators).await
    }
}

/// Calendar subscriptions for one install: where feeds are cached, where URLs are kept, and how
/// feeds are fetched. Every method takes the vault the subscriptions belong to.
pub struct CalendarSubscriptions<S, F> {
    cache_dir: PathBuf,
    settings_dir: Option<PathBuf>,
    secrets: S,
    fetcher: F,
}

impl<S: SecretStore, F: FeedFetcher> CalendarSubscriptions<S, F> {
    /// `cache_dir` holds the downloaded feeds and is created on use. Metadata goes to the
    /// settings file in [`crate::settings::app_support_dir`].
    pub fn new(cache_dir: PathBuf, secrets: S, fetcher: F) -> Self {
        Self {
            cache_dir,
            settings_dir: None,
            secrets,
            fetcher,
        }
    }

    /// Keeps metadata in the settings file in `dir` instead (tests and isolated callers).
    pub fn with_settings_dir(mut self, dir: PathBuf) -> Self {
        self.settings_dir = Some(dir);
        self
    }

    /// The vault's subscriptions.
    pub fn list(&self, vault_root: &Path) -> Result<Vec<SubscriptionView>> {
        let key = self.vault_key(vault_root)?;
        self.load()?
            .vault_ids
            .get(&key)
            .into_iter()
            .flatten()
            .map(|subscription| self.view(subscription))
            .collect()
    }

    /// Subscribes to a feed and downloads it once. A failed download is kept as `last_error`;
    /// the subscription is still added. `vault_root` is resolved after the arguments are checked.
    pub async fn add(
        &self,
        vault_root: impl FnOnce() -> Result<PathBuf>,
        name: &str,
        url: &str,
        color: String,
        refresh_minutes: u32,
    ) -> Result<SubscriptionView> {
        let name = name.trim();
        if name.is_empty() || refresh_minutes < 5 {
            return Err(Error::Invalid(
                "subscription name is required and refresh must be at least five minutes".into(),
            ));
        }
        let parsed = normalized_url(url)?;
        let key = self.vault_key(&vault_root()?)?;
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
        self.secrets.set(&id, parsed.as_str())?;
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
            revision: 0,
            secret_id: None,
        };
        let refresh = self.refresh_one(&mut subscription, true).await;
        if let Err(error) = refresh {
            subscription.last_error = Some(error.to_string());
        }
        if let Err(error) = self.mutate(|store| {
            store
                .vault_ids
                .entry(key)
                .or_default()
                .push(subscription.clone());
            Ok(())
        }) {
            self.secrets.delete(&id);
            if let Ok(path) = self.cache_path(&subscription) {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        self.view(&subscription)
    }

    /// Changes a subscription's settings; a non-empty `url` replaces the feed and drops its cache.
    /// `vault_root` is resolved after the settings are checked.
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        vault_root: impl FnOnce() -> Result<PathBuf>,
        id: &str,
        name: &str,
        color: String,
        visible: bool,
        refresh_minutes: u32,
        url: Option<String>,
    ) -> Result<SubscriptionView> {
        if name.trim().is_empty() || refresh_minutes < 5 {
            return Err(Error::Invalid(
                "invalid calendar subscription settings".into(),
            ));
        }
        let key = self.vault_key(&vault_root()?)?;
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
            self.secrets.set(&key, url.as_str())?;
            Some(key)
        } else {
            None
        };
        let mut previous_secret = None;
        let mut previous_cache = None;
        let result = self.mutate(|store| {
            let subscription = store
                .vault_ids
                .get_mut(&key)
                .and_then(|items| items.iter_mut().find(|item| item.id == id))
                .ok_or_else(|| Error::NotFound(format!("calendar subscription/{id}")))?;
            if let Some(key) = &replacement_key {
                previous_secret = Some(
                    subscription
                        .secret_id
                        .clone()
                        .unwrap_or_else(|| id.to_string()),
                );
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
                    self.secrets.delete(&key);
                }
                return Err(error);
            }
        };
        if let Some(key) = previous_secret {
            self.secrets.delete(&key);
        }
        if let Some(file) = previous_cache {
            let _ = fs::remove_file(self.cache_directory()?.join(file));
        }
        self.view(&result)
    }

    /// Unsubscribes, forgetting the feed URL and the cached download.
    pub fn remove(&self, vault_root: &Path, id: &str) -> Result<()> {
        let key = self.vault_key(vault_root)?;
        let subscription = self.mutate(|store| {
            let items = store.vault_ids.entry(key).or_default();
            let index = items
                .iter()
                .position(|item| item.id == id)
                .ok_or_else(|| Error::NotFound(format!("calendar subscription/{id}")))?;
            Ok(items.remove(index))
        })?;
        self.secrets
            .delete(subscription.secret_id.as_deref().unwrap_or(id));
        let path = self.cache_path(&subscription)?;
        if path.is_file() {
            fs::remove_file(&path).map_err(|error| io_error(path.display().to_string(), error))?;
        }
        Ok(())
    }

    /// Downloads the visible feeds that are due, or every feed when `force` is set. A failed
    /// download is kept as that subscription's `last_error`; the others still refresh.
    pub async fn refresh(&self, vault_root: &Path, force: bool) -> Result<Vec<SubscriptionView>> {
        let key = self.vault_key(vault_root)?;
        let store = self.load()?;
        for before in store.vault_ids.get(&key).into_iter().flatten() {
            if (!before.visible && !force) || (!force && !due(before)) {
                continue;
            }
            let mut fetched = before.clone();
            if let Err(error) = self.refresh_one(&mut fetched, force).await {
                fetched.last_error = Some(error.to_string());
            }
            let committed = self.mutate(|store| Ok(merge_refresh(store, &key, before, &fetched)));
            let accepted = committed.as_ref().is_ok_and(|accepted| *accepted);
            if fetched.cache_file != before.cache_file {
                let obsolete = if accepted { before } else { &fetched };
                let _ = fs::remove_file(self.cache_path(obsolete)?);
            }
            committed?;
        }
        self.load()?
            .vault_ids
            .get(&key)
            .into_iter()
            .flatten()
            .map(|s| self.view(s))
            .collect()
    }

    /// The subscriptions and the cached events of the visible ones from `from` to `to`
    /// (`YYYY-MM-DD`, inclusive) in `timezone`. Never downloads. A cache that can't be read is
    /// reported as that subscription's `last_error` in the result.
    pub fn overlay_range(
        &self,
        vault_root: &Path,
        from: &str,
        to: &str,
        timezone: &str,
    ) -> Result<OverlayRange> {
        let key = self.vault_key(vault_root)?;
        let store = self.load()?;
        let mut items = store.vault_ids.get(&key).cloned().unwrap_or_default();
        let occurrences = cached_overlays(&mut items, &self.cache_directory()?, from, to, timezone);
        Ok(OverlayRange {
            subscriptions: items
                .iter()
                .map(|subscription| self.view(subscription))
                .collect::<Result<Vec<_>>>()?,
            occurrences,
        })
    }

    fn cache_directory(&self) -> Result<PathBuf> {
        fs::create_dir_all(&self.cache_dir)
            .map_err(|error| io_error(self.cache_dir.display().to_string(), error))?;
        Ok(self.cache_dir.clone())
    }

    fn cache_path(&self, subscription: &Subscription) -> Result<PathBuf> {
        Ok(self.cache_directory()?.join(&subscription.cache_file))
    }

    fn view(&self, subscription: &Subscription) -> Result<SubscriptionView> {
        Ok(SubscriptionView {
            id: subscription.id.clone(),
            name: subscription.name.clone(),
            color: subscription.color.clone(),
            visible: subscription.visible,
            refresh_minutes: subscription.refresh_minutes,
            last_success: subscription.last_success.clone(),
            last_error: subscription.last_error.clone(),
            has_cache: self.cache_path(subscription)?.is_file(),
        })
    }

    fn load(&self) -> Result<SubscriptionStore> {
        let settings = match &self.settings_dir {
            None => Settings::try_load(),
            Some(dir) => Settings::try_load_in(dir),
        };
        decode(&settings.map_err(|e| io_error("settings.json", e))?)
    }

    fn mutate<T>(&self, change: impl FnOnce(&mut SubscriptionStore) -> Result<T>) -> Result<T> {
        // Settings::try_update holds the cross-process lock through decoding, mutation and
        // persistence.
        let change = |settings: &mut Settings| mutate_settings(settings, change);
        match &self.settings_dir {
            None => Settings::try_update(change),
            Some(dir) => Settings::try_update_in(dir, change),
        }
        .map_err(|e| io_error("settings.json", e))?
    }

    fn vault_key(&self, root: &Path) -> Result<String> {
        let identity = crate::vault_id::identify(root)?;
        let previous = crate::vault_id::migration_roots(root)?;
        self.mutate(|store| migrate_identity(store, &identity.id, root, &previous))?;
        Ok(identity.id)
    }

    async fn refresh_one(&self, subscription: &mut Subscription, force: bool) -> Result<()> {
        if !force && !due(subscription) {
            return Ok(());
        }
        let url = self.secrets.get(
            subscription
                .secret_id
                .as_deref()
                .unwrap_or(&subscription.id),
        )?;
        let parsed = normalized_url(&url)?;
        let cached = fs::read_to_string(self.cache_path(subscription)?).ok();
        let mut validators = Validators {
            etag: subscription.etag.clone(),
            last_modified: subscription.last_modified.clone(),
            resource_hash: subscription.validator_resource_hash.clone(),
        };
        if !cached
            .as_deref()
            .is_some_and(|content| validate_ical(content, "UTC").is_ok())
        {
            validators.resource_hash = None;
        }
        let Some(feed) = self.fetcher.fetch(parsed, &validators).await? else {
            subscription.last_success =
                Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
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
        let directory = self.cache_directory()?;
        let mut temporary = tempfile::Builder::new()
            .prefix("feed-")
            .suffix(".ics")
            .tempfile_in(&directory)
            .map_err(|e| io_error(directory.display().to_string(), e))?;
        std::io::Write::write_all(&mut temporary, feed.content.as_bytes())
            .map_err(|e| io_error("calendar cache", e))?;
        let (_, path) = temporary
            .keep()
            .map_err(|e| io_error("calendar cache", e.error))?;
        subscription.cache_file = path.file_name().unwrap().to_string_lossy().into_owned();
        subscription.etag = feed.etag;
        subscription.last_modified = feed.last_modified;
        subscription.validator_resource_hash = Some(feed.url_hash);
        subscription.last_success = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        subscription.last_error = (!warnings.is_empty())
            .then(|| format!("Calendar imported with warnings: {}", warnings.join(" ")));
        Ok(())
    }
}

fn decode(settings: &Settings) -> Result<SubscriptionStore> {
    match settings.other.get(SETTINGS_KEY) {
        None => Ok(SubscriptionStore::default()),
        Some(value) => serde_json::from_value(value.clone()).map_err(|error| {
            Error::Invalid(format!(
                "calendar subscription metadata is invalid: {error}"
            ))
        }),
    }
}

fn mutate_settings<T>(
    settings: &mut Settings,
    change: impl FnOnce(&mut SubscriptionStore) -> Result<T>,
) -> std::io::Result<(Result<T>, bool)> {
    // Domain failures retain their wire error codes and do not persist partially mutated state.
    let result = (|| {
        let mut store = decode(settings)?;
        let result = change(&mut store)?;
        let value = serde_json::to_value(store).map_err(|e| Error::Invalid(e.to_string()))?;
        Ok((result, value))
    })();
    match result {
        Ok((result, value)) => {
            let changed = settings.other.get(SETTINGS_KEY) != Some(&value);
            settings.other.insert(SETTINGS_KEY.into(), value);
            Ok((Ok(result), changed))
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
        .vault_ids
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
    current.validator_resource_hash = fetched.validator_resource_hash.clone();
    current.last_success = fetched.last_success.clone();
    current.last_error = fetched.last_error.clone();
    current.cache_file = fetched.cache_file.clone();
    current.revision += 1;
    true
}

/// Atomically claim legacy records, preserving their exact metadata and credential references.
/// Conflicting candidates are never merged or exposed in an error message.
fn migrate_identity(
    store: &mut SubscriptionStore,
    id: &str,
    root: &Path,
    previous: &[PathBuf],
) -> Result<()> {
    if store.vault_ids.contains_key(id) {
        return Ok(());
    }
    let paths: Vec<String> = std::iter::once(root)
        .chain(previous.iter().map(PathBuf::as_path))
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !store.migrated_paths.contains_key(path))
        .collect();
    let mut selected: Option<Vec<Subscription>> = None;
    for path in &paths {
        if let Some(items) = store.vaults.get(path) {
            if selected.as_ref().is_some_and(|selected| selected != items) {
                return Err(Error::Invalid(
                    "calendar subscription migration has conflicting legacy records; metadata was preserved, resolve the legacy records before retrying".into(),
                ));
            }
            selected = Some(items.clone());
        }
    }
    for path in paths {
        if store.vaults.contains_key(&path) {
            store.migrated_paths.insert(path, id.to_owned());
        }
    }
    // An empty entry is intentional: deleting the last subscription must not re-import old data.
    store
        .vault_ids
        .insert(id.to_owned(), selected.unwrap_or_default());
    Ok(())
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

// Accepts HTTPS and webcal URLs (webcal becomes HTTPS); refuses everything else.
fn normalized_url(value: &str) -> Result<Url> {
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
    let parsed = Url::parse(&normalized)
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
fn published_feed_url(mut url: Url) -> Url {
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

fn html_feed_url(content: &str, page: &Url) -> Result<Url> {
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

fn decode_feed(bytes: &[u8], content_type: &str) -> Result<String> {
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

fn url_hash(url: &Url) -> String {
    Sha256::digest(url.as_str().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// Downloads a feed with `client`, following calendar web pages to the one feed they link to.
async fn download_feed(
    client: &reqwest::Client,
    mut url: Url,
    validators: &Validators,
) -> Result<Option<DownloadedFeed>> {
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
            if validators.resource_hash.as_deref() == Some(&hash) {
                if let Some(etag) = &validators.etag {
                    request = request.header(IF_NONE_MATCH, etag);
                }
                if let Some(modified) = &validators.last_modified {
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
            && validators.resource_hash.as_deref() == Some(&hash)
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
mod tests;
