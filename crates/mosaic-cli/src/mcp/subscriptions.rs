//! Calendar subscription tools: read-only ICS feeds the person subscribed to in the app, overlaid on
//! the calendar. Thin wrappers over `mosaic_core::calendar_subscriptions`, bound to the open vault
//! with `for_workspace`, so core refuses every change under `--may-change` without
//! `subscriptions:`.
//!
//! The server shares the app's subscriptions: metadata in the same settings file, feeds cached in
//! the same folder (`app_cache_dir`) and URLs in the same Keychain items. A feed URL can carry a
//! private token, so no tool ever returns one: the views have no URL field and core's error
//! messages never quote it.

use super::{MosaicMcp, ToolResult, err, ok};
use mosaic_core::api::Context;
use mosaic_core::calendar_subscriptions::{
    CalendarSubscriptions, FeedFetcher, HttpFetcher, Keychain, OverlayRange, SecretStore,
    SubscriptionPatch, SubscriptionView, app_cache_dir, local_timezone,
};
use mosaic_core::{Error, Result};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// The app's colour for a new subscription (the Calendar sources dialog's default).
const DEFAULT_COLOR: &str = "#6477d4";
/// The app's default refresh interval, in minutes.
const DEFAULT_REFRESH_MINUTES: u32 = 30;

type Pending<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// `CalendarSubscriptions` behind a trait object, so tests can swap the Keychain and the network
/// for core's test doubles. Every method goes through `for_workspace`, where core guards writes.
pub(super) trait Feeds: Send + Sync {
    fn list(&self, ctx: &Context) -> Result<Vec<SubscriptionView>>;
    fn add<'a>(
        &'a self,
        ctx: &'a Context,
        name: &'a str,
        url: &'a str,
        color: String,
        refresh_minutes: u32,
    ) -> Pending<'a, SubscriptionView>;
    fn update(&self, ctx: &Context, id: &str, patch: SubscriptionPatch)
    -> Result<SubscriptionView>;
    fn remove(&self, ctx: &Context, id: &str) -> Result<()>;
    fn refresh<'a>(&'a self, ctx: &'a Context, force: bool) -> Pending<'a, Vec<SubscriptionView>>;
    fn overlay(&self, ctx: &Context, from: &str, to: &str, timezone: &str) -> Result<OverlayRange>;
}

impl<S, F> Feeds for CalendarSubscriptions<S, F>
where
    S: SecretStore + Send + 'static,
    F: FeedFetcher + Send + 'static,
{
    fn list(&self, ctx: &Context) -> Result<Vec<SubscriptionView>> {
        self.for_workspace(ctx).list()
    }

    fn add<'a>(
        &'a self,
        ctx: &'a Context,
        name: &'a str,
        url: &'a str,
        color: String,
        refresh_minutes: u32,
    ) -> Pending<'a, SubscriptionView> {
        Box::pin(async move {
            self.for_workspace(ctx)
                .add(name, url, color, refresh_minutes)
                .await
        })
    }

    fn update(
        &self,
        ctx: &Context,
        id: &str,
        patch: SubscriptionPatch,
    ) -> Result<SubscriptionView> {
        self.for_workspace(ctx).update(id, patch)
    }

    fn remove(&self, ctx: &Context, id: &str) -> Result<()> {
        self.for_workspace(ctx).remove(id)
    }

    fn refresh<'a>(&'a self, ctx: &'a Context, force: bool) -> Pending<'a, Vec<SubscriptionView>> {
        Box::pin(async move { self.for_workspace(ctx).refresh(force).await })
    }

    fn overlay(&self, ctx: &Context, from: &str, to: &str, timezone: &str) -> Result<OverlayRange> {
        self.for_workspace(ctx).overlay_range(from, to, timezone)
    }
}

/// The app's subscriptions: its feed cache, the macOS Keychain and HTTPS downloads. `None` when
/// there is no app data folder (no `HOME`).
pub(super) fn app_feeds() -> Option<Arc<dyn Feeds>> {
    let cache = app_cache_dir()?;
    Some(Arc::new(CalendarSubscriptions::new(
        cache,
        Keychain,
        HttpFetcher::default(),
    )))
}

