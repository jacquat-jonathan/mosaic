//! Calendar subscription commands: thin wrappers over `mosaic_core::calendar_subscriptions`,
//! with feeds cached in the app data directory and URLs kept in the macOS Keychain. `mosaic mcp`
//! uses the same cache (`calendar_subscriptions::app_cache_dir`: the bundle identifier's folder
//! in Application Support is this app data directory) and the same Keychain items.

use crate::{AppState, CmdResult};
use mosaic_core::Error;
use mosaic_core::calendar_subscriptions::{
    CACHE_DIR, CalendarSubscriptions, HttpFetcher, Keychain, OverlayRange, SubscriptionView,
};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

fn subscriptions(app: &AppHandle) -> CmdResult<CalendarSubscriptions<Keychain, HttpFetcher>> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| Error::Invalid(format!("calendar data directory unavailable: {error}")))?;
    Ok(CalendarSubscriptions::new(
        directory.join(CACHE_DIR),
        Keychain,
        HttpFetcher::default(),
    ))
}

fn vault_root(state: &State<AppState>) -> CmdResult<PathBuf> {
    Ok(state.get()?.vault.root().to_path_buf())
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn calendar_subscriptions(
    app: AppHandle,
    state: State<AppState>,
) -> CmdResult<Vec<SubscriptionView>> {
    subscriptions(&app)?.list(&vault_root(&state)?)
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
    subscriptions(&app)?
        .add(|| vault_root(&state), &name, &url, color, refresh_minutes)
        .await
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
    subscriptions(&app)?.update(
        || vault_root(&state),
        &id,
        &name,
        color,
        visible,
        refresh_minutes,
        url,
    )
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn remove_calendar_subscription(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> CmdResult<()> {
    subscriptions(&app)?.remove(&vault_root(&state)?, &id)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn refresh_calendar_subscriptions(
    app: AppHandle,
    state: State<'_, AppState>,
    force: bool,
) -> CmdResult<Vec<SubscriptionView>> {
    let root = vault_root(&state)?;
    subscriptions(&app)?.refresh(&root, force).await
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
    subscriptions(&app)?.overlay_range(&vault_root(&state)?, &from, &to, &timezone)
}
