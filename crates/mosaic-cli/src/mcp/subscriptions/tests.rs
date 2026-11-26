//! The subscription tools in process, with core's in-memory secret store and scripted downloads in
//! place of the Keychain and the network.

use super::super::{MosaicMcp, VaultMode};
use super::*;
use mosaic_core::Workspace;
use mosaic_core::calendar_subscriptions::DownloadedFeed;
use mosaic_core::calendar_subscriptions::testing::{MemorySecrets, ScriptedFetcher};
use mosaic_core::history::Source;
use serde_json::Value;

const FEED: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:standup\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T093000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
const TOKEN: &str = "private-token-4d2f";
const URL: &str = "webcal://calendar.example/team.ics?token=private-token-4d2f";
const OTHER_URL: &str = "https://calendar.example/other.ics?token=private-token-4d2f";

type Service = CalendarSubscriptions<MemorySecrets, ScriptedFetcher>;

struct Fixture {
    _dir: tempfile::TempDir,
    service: Arc<Service>,
    mcp: MosaicMcp,
    /// Every tool result (success or error), to check that no URL ever comes back.
    outputs: Vec<String>,
}

impl Fixture {
    fn new(may_change: Option<&[&str]>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(vault.join("Daily")).unwrap();
        let may_change: Option<Vec<String>> =
            may_change.map(|entries| entries.iter().map(|e| e.to_string()).collect());
        let mut ws = Workspace::open(&vault).unwrap().with_source(Source::Agent);
        if let Some(only) = &may_change {
            ws = ws.with_change_allowlist(only.clone());
        }
        let service = Arc::new(
            CalendarSubscriptions::new(
                dir.path().join("cache"),
                MemorySecrets::default(),
                ScriptedFetcher::default(),
            )
            .with_settings_dir(dir.path().join("settings")),
        );
        let mut mcp = MosaicMcp::new(Some(ws), VaultMode::Pinned, Some(vault), may_change);
        mcp.feeds = Some(service.clone());
        Self {
            _dir: dir,
            service,
            mcp,
            outputs: Vec::new(),
        }
    }

    fn respond(&self, content: &str) {
        self.service.fetcher().respond(Ok(Some(DownloadedFeed {
            content: content.into(),
            etag: Some("v1".into()),
            last_modified: None,
            url_hash: "resource".into(),
        })));
    }

    /// Records a tool's result and returns whether it failed, with its JSON.
    fn record(&mut self, result: ToolResult) -> (bool, Value) {
        let (failed, text) = match result {
            Ok(text) => (false, text),
            Err(text) => (true, text),
        };
        self.outputs.push(text.clone());
        (failed, serde_json::from_str(&text).unwrap())
    }

    async fn list(&mut self) -> (bool, Value) {
        let result = self.mcp.list_calendar_subscriptions().await;
        self.record(result)
    }

    async fn add(&mut self, url: &str) -> (bool, Value) {
        let result = self
            .mcp
            .add_calendar_subscription(Parameters(AddSubscriptionArgs {
                name: "Team".into(),
                url: url.into(),
                color: None,
                refresh_minutes: None,
            }))
            .await;
        self.record(result)
    }

    async fn update(&mut self, args: Value) -> (bool, Value) {
        let args = serde_json::from_value(args).unwrap();
        let result = self
            .mcp
            .update_calendar_subscription(Parameters(args))
            .await;
        self.record(result)
    }

    async fn remove(&mut self, id: &str) -> (bool, Value) {
        let result = self
            .mcp
            .remove_calendar_subscription(Parameters(SubscriptionIdArg { id: id.into() }))
            .await;
        self.record(result)
    }

    async fn refresh(&mut self, force: bool) -> (bool, Value) {
        let result = self
            .mcp
            .refresh_calendar_subscriptions(Parameters(RefreshArgs { force }))
            .await;
        self.record(result)
    }

    async fn overlay(&mut self, from: &str, to: &str) -> (bool, Value) {
        let result = self
            .mcp
            .get_calendar_overlay(Parameters(OverlayArgs {
                from: from.into(),
                to: to.into(),
                timezone: Some("Europe/Paris".into()),
            }))
            .await;
        self.record(result)
    }

    /// No tool result so far holds a feed URL, its host or its token.
    fn assert_no_url_in_outputs(&self) {
        assert!(!self.outputs.is_empty());
        for output in &self.outputs {
            for secret in [TOKEN, "calendar.example", "webcal:", "https:"] {
                assert!(!output.contains(secret), "{secret} leaked in {output}");
            }
        }
    }
}