#[derive(Deserialize, JsonSchema)]
struct AddSubscriptionArgs {
    /// Name shown in the calendar, e.g. `Team`.
    name: String,
    /// The feed's HTTPS or `webcal://` address (an ICS subscription link). Kept in the macOS
    /// Keychain; no tool returns it again.
    url: String,
    /// Colour of its events, as `#rrggbb`. Default `#6477d4`.
    #[serde(default)]
    color: Option<String>,
    /// How often the app downloads it, in minutes (at least 5). Default 30.
    #[serde(default)]
    refresh_minutes: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct UpdateSubscriptionArgs {
    /// The subscription's `id` from `list_calendar_subscriptions`.
    id: String,
    /// New name. Omit to keep it.
    #[serde(default)]
    name: Option<String>,
    /// New colour, as `#rrggbb`. Omit to keep it.
    #[serde(default)]
    color: Option<String>,
    /// Show (`true`) or hide (`false`) its events in the calendar. Omit to keep it.
    #[serde(default)]
    visible: Option<bool>,
    /// New refresh interval in minutes (at least 5). Omit to keep it.
    #[serde(default)]
    refresh_minutes: Option<u32>,
    /// A new HTTPS or `webcal://` address for the feed, replacing the old one; its cached events
    /// are dropped until the next refresh. Omit to keep the feed.
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct SubscriptionIdArg {
    /// The subscription's `id` from `list_calendar_subscriptions`.
    id: String,
}

#[derive(Deserialize, JsonSchema)]
struct RefreshArgs {
    /// Download every feed now, hidden ones included. By default only the visible feeds whose
    /// refresh interval has passed are downloaded, as the app does on its own.
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize, JsonSchema)]
struct OverlayArgs {
    /// First day, `YYYY-MM-DD`.
    from: String,
    /// Last day, `YYYY-MM-DD` (inclusive).
    to: String,
    /// IANA timezone the days and times are in, e.g. `Europe/Paris`. Default: this computer's.
    #[serde(default)]
    timezone: Option<String>,
}

impl MosaicMcp {
    fn feeds(&self) -> std::result::Result<&dyn Feeds, String> {
        self.feeds.as_deref().ok_or_else(|| {
            err(Error::Invalid(
                "calendar subscriptions need the Mosaic app's data folder, and HOME is not set"
                    .into(),
            ))
        })
    }
}

#[tool_router(router = subscription_router, vis = "pub(super)")]
impl MosaicMcp {
    #[tool(
        description = "List the vault's calendar subscriptions: read-only ICS feeds the person subscribed to, shown over the calendar. Each has id, name, color, visible, refresh_minutes, last_success, last_error and has_cache (a download is cached). Feed URLs are never shown: they can carry private tokens and stay in the Keychain."
    )]
    async fn list_calendar_subscriptions(&self) -> ToolResult {
        let feeds = self.feeds()?;
        feeds.list(&self.ws()).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Subscribe to a calendar feed (an HTTPS or webcal ICS link) and download it once; a failed download is kept as last_error and the subscription is still added. Returns the subscription, without its URL: the URL goes into the macOS Keychain and no tool returns it again. Use it only when the person gave you the link and asked for it. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `subscriptions:`. macOS only (needs the Keychain)."
    )]
    async fn add_calendar_subscription(
        &self,
        Parameters(a): Parameters<AddSubscriptionArgs>,
    ) -> ToolResult {
        let feeds = self.feeds()?;
        let ws = self.ws();
        feeds
            .add(
                &ws,
                &a.name,
                &a.url,
                a.color.unwrap_or_else(|| DEFAULT_COLOR.into()),
                a.refresh_minutes.unwrap_or(DEFAULT_REFRESH_MINUTES),
            )
            .await
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Change a calendar subscription: its name, color, whether its events show (visible), its refresh interval, or its feed URL. Only the fields you give change. A new URL replaces the feed in the Keychain and drops the cached events until the next refresh; it is never returned. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `subscriptions:`. A new URL needs macOS (the Keychain)."
    )]
    async fn update_calendar_subscription(
        &self,
        Parameters(a): Parameters<UpdateSubscriptionArgs>,
    ) -> ToolResult {
        let patch = SubscriptionPatch {
            name: a.name,
            color: a.color,
            visible: a.visible,
            refresh_minutes: a.refresh_minutes,
            url: a.url,
        };
        let feeds = self.feeds()?;
        feeds
            .update(&self.ws(), &a.id, patch)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Unsubscribe from a calendar feed: forgets its URL (Keychain) and its cached events. Returns the remaining subscriptions. Not undoable: subscribing again needs the URL. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `subscriptions:`."
    )]
    async fn remove_calendar_subscription(
        &self,
        Parameters(a): Parameters<SubscriptionIdArg>,
    ) -> ToolResult {
        let feeds = self.feeds()?;
        let ws = self.ws();
        feeds.remove(&ws, &a.id).map_err(err)?;
        feeds.list(&ws).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Download the calendar feeds that are due (visible, refresh interval passed), or all of them with force. A failed download is kept as that subscription's last_error; the others still refresh. Returns the subscriptions. The app also refreshes on its own while it is open. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `subscriptions:`. macOS only (needs the Keychain)."
    )]
    async fn refresh_calendar_subscriptions(
        &self,
        Parameters(a): Parameters<RefreshArgs>,
    ) -> ToolResult {
        let feeds = self.feeds()?;
        let ws = self.ws();
        feeds.refresh(&ws, a.force).await.map_err(err).and_then(ok)
    }

    #[tool(
        description = "The subscribed calendars' events from `from` to `to` (inclusive), from the cached downloads (never downloads; use refresh_calendar_subscriptions first if they're stale). Returns subscriptions and occurrences (source_id, source_name, title, description, location, meeting_url, all_day, start_value, end_value, timezone, color). Only visible subscriptions contribute events. These are read-only: Board tasks and calendar events of the planner are separate."
    )]
    async fn get_calendar_overlay(&self, Parameters(a): Parameters<OverlayArgs>) -> ToolResult {
        let feeds = self.feeds()?;
        let timezone = a.timezone.unwrap_or_else(local_timezone);
        feeds
            .overlay(&self.ws(), &a.from, &a.to, &timezone)
            .map_err(err)
            .and_then(ok)
    }
}

#[cfg(test)]
mod tests;