#[tokio::test]
async fn every_tool_works_and_no_output_holds_a_feed_url() {
    let mut f = Fixture::new(None);
    let (failed, listed) = f.list().await;
    assert!(!failed, "{listed}");
    assert_eq!(listed, serde_json::json!([]));

    f.respond(FEED);
    let (failed, added) = f.add(URL).await;
    assert!(!failed, "{added}");
    assert_eq!(added["name"], "Team");
    assert_eq!(added["color"], DEFAULT_COLOR);
    assert_eq!(added["refresh_minutes"], DEFAULT_REFRESH_MINUTES);
    assert_eq!(added["has_cache"], true);
    let id = added["id"].as_str().unwrap().to_string();
    // The URL was used: stored as a secret and downloaded (webcal becomes HTTPS).
    let calls = f.service.fetcher().take_calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].0.contains(TOKEN));
    assert!(
        f.service
            .secrets()
            .all()
            .values()
            .any(|v| v.contains(TOKEN))
    );

    let (failed, listed) = f.list().await;
    assert!(!failed);
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(
        listed[0].as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "color",
            "has_cache",
            "id",
            "last_error",
            "last_success",
            "name",
            "refresh_minutes",
            "source_color",
            "visible"
        ],
        "only safe metadata"
    );

    // The overlay holds the cached event inside the range and nothing outside it.
    let (failed, overlay) = f.overlay("2026-11-01", "2026-11-30").await;
    assert!(!failed, "{overlay}");
    let occurrences = overlay["occurrences"].as_array().unwrap();
    assert_eq!(occurrences.len(), 1);
    assert_eq!(occurrences[0]["title"], "Standup");
    assert_eq!(occurrences[0]["source_id"], id.as_str());
    assert_eq!(overlay["subscriptions"][0]["id"], id.as_str());
    let (_, outside) = f.overlay("2026-12-01", "2026-12-31").await;
    assert_eq!(outside["occurrences"], serde_json::json!([]));

    // Not due yet: nothing is downloaded (the scripted fetcher would panic). Forced: downloaded.
    let (failed, refreshed) = f.refresh(false).await;
    assert!(!failed, "{refreshed}");
    assert!(f.service.fetcher().take_calls().is_empty());
    f.service.fetcher().respond(Ok(None));
    let (failed, refreshed) = f.refresh(true).await;
    assert!(!failed, "{refreshed}");
    assert_eq!(f.service.fetcher().take_calls().len(), 1);
    assert_eq!(refreshed[0]["last_error"], Value::Null);

    // A partial update changes only what it names; a hidden subscription adds no events.
    let (failed, updated) = f
        .update(serde_json::json!({ "id": id, "visible": false, "color": "#ff0000" }))
        .await;
    assert!(!failed, "{updated}");
    assert_eq!(updated["name"], "Team");
    assert_eq!(updated["color"], "#ff0000");
    assert_eq!(updated["visible"], false);
    let (_, hidden) = f.overlay("2026-11-01", "2026-11-30").await;
    assert_eq!(hidden["occurrences"], serde_json::json!([]));

    // A new URL replaces the secret and drops the cache; a forced refresh that fails is reported.
    let (failed, moved) = f
        .update(serde_json::json!({ "id": id, "url": OTHER_URL, "visible": true }))
        .await;
    assert!(!failed, "{moved}");
    assert_eq!(moved["has_cache"], false);
    let secrets = f.service.secrets().all();
    assert_eq!(secrets.len(), 1);
    assert!(
        secrets
            .values()
            .all(|v| v.ends_with("other.ics?token=private-token-4d2f"))
    );
    f.service.fetcher().respond(Err(Error::Invalid(
        "calendar feed could not be reached".into(),
    )));
    let (failed, refreshed) = f.refresh(true).await;
    assert!(!failed, "{refreshed}");
    assert_eq!(
        refreshed[0]["last_error"],
        "calendar feed could not be reached"
    );

    // Errors don't quote the URL either.
    let (failed, refused) = f
        .add("http://calendar.example/team.ics?token=private-token-4d2f")
        .await;
    assert!(failed, "{refused}");
    assert_eq!(refused["code"], "invalid");
    let (failed, invalid) = f
        .update(serde_json::json!({ "id": id, "url": "nonsense private-token-4d2f" }))
        .await;
    assert!(failed, "{invalid}");
    let (failed, missing) = f.remove("missing").await;
    assert!(failed, "{missing}");
    assert_eq!(missing["code"], "not_found");

    let (failed, remaining) = f.remove(&id).await;
    assert!(!failed, "{remaining}");
    assert_eq!(remaining, serde_json::json!([]));
    assert!(f.service.secrets().all().is_empty());

    f.assert_no_url_in_outputs();
}

#[tokio::test]
async fn writes_are_refused_without_the_subscriptions_scope() {
    let mut f = Fixture::new(Some(&["Daily"]));
    let denied = |(failed, refusal): (bool, Value)| {
        assert!(failed, "{refusal}");
        assert_eq!(refusal["code"], "denied");
        let message = refusal["message"].as_str().unwrap();
        assert!(message.contains("`subscriptions:`"), "{message}");
        assert!(message.contains("Don't retry"), "{message}");
    };
    denied(f.add(URL).await);
    denied(
        f.update(serde_json::json!({ "id": "x", "name": "New" }))
            .await,
    );
    denied(f.remove("x").await);
    denied(f.refresh(true).await);
    // Nothing reached the Keychain or the network.
    assert!(f.service.secrets().all().is_empty());
    assert!(f.service.fetcher().take_calls().is_empty());
    // Reads still work.
    let (failed, listed) = f.list().await;
    assert!(!failed, "{listed}");
    let (failed, overlay) = f.overlay("2026-11-01", "2026-11-30").await;
    assert!(!failed, "{overlay}");
    f.assert_no_url_in_outputs();

    // Naming the scope lets the same agent change subscriptions.
    let mut f = Fixture::new(Some(&["Daily", "subscriptions:"]));
    f.respond(FEED);
    let (failed, added) = f.add(URL).await;
    assert!(!failed, "{added}");
    let id = added["id"].as_str().unwrap().to_string();
    f.service.fetcher().respond(Ok(None));
    assert!(!f.refresh(true).await.0);
    assert!(
        !f.update(serde_json::json!({ "id": id, "name": "New" }))
            .await
            .0
    );
    assert!(!f.remove(&id).await.0);
    f.assert_no_url_in_outputs();
}
