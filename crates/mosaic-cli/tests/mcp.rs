//! Drives `mosaic mcp` like an MCP client (Claude Code / Claude Desktop) would: JSON-RPC over stdio.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// Methods of the notifications the server sent, in order.
    notifications: Vec<String>,
}

impl Client {
    fn start(vault: &std::path::Path) -> Self {
        Self::start_with(
            Some(vault),
            &vault.join(".test-settings"),
            &vault.join(".test-cache"),
        )
    }

    /// `vault: None` starts the server without `--vault`, so it follows the app's vault in `settings`.
    fn start_with(
        vault: Option<&std::path::Path>,
        settings: &std::path::Path,
        cache: &std::path::Path,
    ) -> Self {
        Self::start_restricted(vault, settings, cache, &[])
    }

    /// `start_with`, restricted like a scheduled agent: one `--may-change` per entry.
    fn start_restricted(
        vault: Option<&std::path::Path>,
        settings: &std::path::Path,
        cache: &std::path::Path,
        may_change: &[&str],
    ) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_mosaic"));
        if let Some(v) = vault {
            cmd.args(["--vault", v.to_str().unwrap()]);
        }
        for entry in may_change {
            cmd.args(["--may-change", entry]);
        }
        let mut child = cmd
            .arg("mcp")
            .env_remove("MOSAIC_VAULT")
            // Keep the test's index out of ~/Library/Caches.
            .env("MOSAIC_CACHE_DIR", cache)
            // …and its bookmarks out of the real settings.json.
            .env("MOSAIC_SETTINGS_DIR", settings)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start mosaic mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut c = Client {
            child,
            stdin,
            stdout,
            next_id: 1,
            notifications: vec![],
        };
        let init = c.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0" }
            }),
        );
        assert_eq!(init["result"]["serverInfo"]["name"], "mosaic");
        assert!(
            init["result"]["instructions"]
                .as_str()
                .unwrap()
                .contains("vault_guide")
        );
        c.notify("notifications/initialized", json!({}));
        c
    }

    fn send(&mut self, msg: Value) {
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let mut line = String::new();
            assert!(
                self.stdout.read_line(&mut line).unwrap() > 0,
                "server closed stdout"
            );
            // Clients drop the connection on anything but JSON-RPC on stdout.
            let msg: Value = serde_json::from_str(&line).expect("json line");
            assert_eq!(msg["jsonrpc"], "2.0", "not JSON-RPC on stdout: {line}");
            if msg["id"] == json!(id) {
                return msg;
            }
            if let Some(method) = msg["method"].as_str() {
                self.notifications.push(method.to_string());
            }
        }
    }

    /// Calls a tool; returns (is_error, parsed text payload).
    fn call(&mut self, tool: &str, args: Value) -> (bool, Value) {
        let res = self.request("tools/call", json!({ "name": tool, "arguments": args }));
        let result = &res["result"];
        let text = result["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let payload = serde_json::from_str(&text).unwrap_or(Value::String(text));
        (result["isError"].as_bool().unwrap_or(false), payload)
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vault");
    let status = Command::new("cp")
        .arg("-R")
        .arg(format!("{}/.", src.display()))
        .arg(dir.path())
        .status()
        .unwrap();
    assert!(status.success());
    dir
}

#[test]
fn templates_are_shared_with_agents_and_keep_review_and_hidden_access() {
    let dir = fixture();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::create_dir_all(root.join("Templates")).unwrap();
    std::fs::write(
        root.join("Templates/Analysis.md"),
        "# {{title}}\n\n## Evidence\n\n## Recommendation\n",
    )
    .unwrap();
    std::fs::write(root.join("Templates/Secret.md"), "secret").unwrap();
    let settings = root.join(".test-settings");
    std::fs::create_dir_all(&settings).unwrap();
    let config = json!({"templates":{root.to_str().unwrap():{"version":1,"folder":"Templates","rules":[{"folder":"Reports","template":"Templates/Analysis.md"}]}},"agent_rules":{root.to_str().unwrap():[{"path":"Reports","access":"review"},{"path":"Templates/Secret.md","access":"hidden"}]}});
    std::fs::write(settings.join("settings.json"), config.to_string()).unwrap();
    let mut c = Client::start(&root);
    let (err, list) = c.call("list_templates", json!({"path":"Reports/Investigation.md"}));
    assert!(!err, "{list}");
    assert_eq!(list["templates"].as_array().unwrap().len(), 1);
    assert_eq!(list["default"]["template"], "Templates/Analysis.md");
    let (err, p) = c.call(
        "render_template",
        json!({"path":"Reports/Investigation.md","timestamp":"2026-10-08T10:00:00+02:00"}),
    );
    assert!(!err, "{p}");
    assert!(
        p["content"]
            .as_str()
            .unwrap()
            .starts_with("# Investigation\n")
    );
    let (err,n)=c.call("create_note",json!({"path":"Reports/Investigation.md","timestamp":p["context"]["timestamp"],"expected_template_hash":p["template_hash"]}));
    assert!(!err, "{n}");
    assert!(n["review"].as_i64().is_some());
    assert!(!root.join("Reports/Investigation.md").exists());
    let (err, note) = c.call("read_file", json!({"path":"Reports/Investigation.md"}));
    assert!(!err);
    assert_eq!(note["content"], p["content"]);
    let (err, _) = c.call(
        "render_template",
        json!({"path":"Reports/Other.md","template":"Templates/Secret.md"}),
    );
    assert!(err);
    std::fs::write(root.join("Templates/Analysis.md"), "changed source").unwrap();
    let (err, stale) = c.call(
        "create_note",
        json!({"path":"Reports/Stale.md","expected_template_hash":p["template_hash"]}),
    );
    assert!(err);
    assert_eq!(stale["code"], "conflict");
    let (err,report)=c.call("create_file",json!({"path":"Reports/Complete.md","content":"# Investigation\n\n## Evidence\nObserved behavior.\n\n## Recommendation\nProceed.\n"}));
    assert!(!err, "{report}");
    let (err, saved) = c.call("read_file", json!({"path":"Reports/Complete.md"}));
    assert!(!err);
    assert!(
        saved["content"]
            .as_str()
            .unwrap()
            .contains("Observed behavior.")
    );
}

#[test]
fn every_tool_works_end_to_end() {
    let dir = fixture();
    let mut c = Client::start(dir.path());

    let tools = c.request("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for expected in [
        "vault_guide",
        "get_vault_preferences",
        "list_files",
        "read_file",
        "outline",
        "search",
        "create_file",
        "edit_file",
        "patch_file",
        "append_to_file",
        "rename",
        "copy_file",
        "delete_file",
        "create_folder",
        "get_backlinks",
        "list_tags",
        "list_bookmarks",
        "add_bookmark",
        "remove_bookmark",
        "list_planner_epics",
        "list_planner_tasks",
        "get_planner_task",
        "planner_task_history",
        "create_planner_task",
        "update_planner_task",
        "move_planner_task",
        "complete_planner_task",
        "reopen_planner_task",
        "archive_planner_task",
        "restore_planner_task",
        "trash_planner_task",
    ] {
        assert!(
            names.contains(&expected),
            "missing tool {expected}: {names:?}"
        );
    }

    let (_, guide) = c.call("vault_guide", json!({}));
    assert!(guide.as_str().unwrap().contains("JSON Canvas"));
    let (_, preferences) = c.call("get_vault_preferences", json!({}));
    assert_eq!(preferences["agents_folder"], "Agents");

    let (_, files) = c.call("list_files", json!({ "recursive": true }));
    assert!(
        files
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == "Home.md")
    );
    assert!(
        files
            .as_array()
            .unwrap()
            .iter()
            .all(|f| !f["path"].as_str().unwrap().starts_with(".obsidian"))
    );

    let (_, hits) = c.call("search", json!({ "query": "graph view" }));
    assert_eq!(hits[0]["path"], "Ideas.md");

    let (err, _) = c.call(
        "create_file",
        json!({ "path": "AI/Summary.md", "content": "# Summary\n\nBased on [[Ideas]]. #ai\n" }),
    );
    assert!(!err);
    let (_, file) = c.call("read_file", json!({ "path": "AI/Summary.md" }));
    let hash = file["hash"].as_str().unwrap().to_string();

    let (err, _) = c.call("patch_file", json!({ "path": "AI/Summary.md", "find": "Based on", "replace": "Built from", "expected_hash": hash }));
    assert!(!err);
    // The old hash is now stale: a second edit with it must be refused, not overwrite.
    let (err, payload) = c.call(
        "edit_file",
        json!({ "path": "AI/Summary.md", "content": "clobber", "expected_hash": hash }),
    );
    assert!(err);
    assert_eq!(payload["code"], "conflict");

    let (_, _) = c.call(
        "append_to_file",
        json!({ "path": "AI/Summary.md", "content": "- appended line" }),
    );
    let (_, file) = c.call("read_file", json!({ "path": "AI/Summary.md" }));
    assert_eq!(
        file["content"],
        "# Summary\n\nBuilt from [[Ideas]]. #ai\n- appended line"
    );

    let (_, backlinks) = c.call("get_backlinks", json!({ "path": "Ideas.md" }));
    assert!(
        backlinks
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["source"] == "AI/Summary.md")
    );

    let (_, outline) = c.call("outline", json!({ "path": "Home.md" }));
    assert_eq!(outline["title"], "Home");

    let (_, tags) = c.call("list_tags", json!({}));
    assert!(tags.as_array().unwrap().iter().any(|t| t["tag"] == "ai"));

    let canvas = json!({ "nodes": [{ "id": "a", "type": "file", "file": "AI/Summary.md", "x": 0, "y": 0, "width": 300, "height": 200 }], "edges": [] });
    let (err, _) = c.call(
        "create_file",
        json!({ "path": "AI/Board.canvas", "content": canvas.to_string() }),
    );
    assert!(!err);

    // Malformed structured files are refused with a reason, and nothing is written.
    let broken = json!({ "nodes": [{ "id": "b", "type": "text", "x": 0, "y": 0, "width": 1, "height": 1 }] });
    let (err, payload) = c.call(
        "create_file",
        json!({ "path": "AI/Broken.canvas", "content": broken.to_string() }),
    );
    assert!(err);
    assert_eq!(payload["code"], "invalid");
    assert!(
        payload["message"]
            .as_str()
            .unwrap()
            .contains("has no string \"text\""),
        "{payload}"
    );
    assert!(!dir.path().join("AI/Broken.canvas").exists());
    let (err, payload) = c.call(
        "patch_file",
        json!({ "path": "AI/Board.canvas", "find": "\"edges\":[]", "replace": "\"edges\":[" }),
    );
    assert!(err, "a patch that breaks the JSON is refused");
    assert!(
        payload["message"]
            .as_str()
            .unwrap()
            .contains("invalid JSON"),
        "{payload}"
    );

    let (err, marks) = c.call("add_bookmark", json!({ "path": "AI/Summary.md" }));
    assert!(!err);
    assert_eq!(marks, json!([{ "path": "AI/Summary.md", "exists": true }]));
    let (err, payload) = c.call("add_bookmark", json!({ "path": "Nope.md" }));
    assert!(err);
    assert_eq!(payload["code"], "not_found");

    let (_, renamed) = c.call(
        "rename",
        json!({ "from": "AI/Summary.md", "to": "AI/Overview.md" }),
    );
    assert_eq!(renamed["path"], "AI/Overview.md");
    let (_, marks) = c.call("list_bookmarks", json!({}));
    assert_eq!(
        marks,
        json!([{ "path": "AI/Overview.md", "exists": true }]),
        "bookmarks follow a rename"
    );
    let (err, marks) = c.call("remove_bookmark", json!({ "path": "AI/Overview.md" }));
    assert!(!err);
    assert_eq!(marks, json!([]));
    let (err, payload) = c.call("remove_bookmark", json!({ "path": "AI/Overview.md" }));
    assert!(err);
    assert_eq!(payload["code"], "invalid");
    let (_, board) = c.call("read_file", json!({ "path": "AI/Board.canvas" }));
    assert!(
        board["content"]
            .as_str()
            .unwrap()
            .contains("AI/Overview.md")
    );

    let (err, copied) = c.call(
        "copy_file",
        json!({ "from": "AI/Board.canvas", "to": "AI/Board copy.canvas" }),
    );
    assert!(!err);
    assert_eq!(copied["path"], "AI/Board copy.canvas");
    let (err, payload) = c.call(
        "copy_file",
        json!({ "from": "AI/Board.canvas", "to": "AI/Board copy.canvas" }),
    );
    assert!(err);
    assert_eq!(payload["code"], "already_exists");

    let (err, payload) = c.call("read_file", json!({ "path": "../outside.md" }));
    assert!(err);
    assert_eq!(payload["code"], "invalid_path");

    let (err, _) = c.call("create_folder", json!({ "path": "AI/Later" }));
    assert!(!err);
    assert!(dir.path().join("AI/Later").is_dir());
}

#[test]
fn agents_can_read_edit_and_inspect_planner_task_history() {
    let dir = fixture();
    let mut c = Client::start(dir.path());

    let (err, epics) = c.call(
        "list_planner_epics",
        json!({ "include_archived": false, "include_trashed": false }),
    );
    assert!(!err, "{epics}");
    assert_eq!(epics, json!([]));

    let (err, created) = c.call(
        "create_planner_task",
        json!({
            "title": "Agent-owned follow-up",
            "description": "Created through MCP",
            "status": "new",
            "due_date": "2026-10-30",
            "estimate_minutes": 25
        }),
    );
    assert!(!err, "{created}");
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["revision"], 1);

    let (err, listed) = c.call(
        "list_planner_tasks",
        json!({ "include_archived": false, "include_trashed": false }),
    );
    assert!(!err, "{listed}");
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["id"] == id)
    );

    let (err, updated) = c.call(
        "update_planner_task",
        json!({
            "id": id,
            "expected_revision": created["revision"],
            "title": "Reviewed follow-up",
            "clear_due_date": true,
            "estimate_minutes": 30
        }),
    );
    assert!(!err, "{updated}");
    assert_eq!(updated["due_date"], Value::Null);
    assert_eq!(updated["revision"], 2);

    let (err, stale) = c.call(
        "update_planner_task",
        json!({ "id": id, "expected_revision": 1, "description": "stale" }),
    );
    assert!(err, "{stale}");
    assert_eq!(stale["code"], "conflict");

    let (err, moved) = c.call(
        "move_planner_task",
        json!({
            "id": id,
            "expected_revision": updated["revision"],
            "epic_id": null,
            "parent_id": null,
            "status": "in-progress"
        }),
    );
    assert!(!err, "{moved}");
    assert_eq!(moved["status"], "in-progress");

    let (err, completed) = c.call(
        "complete_planner_task",
        json!({
            "id": id,
            "expected_revision": moved["revision"],
            "future_sessions": "keep"
        }),
    );
    assert!(!err, "{completed}");
    assert_eq!(completed["status"], "done");

    let (err, history) = c.call("planner_task_history", json!({ "id": id }));
    assert!(!err, "{history}");
    let actions: Vec<&str> = history
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["action"].as_str().unwrap())
        .collect();
    assert_eq!(actions, ["created", "updated", "moved", "completed"]);
    assert!(history[1]["before"].is_object());
    assert!(history[1]["after"].is_object());

    let (err, reopened) = c.call(
        "reopen_planner_task",
        json!({ "id": id, "expected_revision": completed["revision"] }),
    );
    assert!(!err, "{reopened}");
    let (err, archived) = c.call(
        "archive_planner_task",
        json!({ "id": id, "expected_revision": reopened["revision"] }),
    );
    assert!(!err, "{archived}");
    let (err, trashed) = c.call(
        "trash_planner_task",
        json!({ "id": id, "expected_revision": archived["revision"] }),
    );
    assert!(!err, "{trashed}");
    let (err, restored) = c.call(
        "restore_planner_task",
        json!({ "id": id, "expected_revision": trashed["revision"] }),
    );
    assert!(!err, "{restored}");
    assert_eq!(restored["archived_at"], Value::Null);
    assert_eq!(restored["trashed_at"], Value::Null);

    let (err, read) = c.call("get_planner_task", json!({ "id": id }));
    assert!(!err, "{read}");
    assert_eq!(read["title"], "Reviewed follow-up");
    assert_eq!(read["revision"], restored["revision"]);
}

/// Points the "app" (settings.json) at `vault`, as opening it in Mosaic does.
fn open_in_app(settings: &std::path::Path, vault: &std::path::Path) {
    std::fs::create_dir_all(settings).unwrap();
    std::fs::write(
        settings.join("settings.json"),
        json!({ "last_vault": vault }).to_string(),
    )
    .unwrap();
}

#[test]
fn without_a_vault_it_follows_the_app() {
    let home = tempfile::tempdir().unwrap();
    let (a, b) = (home.path().join("A"), home.path().join("B"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(a.join("In A.md"), "# A").unwrap();
    let settings = home.path().join("settings");
    open_in_app(&settings, &a);
    let mut c = Client::start_with(None, &settings, &home.path().join("cache"));

    let (_, files) = c.call("list_files", json!({}));
    assert_eq!(files[0]["path"], "In A.md");

    // The human switches vaults in the app: the next call works on the new one.
    open_in_app(&settings, &b);
    let (err, _) = c.call("create_file", json!({ "path": "New.md", "content": "hi" }));
    assert!(!err);
    assert!(b.join("New.md").exists());
    assert!(!a.join("New.md").exists());
    let (_, guide) = c.call("vault_guide", json!({}));
    assert!(
        !guide.as_str().unwrap().starts_with("Note:"),
        "no warning when following"
    );
}

/// Following the app must not lose `--may-change`: after the person switches vaults, a write
/// outside the allowlist is still a proposal, and app-state writes are still refused.
#[test]
fn following_the_app_keeps_the_may_change_restriction() {
    let home = tempfile::tempdir().unwrap();
    let (a, b) = (home.path().join("A"), home.path().join("B"));
    for vault in [&a, &b] {
        std::fs::create_dir_all(vault.join("Allowed")).unwrap();
        std::fs::write(vault.join("Outside.md"), "original\n").unwrap();
    }
    let settings = home.path().join("settings");
    open_in_app(&settings, &a);
    let mut c = Client::start_restricted(None, &settings, &home.path().join("cache"), &["Allowed"]);
    let (err, before) = c.call(
        "edit_file",
        json!({ "path": "Outside.md", "content": "agent\n" }),
    );
    assert!(!err, "{before}");
    assert!(before["review"].is_number(), "{before}");

    // The person switches vaults in the app.
    open_in_app(&settings, &b);
    let (err, after) = c.call(
        "edit_file",
        json!({ "path": "Outside.md", "content": "agent\n" }),
    );
    assert!(!err, "{after}");
    assert!(
        after["review"].is_number(),
        "a write outside the allowlist must stay a proposal after the switch: {after}"
    );
    assert!(after["note"].as_str().unwrap().contains("Proposed"));
    assert_eq!(
        std::fs::read_to_string(b.join("Outside.md")).unwrap(),
        "original\n"
    );
    // Inside the allowlist, still direct, in the new vault.
    let (err, inside) = c.call(
        "create_file",
        json!({ "path": "Allowed/New.md", "content": "hi\n" }),
    );
    assert!(!err, "{inside}");
    assert!(inside["review"].is_null(), "{inside}");
    assert!(b.join("Allowed/New.md").exists());
    let (err, planner) = c.call("create_planner_task", json!({ "title": "Sneaky" }));
    assert!(err, "{planner}");
    assert_eq!(planner["code"], "denied");
}

/// A restricted server started before any vault is open applies `--may-change` to the vault it
/// opens lazily on the first call.
#[test]
fn the_lazy_first_open_keeps_the_may_change_restriction() {
    let home = tempfile::tempdir().unwrap();
    let vault = home.path().join("V");
    std::fs::create_dir_all(vault.join("Allowed")).unwrap();
    std::fs::write(vault.join("Outside.md"), "original\n").unwrap();
    let settings = home.path().join("settings");
    let mut c = Client::start_restricted(None, &settings, &home.path().join("cache"), &["Allowed"]);
    let (err, msg) = c.call("list_files", json!({}));
    assert!(err && msg["code"] == "no_vault", "{msg}");
    open_in_app(&settings, &vault);
    let (err, w) = c.call(
        "edit_file",
        json!({ "path": "Outside.md", "content": "agent\n" }),
    );
    assert!(!err, "{w}");
    assert!(w["review"].is_number(), "must be a proposal: {w}");
    assert_eq!(
        std::fs::read_to_string(vault.join("Outside.md")).unwrap(),
        "original\n"
    );
    let (err, refused) = c.call("create_planner_task", json!({ "title": "T" }));
    assert!(err && refused["code"] == "denied", "{refused}");
}

/// The subscription tools through the real binary: the app's settings and Keychain. Writes are
/// refused without `subscriptions:` before the Keychain or the network is touched (so this is safe
/// on a Mac); reads work; off macOS, adding says the Keychain is needed, as in the app. The tools
/// themselves are tested in process with a memory Keychain (`mcp/subscriptions/tests.rs`).
#[test]
fn calendar_subscription_tools_use_the_app_state() {
    let home = tempfile::tempdir().unwrap();
    let vault = home.path().join("V");
    std::fs::create_dir_all(vault.join("Daily")).unwrap();
    let settings = home.path().join("settings");
    let cache = home.path().join("cache");
    let url = "webcal://calendar.example/team.ics?token=private-token";

    let mut c = Client::start_restricted(Some(&vault), &settings, &cache, &["Daily"]);
    for (tool, args) in [
        (
            "add_calendar_subscription",
            json!({ "name": "Team", "url": url }),
        ),
        (
            "update_calendar_subscription",
            json!({ "id": "x", "url": url }),
        ),
        ("remove_calendar_subscription", json!({ "id": "x" })),
        ("refresh_calendar_subscriptions", json!({ "force": true })),
    ] {
        let (err, refused) = c.call(tool, args);
        assert!(err, "{tool}: {refused}");
        assert_eq!(refused["code"], "denied", "{tool}");
        let message = refused["message"].as_str().unwrap();
        assert!(message.contains("`subscriptions:`"), "{message}");
        assert!(!message.contains("private-token"), "{message}");
    }
    let (err, listed) = c.call("list_calendar_subscriptions", json!({}));
    assert!(!err, "{listed}");
    assert_eq!(listed, json!([]));
    let (err, overlay) = c.call(
        "get_calendar_overlay",
        json!({ "from": "2026-11-01", "to": "2026-11-30", "timezone": "UTC" }),
    );
    assert!(!err, "{overlay}");
    assert_eq!(overlay["occurrences"], json!([]));
    drop(c);

    #[cfg(not(target_os = "macos"))]
    {
        let mut c = Client::start_restricted(
            Some(&vault),
            &settings,
            &cache,
            &["Daily", "subscriptions:"],
        );
        let (err, refused) = c.call(
            "add_calendar_subscription",
            json!({ "name": "Team", "url": url }),
        );
        assert!(err, "{refused}");
        assert_eq!(
            refused["message"],
            "calendar subscriptions currently require macOS Keychain"
        );
        let (err, refreshed) = c.call("refresh_calendar_subscriptions", json!({}));
        assert!(!err, "{refreshed}");
        assert_eq!(refreshed, json!([]));
    }
}

/// Under `--may-change`, app-state writes (planner, bookmarks) are refused unless the allowlist
/// names their scope; reads and withdrawing the agent's own proposals still work.
#[test]
fn app_state_writes_need_their_scope_under_may_change() {
    let home = tempfile::tempdir().unwrap();
    let vault = home.path().join("V");
    std::fs::create_dir_all(vault.join("Daily")).unwrap();
    std::fs::write(vault.join("Note.md"), "note\n").unwrap();
    let settings = home.path().join("settings");
    let cache = home.path().join("cache");

    let mut c = Client::start_restricted(Some(&vault), &settings, &cache, &["Daily"]);
    let (err, refused) = c.call("create_planner_task", json!({ "title": "T" }));
    assert!(err, "{refused}");
    assert_eq!(refused["code"], "denied");
    let message = refused["message"].as_str().unwrap();
    assert!(message.contains("`planner:`"), "{message}");
    assert!(message.contains("Don't retry"), "{message}");
    assert!(message.contains("Tell the person"), "{message}");
    let (err, refused) = c.call("add_bookmark", json!({ "path": "Note.md" }));
    assert!(err, "{refused}");
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("`bookmarks:`"),
        "{refused}"
    );
    let (err, refused) = c.call("remove_bookmark", json!({ "path": "Note.md" }));
    assert!(err && refused["code"] == "denied", "{refused}");
    let (err, tasks) = c.call("list_planner_tasks", json!({}));
    assert!(!err, "{tasks}");
    assert_eq!(tasks, json!([]));
    // The agent's own proposal can still be taken back.
    let (_, proposed) = c.call(
        "edit_file",
        json!({ "path": "Note.md", "content": "changed\n" }),
    );
    let id = proposed["review"].as_i64().expect("a proposal");
    let (err, withdrawn) = c.call("withdraw_proposal", json!({ "id": id }));
    assert!(!err, "{withdrawn}");
    drop(c);

    // Naming the scopes lets the same agent change them.
    let mut c = Client::start_restricted(
        Some(&vault),
        &settings,
        &cache,
        &["Daily", "planner:", "bookmarks:"],
    );
    let (err, task) = c.call("create_planner_task", json!({ "title": "T" }));
    assert!(!err, "{task}");
    let (err, task) = c.call(
        "complete_planner_task",
        json!({ "id": task["id"], "expected_revision": task["revision"] }),
    );
    assert!(!err, "{task}");
    let (err, bookmarks) = c.call("add_bookmark", json!({ "path": "Note.md" }));
    assert!(!err, "{bookmarks}");
    let (err, _) = c.call("remove_bookmark", json!({ "path": "Note.md" }));
    assert!(!err);
}

#[test]
fn without_any_vault_it_connects_and_picks_up_the_first_one_opened() {
    let home = tempfile::tempdir().unwrap();
    let vault = home.path().join("Vault");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::write(vault.join("Zebra.md"), "# Zebra\n\nstripes").unwrap();
    let settings = home.path().join("settings");
    // Never opened a vault in the app (no settings.json): the handshake still succeeds.
    let mut c = Client::start_with(None, &settings, &home.path().join("cache"));
    let tools = c.request("tools/list", json!({}));
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 79);
    let resources = c.request("resources/list", json!({}));
    assert_eq!(resources["result"]["resources"], json!([]));
    let (err, msg) = c.call("list_files", json!({}));
    assert!(err);
    assert_eq!(msg["code"], "no_vault");
    assert!(
        msg["message"]
            .as_str()
            .unwrap()
            .contains("open (or create) a vault")
    );
    let (err, _) = c.call("vault_guide", json!({}));
    assert!(!err, "the guide needs no vault");
    assert!(c.notifications.is_empty());

    // The human opens a vault in the app: the next call works, indexed, without a restart,
    // and the client learns that resources and prompts appeared.
    open_in_app(&settings, &vault);
    let (err, hits) = c.call("search", json!({ "query": "zebra" }));
    assert!(!err, "{hits}");
    assert_eq!(hits[0]["path"], "Zebra.md", "{hits}");
    assert_eq!(
        c.notifications,
        [
            "notifications/resources/list_changed",
            "notifications/prompts/list_changed"
        ]
    );
    let resources = c.request("resources/list", json!({}));
    assert_eq!(resources["result"]["resources"][0]["name"], "Zebra.md");
    c.call("list_files", json!({}));
    assert_eq!(c.notifications.len(), 2, "told only once");
}

#[test]
fn a_pinned_vault_that_moved_still_connects_and_never_uses_the_apps_vault() {
    let home = tempfile::tempdir().unwrap();
    let (moved, app) = (home.path().join("Moved"), home.path().join("App"));
    std::fs::create_dir_all(&app).unwrap();
    let settings = home.path().join("settings");
    open_in_app(&settings, &app);
    let mut c = Client::start_with(Some(&moved), &settings, &home.path().join("cache"));
    let (err, msg) = c.call("create_file", json!({ "path": "New.md", "content": "hi" }));
    assert!(err);
    assert_eq!(msg["code"], "no_vault");
    assert!(msg["message"].as_str().unwrap().contains("Moved"), "{msg}");
    assert!(
        !app.join("New.md").exists(),
        "never falls back to the app's vault"
    );

    // The pinned folder comes back (a drive is mounted again): it's used from the next call.
    std::fs::create_dir_all(&moved).unwrap();
    let (err, _) = c.call("create_file", json!({ "path": "New.md", "content": "hi" }));
    assert!(!err);
    assert!(moved.join("New.md").exists());
    assert!(!app.join("New.md").exists());
}

#[test]
fn a_pinned_vault_warns_when_the_app_shows_another() {
    let home = tempfile::tempdir().unwrap();
    let (pinned, other) = (home.path().join("Pinned"), home.path().join("Other"));
    std::fs::create_dir_all(&pinned).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let settings = home.path().join("settings");
    open_in_app(&settings, &other);
    let mut c = Client::start_with(Some(&pinned), &settings, &home.path().join("cache"));
    let (_, guide) = c.call("vault_guide", json!({}));
    let guide = guide.as_str().unwrap();
    assert!(
        guide.starts_with("Note: this server is pinned"),
        "{}",
        &guide[..200]
    );
    assert!(guide.contains("Other"));
}

#[test]
fn agent_changes_are_kept_and_can_be_restored() {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    let (_, read) = c.call("read_file", json!({ "path": "Ideas.md" }));
    let original = read["content"].as_str().unwrap().to_string();
    let (err, _) = c.call(
        "edit_file",
        json!({ "path": "Ideas.md", "content": "replaced by mistake" }),
    );
    assert!(!err);
    let (_, hist) = c.call("file_history", json!({ "path": "Ideas.md" }));
    let hist = hist.as_array().unwrap();
    assert_eq!(hist[0]["action"], "edited");
    assert_eq!(hist[0]["source"], "agent");
    assert_eq!(
        hist[0]["actor"], "test",
        "the MCP client's name is recorded"
    );
    assert_eq!(hist[1]["action"], "before");
    let (err, _) = c.call(
        "restore_version",
        json!({ "path": "Ideas.md", "id": hist[1]["id"] }),
    );
    assert!(!err);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Ideas.md")).unwrap(),
        original
    );
}

#[test]
fn render_returns_a_picture_of_a_canvas() {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    let canvas = json!({ "nodes": [
        { "id": "a", "type": "text", "text": "Start", "shape": "pill", "x": 0, "y": 0, "width": 160, "height": 60 },
        { "id": "b", "type": "text", "text": "DB", "shape": "cylinder", "icon": "database", "x": 300, "y": 0, "width": 150, "height": 130 }
    ], "edges": [{ "id": "e", "fromNode": "a", "toNode": "b", "label": "saves" }] });
    let (err, _) = c.call(
        "create_file",
        json!({ "path": "Flow.canvas", "content": canvas.to_string() }),
    );
    assert!(!err);
    let res = c.request(
        "tools/call",
        json!({ "name": "render", "arguments": { "path": "Flow.canvas" } }),
    );
    let block = &res["result"]["content"][0];
    assert_eq!(block["type"], "image");
    assert_eq!(block["mimeType"], "image/png");
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(block["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(&png[1..4], b"PNG");

    let (err, payload) = c.call("render", json!({ "path": "Home.md" }));
    assert!(err);
    assert!(
        payload["message"]
            .as_str()
            .unwrap()
            .contains("draws canvases"),
        "{payload}"
    );
}

#[test]
fn folder_permissions_hide_and_protect_folders_from_agents() {
    let dir = fixture();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::create_dir_all(root.join("Private")).unwrap();
    std::fs::write(root.join("Private/Secret.md"), "zebra password").unwrap();
    std::fs::create_dir_all(root.join("Archive")).unwrap();
    std::fs::write(root.join("Archive/Old.md"), "See [[Ideas]]").unwrap();
    let settings = root.join(".test-settings");
    std::fs::create_dir_all(&settings).unwrap();
    let rules = json!({ "agent_rules": { root.to_str().unwrap(): [
        { "path": "Private", "access": "hidden" },
        { "path": "Archive", "access": "read-only" }
    ] } });
    std::fs::write(settings.join("settings.json"), rules.to_string()).unwrap();
    let mut c = Client::start(&root);

    // Hidden: invisible everywhere, and reading it says "not found".
    let (_, files) = c.call("list_files", json!({}));
    assert!(!files.to_string().contains("Private"), "{files}");
    let (_, hits) = c.call("search", json!({ "query": "zebra" }));
    assert_eq!(hits, json!([]));
    let (err, payload) = c.call("read_file", json!({ "path": "Private/Secret.md" }));
    assert!(err);
    assert_eq!(payload["code"], "not_found");

    // Read-only: readable, but not changeable.
    let (err, _) = c.call("read_file", json!({ "path": "Archive/Old.md" }));
    assert!(!err);
    let (err, payload) = c.call(
        "append_to_file",
        json!({ "path": "Archive/Old.md", "content": "x" }),
    );
    assert!(err);
    assert_eq!(payload["code"], "denied");
    let (err, payload) = c.call("delete_file", json!({ "path": "Archive" }));
    assert!(err);
    assert_eq!(payload["code"], "denied");

    // Moving a file would rewrite the link in the read-only note: refused, nothing moves.
    let (err, payload) = c.call(
        "rename",
        json!({ "from": "Ideas.md", "to": "Notes/Ideas.md" }),
    );
    assert!(err);
    assert_eq!(payload["code"], "denied");
    assert!(
        payload["message"]
            .as_str()
            .unwrap()
            .contains("Archive/Old.md")
    );
    assert!(root.join("Ideas.md").exists());
}

#[test]
fn folder_rules_hold_under_another_spelling_of_the_path() {
    let dir = fixture();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::create_dir_all(root.join("Private")).unwrap();
    std::fs::write(root.join("Private/Secret.md"), "salary: 1").unwrap();
    std::fs::write(root.join("Note.md"), "hi").unwrap();
    std::fs::create_dir_all(root.join("Projects")).unwrap();
    std::fs::write(root.join("Projects/x.md"), "# X\n").unwrap();
    // "Café" in NFC (é = U+00E9).
    std::fs::create_dir_all(root.join("Caf\u{e9}")).unwrap();
    std::fs::write(root.join("Caf\u{e9}/Menu.md"), "soup").unwrap();
    let settings = root.join(".test-settings");
    std::fs::create_dir_all(&settings).unwrap();
    let rules = json!({ "agent_rules": { root.to_str().unwrap(): [
        { "path": "Private", "access": "hidden" },
        { "path": "Note.md", "access": "read-only" },
        { "path": "Projects", "access": "review" },
        { "path": "Caf\u{e9}", "access": "hidden" }
    ] } });
    std::fs::write(settings.join("settings.json"), rules.to_string()).unwrap();
    let mut c = Client::start(&root);

    // Read: lower case and NFD ("e" + U+0301) still read as not found.
    for path in [
        "private/secret.md",
        "PRIVATE/Secret.md",
        "Cafe\u{301}/Menu.md",
    ] {
        let (err, payload) = c.call("read_file", json!({ "path": path }));
        assert!(err, "{path}: {payload}");
        assert_eq!(payload["code"], "not_found", "{path}");
    }
    // Write: a read-only file stays read-only under another case.
    let (err, payload) = c.call(
        "patch_file",
        json!({ "path": "note.md", "find": "hi", "replace": "bye" }),
    );
    assert!(err, "{payload}");
    assert_eq!(std::fs::read_to_string(root.join("Note.md")).unwrap(), "hi");
    let (err, _) = c.call(
        "create_file",
        json!({ "path": "private/New.md", "content": "x" }),
    );
    assert!(err);
    // Rename: can't move a hidden file out, or a file into a hidden folder.
    let (err, _) = c.call(
        "rename",
        json!({ "from": "private/secret.md", "to": "Leak.md" }),
    );
    assert!(err);
    assert!(root.join("Private/Secret.md").exists());
    let (err, _) = c.call(
        "rename",
        json!({ "from": "Ideas.md", "to": "PRIVATE/Ideas.md" }),
    );
    assert!(err);
    assert!(root.join("Ideas.md").exists());
    // Review: a change under another case becomes a proposal, not a direct write.
    let (err, w) = c.call(
        "append_to_file",
        json!({ "path": "projects/x.md", "content": "- y\n" }),
    );
    assert!(!err, "{w}");
    assert!(w["review"].is_i64(), "{w}");
    assert_eq!(
        std::fs::read_to_string(root.join("Projects/x.md")).unwrap(),
        "# X\n"
    );
}

#[test]
fn unreadable_settings_pause_agent_access_instead_of_dropping_the_rules() {
    let dir = fixture();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::create_dir_all(root.join("Private")).unwrap();
    std::fs::write(root.join("Private/Secret.md"), "zebra password").unwrap();
    let settings = root.join(".test-settings");
    std::fs::create_dir_all(&settings).unwrap();
    // Half-written: the rules can't be known, so nothing may be read or changed.
    let rules = json!({ "agent_rules": { root.to_str().unwrap(): [
        { "path": "Private", "access": "hidden" }
    ] } })
    .to_string();
    std::fs::write(settings.join("settings.json"), &rules[..rules.len() - 8]).unwrap();
    let mut c = Client::start(&root);

    for (tool, args) in [
        ("read_file", json!({ "path": "Private/Secret.md" })),
        ("search", json!({ "query": "zebra" })),
        ("list_files", json!({})),
        (
            "append_to_file",
            json!({ "path": "Ideas.md", "content": "x" }),
        ),
    ] {
        let (err, payload) = c.call(tool, args);
        assert!(err, "{tool}: {payload}");
        assert_eq!(payload["code"], "denied", "{tool}: {payload}");
    }
}

#[test]
fn agents_move_several_files_and_add_images() {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    let (err, moved) = c.call(
        "move_files",
        json!({ "paths": ["Ideas.md", "Home.md"], "folder": "Notes" }),
    );
    assert!(!err, "{moved}");
    assert_eq!(moved.as_array().unwrap().len(), 2);
    assert!(
        dir.path().join("Notes/Ideas.md").exists() && dir.path().join("Notes/Home.md").exists()
    );
    // A taken destination: nothing moves.
    std::fs::write(dir.path().join("Taken.md"), "x").unwrap();
    std::fs::create_dir_all(dir.path().join("Box")).unwrap();
    std::fs::write(dir.path().join("Box/Taken.md"), "y").unwrap();
    let (err, payload) = c.call(
        "move_files",
        json!({ "paths": ["Notes/Ideas.md", "Taken.md"], "folder": "Box" }),
    );
    assert!(err);
    assert_eq!(payload["code"], "already_exists");
    assert!(dir.path().join("Notes/Ideas.md").exists());

    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfake");
    let (err, w) = c.call(
        "import_file",
        json!({ "path": "Attachments/pic.png", "data": png }),
    );
    assert!(!err, "{w}");
    let (_, w2) = c.call(
        "import_file",
        json!({ "path": "Attachments/pic.png", "data": png }),
    );
    assert_eq!(w2["path"], "Attachments/pic 1.png", "never overwrites");
    let (err, payload) = c.call(
        "import_file",
        json!({ "path": "x.png", "data": "not base64!!" }),
    );
    assert!(err);
    assert_eq!(payload["code"], "invalid");
}

#[test]
fn notes_are_resources() {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    let list = c.request("resources/list", json!({}));
    let resources = list["result"]["resources"].as_array().unwrap();
    let home = resources
        .iter()
        .find(|r| r["name"] == "Home.md")
        .expect("Home.md is listed");
    assert_eq!(home["uri"], "mosaic:///Home.md");
    assert_eq!(home["mimeType"], "text/markdown");
    let read = c.request("resources/read", json!({ "uri": "mosaic:///Home.md" }));
    assert!(
        read["result"]["contents"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Home")
    );
}

#[test]
fn query_finds_notes_by_frontmatter_tags_and_links() {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    for (path, status) in [
        ("Projects/Alpha.md", "active"),
        ("Projects/Beta.md", "paused"),
    ] {
        let content = format!("---\nstatus: {status}\npriority: 3\n---\nSee [[Ideas]].\n");
        let (err, _) = c.call("create_file", json!({ "path": path, "content": content }));
        assert!(!err);
    }
    let (err, r) = c.call("query", json!({ "query": "status=active links-to:Ideas" }));
    assert!(!err, "{r}");
    assert_eq!(r["total"], 1);
    assert_eq!(r["rows"][0]["path"], "Projects/Alpha.md");
    assert_eq!(r["rows"][0]["props"]["priority"], 3);
    assert_eq!(r["columns"], json!(["status"]));
    let (err, r) = c.call("query", json!({ "query": "folder:Projects sort:-status" }));
    assert!(!err);
    assert_eq!(r["rows"][0]["path"], "Projects/Beta.md");
    let (err, r) = c.call("query", json!({ "query": "limit:lots" }));
    assert!(err);
    assert_eq!(r["code"], "invalid");
}

#[test]
fn changes_in_a_reviewed_folder_become_proposals() {
    let dir = fixture();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::create_dir_all(root.join("Drafts")).unwrap();
    std::fs::write(root.join("Drafts/Plan.md"), "# Plan\n").unwrap();
    let settings = root.join(".test-settings");
    std::fs::create_dir_all(&settings).unwrap();
    let rules = json!({ "agent_rules": { root.to_str().unwrap(): [
        { "path": "Drafts", "access": "review" }
    ] } });
    std::fs::write(settings.join("settings.json"), rules.to_string()).unwrap();
    let mut c = Client::start(&root);

    let (err, w) = c.call(
        "append_to_file",
        json!({ "path": "Drafts/Plan.md", "content": "- step one\n" }),
    );
    assert!(!err, "{w}");
    let id = w["review"].as_i64().expect("a proposal id");
    assert!(
        w["note"]
            .as_str()
            .unwrap()
            .contains("Proposed, not applied")
    );
    // The file is untouched; the agent's reads see its proposal.
    assert_eq!(
        std::fs::read_to_string(root.join("Drafts/Plan.md")).unwrap(),
        "# Plan\n"
    );
    let (_, f) = c.call("read_file", json!({ "path": "Drafts/Plan.md" }));
    assert_eq!(f["content"], "# Plan\n- step one\n");
    assert_eq!(f["review"], id);
    let (_, list) = c.call("list_proposals", json!({}));
    assert_eq!(list[0]["status"], "pending");
    assert_eq!(list[0]["actor"], "test");
    // Agents can't accept their own changes; they can take them back.
    let (err, _) = c.call("withdraw_proposal", json!({ "id": id }));
    assert!(!err);
    let (_, list) = c.call("list_proposals", json!({}));
    assert_eq!(list[0]["status"], "withdrawn");
    // A deletion, rename and binary addition are proposed too.
    let (err, d) = c.call("delete_file", json!({ "path": "Drafts/Plan.md" }));
    assert!(!err && d["review"].is_i64(), "{d}");
    assert!(root.join("Drafts/Plan.md").exists());
    let (err, m) = c.call(
        "rename",
        json!({ "from": "Drafts/Plan.md", "to": "Plan.md" }),
    );
    assert!(!err, "{m}");
    assert!(m["review"].is_i64());
    assert!(root.join("Drafts/Plan.md").exists());
    let (err, image) = c.call(
        "import_file",
        json!({ "path": "Drafts/pic.png", "data": "cG5n" }),
    );
    assert!(!err, "{image}");
    assert!(image["review"].is_i64());
    assert!(!root.join("Drafts/pic.png").exists());
}

#[test]
fn agents_are_prompts_and_days_carry_over() {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    let (err, _) = c.call(
        "create_file",
        json!({ "path": "Agents/Weekly review.md", "content": "---\ndescription: Sum up the week\nschedule: fri 17:00\n---\nRead this week's daily notes.\n" }),
    );
    assert!(!err);
    let (err, list) = c.call("list_agents", json!({}));
    assert!(!err, "{list}");
    assert_eq!(list[0]["name"], "weekly-review");
    assert_eq!(list[0]["schedule"], "fri 17:00");
    // The agent is a prompt (a slash command in Claude Code).
    let prompts = c.request("prompts/list", json!({}));
    let p = &prompts["result"]["prompts"][0];
    assert_eq!(
        (p["name"].as_str(), p["description"].as_str()),
        (Some("weekly-review"), Some("Sum up the week"))
    );
    let got = c.request(
        "prompts/get",
        json!({ "name": "weekly-review", "arguments": { "request": "only project Site" } }),
    );
    let text = got["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(
        text.contains("Act as the agent \"Weekly review\"")
            && text.contains("Read this week's daily notes.")
            && text.contains("only project Site")
    );
    let missing = c.request("prompts/get", json!({ "name": "nope" }));
    assert!(missing["error"].is_object());

    // Days and carry-over.
    for (path, content) in [
        (
            "Daily/2026-10-02.md",
            "- [x] Done\n- [ ] Report\n    - [ ] Draft\n",
        ),
        ("Projects/Site.md", "- [ ] Copy 📅 2026-10-03\n"),
    ] {
        assert!(
            !c.call("create_file", json!({ "path": path, "content": content }))
                .0
        );
    }
    let (err, d) = c.call(
        "tasks_by_day",
        json!({ "from": "2026-10-02", "to": "2026-10-03" }),
    );
    assert!(!err, "{d}");
    assert_eq!(d["days"][0]["tasks"].as_array().unwrap().len(), 3);
    assert_eq!(d["days"][1]["tasks"][0]["daily"], false);
    let (err, r) = c.call("carry_over", json!({ "day": "2026-10-03" }));
    assert!(!err, "{r}");
    assert_eq!(
        (r["moved"].as_u64(), r["to"].as_str()),
        (Some(2), Some("Daily/2026-10-03.md"))
    );
}

/// The app's "Test connection" runs this probe against the bundled command, with a GUI-like
/// environment (no terminal PATH).
#[test]
fn the_connection_test_reports_a_working_server_with_and_without_a_vault() {
    use mosaic_core::mcp_setup::probe;
    let home = tempfile::tempdir().unwrap();
    let vault = home.path().join("Vault");
    std::fs::create_dir_all(&vault).unwrap();
    let settings = home.path().join("settings");
    let env = [
        (
            "MOSAIC_SETTINGS_DIR".to_string(),
            settings.display().to_string(),
        ),
        (
            "MOSAIC_CACHE_DIR".to_string(),
            home.path().join("cache").display().to_string(),
        ),
    ];
    let bin = std::path::Path::new(env!("CARGO_BIN_EXE_mosaic"));
    let timeout = std::time::Duration::from_secs(30);

    let r = probe(bin, &["mcp".into()], &env, timeout);
    assert!(r.ok, "{r:?}");
    assert_eq!(r.tools, 79);
    assert_eq!(r.server_version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
    assert!(r.no_vault.unwrap().contains("No Mosaic vault is open"));

    open_in_app(&settings, &vault);
    let r = probe(bin, &["mcp".into()], &env, timeout);
    assert!(r.ok, "{r:?}");
    assert_eq!(r.no_vault, None);
    assert_eq!(r.error, None);
}

// MCP coverage: docs/MCP_COVERAGE.md maps every Tauri command to an MCP tool, a planned slice or
// an exclusion. These tests keep that file, the README's tool list and the server in step.

fn repo_file(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The text between `<!-- {name}:start -->` and `<!-- {name}:end -->`.
fn marked<'a>(text: &'a str, name: &str, file: &str) -> &'a str {
    let (start, end) = (
        format!("<!-- {name}:start -->"),
        format!("<!-- {name}:end -->"),
    );
    let from = text
        .find(&start)
        .unwrap_or_else(|| panic!("{file} has no {start}"))
        + start.len();
    let to = from
        + text[from..]
            .find(&end)
            .unwrap_or_else(|| panic!("{file} has no {end}"));
    &text[from..to]
}

/// The contents of every `code span` in Markdown text.
fn code_spans(text: &str) -> Vec<&str> {
    text.split('`').skip(1).step_by(2).collect()
}

fn tool_names() -> std::collections::BTreeSet<String> {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    let tools = c.request("tools/list", json!({}));
    tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

/// The commands `src-tauri/src/lib.rs` registers (every `collect_commands![…]` and
/// `generate_handler![…]`), by the name the UI invokes: the fn name without its module path.
fn tauri_commands() -> Vec<String> {
    let src = repo_file("src-tauri/src/lib.rs");
    let mut commands = Vec::new();
    for mac in ["collect_commands![", "generate_handler!["] {
        for (at, _) in src.match_indices(mac) {
            // The macro body, up to its matching `]`.
            let mut depth = 1;
            let body: String = src[at + mac.len()..]
                .chars()
                .take_while(|&ch| {
                    depth += match ch {
                        '[' => 1,
                        ']' => -1,
                        _ => 0,
                    };
                    depth > 0
                })
                .collect();
            // Drop `//` comments, then `#[…]` attributes.
            let body: String = body
                .lines()
                .map(|l| l.split("//").next().unwrap())
                .collect::<Vec<_>>()
                .join("\n");
            let mut plain = String::new();
            let mut rest = body.as_str();
            while let Some(i) = rest.find("#[") {
                plain.push_str(&rest[..i]);
                let mut depth = 0;
                let end = rest[i + 1..]
                    .char_indices()
                    .find(|&(_, ch)| {
                        depth += match ch {
                            '[' => 1,
                            ']' => -1,
                            _ => 0,
                        };
                        depth == 0
                    })
                    .map(|(j, _)| i + 1 + j + 1)
                    .expect("unclosed attribute");
                rest = &rest[end..];
            }
            plain.push_str(rest);
            for entry in plain.split(',').map(str::trim).filter(|e| !e.is_empty()) {
                let name = entry.rsplit("::").next().unwrap();
                assert!(
                    name.chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_'),
                    "unexpected entry {entry:?} in {mac}…] of src-tauri/src/lib.rs"
                );
                commands.push(name.to_string());
            }
        }
    }
    assert!(
        commands.len() > 100,
        "found only {} Tauri commands in src-tauri/src/lib.rs; has the registration moved?",
        commands.len()
    );
    commands
}

#[test]
fn tauri_commands_are_covered_by_mcp() {
    const DOC: &str = "docs/MCP_COVERAGE.md";
    const SLICES: [&str; 6] = ["M2", "M3", "M4", "M5", "M6", "M7"];
    /// Never MCP tools, whatever later slices do (see the doc's Exclusions).
    const HARD: [&str; 4] = [
        "accept_proposal",
        "reject_proposal",
        "set_agent_rules",
        "tessera_set_max_chain_depth",
    ];
    let doc = repo_file(DOC);
    let tools = tool_names();
    let commands = tauri_commands();
    let mut problems = Vec::new();

    let mut rows = std::collections::BTreeMap::new();
    let mut named_tools = std::collections::BTreeSet::new();
    for line in marked(&doc, "inventory", DOC).lines().map(str::trim) {
        if !line.starts_with('|') || line.starts_with("|---") || line.starts_with("| Tauri command")
        {
            continue;
        }
        let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
        let (command, status) = match (cells.first(), cells.get(1)) {
            (Some(c), Some(s)) if c.len() > 2 && c.starts_with('`') && c.ends_with('`') => {
                (&c[1..c.len() - 1], *s)
            }
            _ => {
                problems.push(format!("{DOC}: can't read inventory row {line:?}"));
                continue;
            }
        };
        if rows
            .insert(command.to_string(), status.to_string())
            .is_some()
        {
            problems.push(format!("{DOC}: `{command}` has two rows"));
        }
        if let Some(slice) = status.strip_prefix("planned (") {
            if !SLICES.contains(&slice.trim_end_matches(')')) || !slice.ends_with(')') {
                problems.push(format!(
                    "{DOC}: `{command}` is {status:?}; the slice must be one of {SLICES:?}"
                ));
            }
        } else if let Some(reason) = status.strip_prefix("excluded (") {
            if !reason.ends_with(')') || reason.trim_end_matches(')').trim().is_empty() {
                problems.push(format!("{DOC}: `{command}` is excluded without a reason"));
            }
        } else {
            let covered = code_spans(status);
            let rest: String = status.split('`').step_by(2).collect();
            if covered.is_empty() || rest.chars().any(|ch| ch != ',' && ch != ' ') {
                problems.push(format!(
                    "{DOC}: `{command}`'s MCP cell {status:?} must be `tool`[, `tool`], \
                     planned (M<n>) or excluded (reason)"
                ));
            }
            for tool in covered {
                if !tools.contains(tool) {
                    problems.push(format!(
                        "{DOC}: `{command}` is covered by `{tool}`, which the MCP server doesn't have"
                    ));
                }
                named_tools.insert(tool.to_string());
            }
        }
    }

    let mut seen = std::collections::BTreeSet::new();
    for command in &commands {
        if !seen.insert(command) {
            problems.push(format!("src-tauri/src/lib.rs registers `{command}` twice"));
        }
        if !rows.contains_key(command) {
            problems.push(format!(
                "Tauri command `{command}` has no row in {DOC}: map it to an MCP tool, \
                 planned (M<n>) or excluded (reason)"
            ));
        }
    }
    for command in rows.keys() {
        if !seen.contains(command) {
            problems.push(format!(
                "{DOC} lists `{command}`, which src-tauri/src/lib.rs doesn't register"
            ));
        }
    }
    for command in HARD {
        if !rows
            .get(command)
            .is_some_and(|s| s.starts_with("excluded (hard:"))
        {
            problems.push(format!(
                "`{command}` must stay a hard exclusion in {DOC}: `excluded (hard: …)`"
            ));
        }
    }

    for line in marked(&doc, "mcp-only", DOC).lines() {
        if let Some(tool) = code_spans(line).first() {
            if !tools.contains(*tool) {
                problems.push(format!(
                    "{DOC} lists MCP-only tool `{tool}`, which the server doesn't have"
                ));
            }
            named_tools.insert(tool.to_string());
        }
    }
    for tool in &tools {
        if !named_tools.contains(tool) {
            problems.push(format!(
                "MCP tool `{tool}` isn't in {DOC}: name it in the inventory or the MCP-only list"
            ));
        }
    }

    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn readme_lists_every_mcp_tool() {
    let readme = repo_file("README.md");
    let listed: std::collections::BTreeSet<String> =
        code_spans(marked(&readme, "mcp-tools", "README.md"))
            .into_iter()
            .map(String::from)
            .collect();
    let tools = tool_names();
    let missing: Vec<_> = tools.difference(&listed).collect();
    let stale: Vec<_> = listed.difference(&tools).collect();
    assert!(
        missing.is_empty() && stale.is_empty(),
        "README.md's MCP tool list is out of date: add {missing:?}, remove {stale:?}"
    );
}

/// A vault in a temp dir with these files, and its canonical root (folder rules match it).
fn vault_with(files: &[(&str, &str)]) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    for (p, c) in files {
        let full = root.join(p);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, c).unwrap();
    }
    (dir, root)
}

/// Writes the agent folder rules for `root` where `Client::start`'s server reads them: settings.json
/// for a vault not used yet, else the vault's own state (`vaults/<id>/rules.json`), which wins.
fn agent_rules(root: &std::path::Path, rules: Value) {
    let settings = root.join(".test-settings");
    std::fs::create_dir_all(&settings).unwrap();
    let config = json!({ "agent_rules": { root.to_str().unwrap(): rules } });
    std::fs::write(settings.join("settings.json"), config.to_string()).unwrap();
    if let Ok(vaults) = std::fs::read_dir(settings.join("vaults")) {
        for state in vaults {
            std::fs::write(state.unwrap().path().join("rules.json"), rules.to_string()).unwrap();
        }
    }
}

/// The `query task:all` row of the task whose text contains `text`.
fn task_row(c: &mut Client, text: &str) -> Value {
    let (err, q) = c.call("query", json!({ "query": "task:all" }));
    assert!(!err, "{q}");
    q["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["task"]["text"].as_str().unwrap().contains(text))
        .cloned()
        .unwrap_or_else(|| panic!("no task {text}: {q}"))
}

fn read(root: &std::path::Path, p: &str) -> String {
    std::fs::read_to_string(root.join(p)).unwrap()
}

#[test]
fn links_index_and_task_tools_work_end_to_end() {
    let (_dir, root) = vault_with(&[
        ("Home.md", "---\naliases: [Start]\n---\n# Home\n"),
        ("Ideas.md", "Mention Home here.\n"),
        ("Tasks.md", "- [ ] Write report\n- [ ] Ship it\n"),
    ]);
    let mut c = Client::start(&root);
    let tools = c.request("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for expected in [
        "get_index_health",
        "rebuild_index",
        "set_task",
        "set_task_workflow",
        "list_aliases",
        "list_unlinked_mentions",
        "link_mention",
        "list_unfinished_renames",
        "fix_links",
        "read_version",
        "list_ai_activity",
        "undo_change",
    ] {
        assert!(names.contains(&expected), "missing tool {expected}");
    }

    // Index.
    let (err, health) = c.call("get_index_health", json!({}));
    assert!(!err, "{health}");
    assert_eq!(health["status"], "healthy");
    assert_eq!(health["app_watching"], false);
    let (err, stats) = c.call("rebuild_index", json!({}));
    assert!(!err, "{stats}");
    assert_eq!(stats["indexed"], 3, "{stats}");

    // Aliases, mentions and linking one.
    let (err, aliases) = c.call("list_aliases", json!({}));
    assert!(!err, "{aliases}");
    assert_eq!(aliases, json!([{ "alias": "Start", "path": "Home.md" }]));
    let (err, mentions) = c.call("list_unlinked_mentions", json!({ "path": "Home.md" }));
    assert!(!err, "{mentions}");
    assert_eq!(mentions[0]["source"], "Ideas.md");
    assert_eq!(mentions[0]["line"], 1);
    let (err, linked) = c.call(
        "link_mention",
        json!({ "source": "Ideas.md", "line": 1, "text": mentions[0]["text"], "target": "Home.md" }),
    );
    assert!(!err, "{linked}");
    assert_eq!(read(&root, "Ideas.md"), "Mention [[Home]] here.\n");
    let (_, mentions) = c.call("list_unlinked_mentions", json!({ "path": "Home.md" }));
    assert_eq!(mentions, json!([]));

    // Ticking a task, then its workflow state.
    let row = task_row(&mut c, "Write report");
    let (err, w) = c.call(
        "set_task",
        json!({ "path": row["path"], "line": row["task"]["line"], "text": row["task"]["text"], "done": true }),
    );
    assert!(!err, "{w}");
    assert!(read(&root, "Tasks.md").starts_with("- [x] Write report\n"));
    let (err, stale) = c.call(
        "set_task",
        json!({ "path": "Tasks.md", "line": 1, "text": "Something else", "done": false }),
    );
    assert!(err && stale["code"] == "conflict", "{stale}");

    let row = task_row(&mut c, "Ship it");
    assert_eq!(row["task"]["workflow"], "new");
    let (err, w) = c.call(
        "set_task_workflow",
        json!({ "path": row["path"], "line": row["task"]["line"], "text": row["task"]["text"],
                "expected_state": row["task"]["workflow"], "state": "in-progress" }),
    );
    assert!(!err, "{w}");
    assert!(
        read(&root, "Tasks.md").contains("- [ ] Ship it <!-- mosaic:state=in-progress -->\n"),
        "{}",
        read(&root, "Tasks.md")
    );
    // The row now carries the annotation in its text; passing it as-is works.
    let row = task_row(&mut c, "Ship it");
    assert_eq!(row["task"]["workflow"], "in-progress");
    let (err, w) = c.call(
        "set_task_workflow",
        json!({ "path": row["path"], "line": row["task"]["line"], "text": row["task"]["text"],
                "expected_state": "in-progress", "state": "done" }),
    );
    assert!(!err, "{w}");
    assert!(read(&root, "Tasks.md").contains("- [x] Ship it\n"));
    let (err, stale) = c.call(
        "set_task_workflow",
        json!({ "path": "Tasks.md", "line": 2, "text": "Ship it", "expected_state": "new", "state": "blocked" }),
    );
    assert!(err && stale["code"] == "conflict", "{stale}");

    // History: activity, an old version, undo.
    let (err, activity) = c.call("list_ai_activity", json!({}));
    assert!(!err, "{activity}");
    let link = activity
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["path"] == "Ideas.md")
        .expect("the link_mention change");
    assert_eq!(
        (&link["action"], &link["source"], &link["actor"]),
        (&json!("edited"), &json!("agent"), &json!("test"))
    );
    let (_, versions) = c.call("file_history", json!({ "path": "Tasks.md" }));
    let oldest = versions.as_array().unwrap().last().unwrap()["id"].clone();
    let (err, old) = c.call("read_version", json!({ "id": oldest }));
    assert!(!err, "{old}");
    assert_eq!(old["content"], "- [ ] Write report\n- [ ] Ship it\n");
    let (err, missing) = c.call("read_version", json!({ "id": 99999 }));
    assert!(err && missing["code"] == "not_found", "{missing}");
    let (err, undone) = c.call("undo_change", json!({ "id": link["id"] }));
    assert!(!err, "{undone}");
    assert_eq!(undone, json!({ "path": "Ideas.md" }));
    assert_eq!(read(&root, "Ideas.md"), "Mention Home here.\n");

    // Nothing to repair.
    let (err, open) = c.call("list_unfinished_renames", json!({}));
    assert!(!err, "{open}");
    assert_eq!(open, json!([]));
    let (err, none) = c.call("fix_links", json!({ "id": 1 }));
    assert!(err && none["code"] == "invalid", "{none}");
}

#[test]
fn note_edits_and_undo_outside_may_change_become_proposals() {
    let (dir, root) = vault_with(&[
        ("Home.md", "# Home\n"),
        (
            "Note.md",
            "Mention Home here.\n- [ ] Task one\n- [ ] Task two\n",
        ),
        ("Daily/Today.md", "- [ ] Daily task\n"),
    ]);
    let settings = dir.path().join("settings");
    let cache = dir.path().join("cache");
    // An unrestricted agent's change, for the restricted one to undo.
    let mut free = Client::start_restricted(Some(&root), &settings, &cache, &[]);
    let (err, _) = free.call(
        "append_to_file",
        json!({ "path": "Note.md", "content": "- appended\n" }),
    );
    assert!(!err);
    let (_, activity) = free.call("list_ai_activity", json!({}));
    let change = activity[0]["id"].clone();
    drop(free);
    let before = read(&root, "Note.md");

    let mut c = Client::start_restricted(Some(&root), &settings, &cache, &["Daily"]);
    let proposed = |payload: &Value| {
        assert!(payload["review"].is_i64(), "{payload}");
        assert!(
            payload["note"]
                .as_str()
                .unwrap()
                .contains("Proposed, not applied")
        );
    };
    let (err, w) = c.call(
        "set_task",
        json!({ "path": "Note.md", "line": 2, "text": "Task one", "done": true }),
    );
    assert!(!err, "{w}");
    proposed(&w);
    let (err, w) = c.call(
        "set_task_workflow",
        json!({ "path": "Note.md", "line": 3, "text": "Task two", "expected_state": "new", "state": "blocked" }),
    );
    assert!(!err, "{w}");
    proposed(&w);
    let (err, w) = c.call(
        "link_mention",
        json!({ "source": "Note.md", "line": 1, "text": "Home", "target": "Home.md" }),
    );
    assert!(!err, "{w}");
    proposed(&w);
    let pending = w["review"].clone();
    assert_eq!(
        read(&root, "Note.md"),
        before,
        "nothing written outside Daily"
    );
    // The proposals build on each other: the agent reads all three changes.
    let (_, f) = c.call("read_file", json!({ "path": "Note.md" }));
    let content = f["content"].as_str().unwrap();
    assert!(content.contains("[[Home]]") && content.contains("- [x] Task one"));
    assert!(
        content.contains("Task two <!-- mosaic:state=blocked -->"),
        "{content}"
    );

    // Inside Daily, the same tool writes directly.
    let (err, w) = c.call(
        "set_task",
        json!({ "path": "Daily/Today.md", "line": 1, "text": "Daily task", "done": true }),
    );
    assert!(!err && w["review"].is_null(), "{w}");
    assert_eq!(read(&root, "Daily/Today.md"), "- [x] Daily task\n");
    let (err, _) = c.call("withdraw_proposal", json!({ "id": pending }));
    assert!(!err);

    // Undo by a restricted agent is reviewed like any other change.
    let (err, undone) = c.call("undo_change", json!({ "id": change }));
    assert!(!err, "{undone}");
    assert_eq!(undone["path"], "Note.md");
    proposed(&undone);
    assert_eq!(read(&root, "Note.md"), before, "the undo waits for review");
    let (_, list) = c.call("list_proposals", json!({}));
    assert_eq!(list[0]["status"], "pending");
    assert_eq!(list[0]["id"], undone["review"]);
}

#[test]
fn hidden_notes_stay_hidden_from_link_task_and_history_tools() {
    let (_dir, root) = vault_with(&[
        ("Home.md", "---\naliases: [Start]\n---\n# Home\n"),
        ("Ideas.md", "Mention Home here.\n"),
        ("Private/Diary.md", "Home again.\n- [ ] Secret task\n"),
        ("Private/Secret.md", "---\naliases: [Hush]\n---\n"),
    ]);
    let mut c = Client::start(&root);
    let (err, _) = c.call(
        "append_to_file",
        json!({ "path": "Private/Diary.md", "content": "more\n" }),
    );
    assert!(!err);
    let (_, activity) = c.call("list_ai_activity", json!({}));
    let change = activity[0]["id"].clone();
    drop(c);
    agent_rules(&root, json!([{ "path": "Private", "access": "hidden" }]));
    let mut c = Client::start(&root);

    let (_, mentions) = c.call("list_unlinked_mentions", json!({ "path": "Home.md" }));
    assert_eq!(
        mentions
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["source"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Ideas.md"],
        "mentions in hidden notes are left out"
    );
    let not_found = |(err, payload): (bool, Value)| {
        assert!(err && payload["code"] == "not_found", "{payload}");
        assert!(payload["current_hash"].is_null(), "{payload}");
    };
    not_found(c.call(
        "list_unlinked_mentions",
        json!({ "path": "Private/Secret.md" }),
    ));
    not_found(c.call(
        "link_mention",
        json!({ "source": "Ideas.md", "line": 1, "text": "Home", "target": "Private/Secret.md" }),
    ));
    not_found(c.call(
        "set_task",
        json!({ "path": "Private/Diary.md", "line": 9, "text": "x", "done": true }),
    ));
    not_found(c.call(
        "set_task_workflow",
        json!({ "path": "Private/Diary.md", "line": 9, "text": "x", "expected_state": "new", "state": "done" }),
    ));
    let (err, payload) = c.call("read_version", json!({ "id": change }));
    assert!(!payload.to_string().contains("Private"), "{payload}");
    not_found((err, payload));
    let (err, payload) = c.call("undo_change", json!({ "id": change }));
    assert!(!payload.to_string().contains("Private"), "{payload}");
    not_found((err, payload));
    let (_, aliases) = c.call("list_aliases", json!({}));
    assert_eq!(aliases, json!([{ "alias": "Start", "path": "Home.md" }]));
    let (_, activity) = c.call("list_ai_activity", json!({}));
    assert_eq!(activity, json!([]));
    assert_eq!(
        read(&root, "Private/Diary.md"),
        "Home again.\n- [ ] Secret task\nmore\n"
    );
}

/// One recurring timed event, Mondays at 09:30 in Paris from 2026-11-23.
fn standup() -> Value {
    json!({
        "title": "Standup",
        "start_value": "2026-11-23T09:30:00+01:00",
        "end_value": "2026-11-23T09:45:00+01:00",
        "timezone": "Europe/Paris",
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO"
    })
}

fn find<'a>(list: &'a Value, key: &str, value: &Value) -> Option<&'a Value> {
    list.as_array()
        .unwrap()
        .iter()
        .find(|item| &item[key] == value)
}

#[test]
fn agents_manage_calendar_events_and_work_sessions() {
    let dir = fixture();
    let epic = mosaic_core::planner::PlannerStore::open(dir.path())
        .unwrap()
        .create_epic(mosaic_core::planner::CreateEpic {
            title: "Launch".into(),
            description: String::new(),
            color: "#22c55e".into(),
        })
        .unwrap();
    let mut c = Client::start(dir.path());

    // Events: create with every optional field, then clear them with "".
    let (err, event) = c.call(
        "create_planner_event",
        json!({
            "title": "Design review",
            "location": "Room 2",
            "meeting_url": "https://meet.example.com/x",
            "participants": ["ana@example.com"],
            "epic_id": epic.id,
            "color": "#ff0000",
            "start_value": "2026-11-20T09:00:00+01:00",
            "end_value": "2026-11-20T10:00:00+01:00",
            "timezone": "Europe/Paris",
            "recurrence_rule": "FREQ=DAILY;COUNT=2"
        }),
    );
    assert!(!err, "{event}");
    assert_eq!(event["start_value"], "2026-11-20T08:00:00.000Z");
    assert_eq!(event["revision"], 1);
    let id = event["id"].clone();
    let (err, updated) = c.call(
        "update_planner_event",
        json!({
            "id": id, "expected_revision": 1, "title": "Design review (final)",
            "meeting_url": "", "epic_id": "", "color": "", "recurrence_rule": ""
        }),
    );
    assert!(!err, "{updated}");
    assert_eq!(updated["revision"], 2);
    assert_eq!(updated["title"], "Design review (final)");
    assert_eq!(updated["location"], "Room 2", "fields left out are kept");
    assert_eq!(updated["participants"], json!(["ana@example.com"]));
    for cleared in ["meeting_url", "epic_id", "color", "recurrence_rule"] {
        assert_eq!(updated[cleared], Value::Null, "{cleared}");
    }
    let (err, stale) = c.call(
        "update_planner_event",
        json!({ "id": id, "expected_revision": 1, "title": "Lost update" }),
    );
    assert!(err && stale["code"] == "conflict", "{stale}");
    let (_, events) = c.call("list_planner_events", json!({}));
    assert_eq!(
        find(&events, "id", &id).unwrap(),
        &updated,
        "a refused update changes nothing"
    );

    // Work sessions for a Board task due in the range.
    let (_, task) = c.call(
        "create_planner_task",
        json!({ "title": "Write brief", "due_date": "2026-11-21" }),
    );
    let (err, session) = c.call(
        "create_planner_work_session",
        json!({
            "task_id": task["id"],
            "start_value": "2026-11-21T14:00:00+01:00",
            "end_value": "2026-11-21T15:30:00+01:00",
            "timezone": "Europe/Paris"
        }),
    );
    assert!(!err, "{session}");
    let (err, sessions) = c.call(
        "list_planner_work_sessions",
        json!({ "task_id": task["id"] }),
    );
    assert!(!err, "{sessions}");
    assert_eq!(sessions, json!([session]));
    let (err, moved) = c.call(
        "update_planner_work_session",
        json!({ "id": session["id"], "expected_revision": 1, "end_value": "2026-11-21T16:00:00+01:00" }),
    );
    assert!(!err, "{moved}");
    assert_eq!(moved["start_value"], session["start_value"]);
    assert_eq!(moved["end_value"], "2026-11-21T15:00:00.000Z");
    let (err, stale) = c.call(
        "update_planner_work_session",
        json!({ "id": session["id"], "expected_revision": 1, "end_value": "2026-11-21T18:00:00+01:00" }),
    );
    assert!(err && stale["code"] == "conflict", "{stale}");
    let (_, sessions) = c.call("list_planner_work_sessions", json!({}));
    assert_eq!(sessions, json!([moved]), "a refused update changes nothing");

    // The range shows events, work sessions and due Board tasks together, with revisions.
    let (err, range) = c.call(
        "get_planner_calendar",
        json!({ "from": "2026-11-20", "to": "2026-11-22" }),
    );
    assert!(!err, "{range}");
    let occurrence = find(&range["events"], "event_id", &id).unwrap();
    assert_eq!(occurrence["series_revision"], 2);
    assert_eq!(occurrence["occurrence_key"], "2026-11-20");
    let scheduled = &range["work_sessions"][0];
    assert_eq!(scheduled["session"]["id"], session["id"]);
    assert_eq!(scheduled["task_title"], "Write brief");
    assert_eq!(range["due_markers"][0]["task_id"], task["id"]);
    assert_eq!(
        find(&range["workload"], "date", &json!("2026-11-21")).unwrap()["minutes"],
        120
    );
    assert!(range.get("unscheduled_tasks").is_none(), "{range}");
    let (_, range) = c.call(
        "get_planner_calendar",
        json!({ "from": "2026-11-20", "to": "2026-11-20", "include_unscheduled_tasks": true }),
    );
    assert_eq!(range["unscheduled_tasks"][0]["id"], task["id"]);
    let (err, week) = c.call("get_planner_calendar", json!({}));
    assert!(!err, "{week}");
    assert_eq!(week["workload"].as_array().unwrap().len(), 7, "{week}");

    let (err, cancelled) = c.call(
        "cancel_planner_work_session",
        json!({ "id": session["id"], "expected_revision": moved["revision"] }),
    );
    assert!(!err, "{cancelled}");
    assert_eq!(cancelled["state"], "cancelled");
    let (_, sessions) = c.call("list_planner_work_sessions", json!({}));
    assert_eq!(sessions, json!([]));
    let (_, sessions) = c.call(
        "list_planner_work_sessions",
        json!({ "include_cancelled": true }),
    );
    assert_eq!(sessions, json!([cancelled]));

    // Export returns the iCalendar text itself.
    let (err, ics) = c.call("export_ical", json!({}));
    assert!(!err, "{ics}");
    let ics = ics.as_str().expect("plain text");
    assert!(ics.starts_with("BEGIN:VCALENDAR"), "{ics}");
    assert!(ics.contains("SUMMARY:Design review (final)"), "{ics}");

    // Lifecycle: trash needs archive first; restore brings it back.
    let (err, refused) = c.call(
        "trash_planner_event",
        json!({ "id": id, "expected_revision": 2 }),
    );
    assert!(err && refused["code"] == "invalid", "{refused}");
    let (err, archived) = c.call(
        "archive_planner_event",
        json!({ "id": id, "expected_revision": 2 }),
    );
    assert!(!err && archived["archived_at"].is_string(), "{archived}");
    let (err, trashed) = c.call(
        "trash_planner_event",
        json!({ "id": id, "expected_revision": 3 }),
    );
    assert!(!err && trashed["trashed_at"].is_string(), "{trashed}");
    let (_, events) = c.call("list_planner_events", json!({}));
    assert_eq!(events, json!([]));
    let (_, events) = c.call(
        "list_planner_events",
        json!({ "include_archived": true, "include_trashed": true }),
    );
    assert_eq!(events, json!([trashed]));
    let (err, restored) = c.call(
        "restore_planner_event",
        json!({ "id": id, "expected_revision": 4 }),
    );
    assert!(!err, "{restored}");
    assert!(restored["archived_at"].is_null() && restored["trashed_at"].is_null());
    let (_, events) = c.call("list_planner_events", json!({}));
    assert_eq!(events, json!([restored]));
}

#[test]
fn recurring_occurrences_can_be_cancelled_and_replaced() {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    let (err, series) = c.call("create_planner_event", standup());
    assert!(!err, "{series}");
    let id = series["id"].clone();
    let occurrences = |c: &mut Client| {
        let (err, range) = c.call(
            "get_planner_calendar",
            json!({ "from": "2026-11-23", "to": "2026-12-13" }),
        );
        assert!(!err, "{range}");
        range["events"].as_array().unwrap().clone()
    };
    let all = occurrences(&mut c);
    let keys: Vec<_> = all.iter().map(|o| o["occurrence_key"].clone()).collect();
    assert_eq!(
        keys,
        [
            json!("2026-11-23"),
            json!("2026-11-30"),
            json!("2026-12-07")
        ]
    );
    assert!(
        all.iter()
            .all(|o| o["series_id"] == id && o["series_revision"] == 1)
    );

    let (err, after) = c.call(
        "cancel_planner_event_occurrence",
        json!({ "series_id": id, "expected_revision": 1, "occurrence_key": "2026-11-30" }),
    );
    assert!(!err, "{after}");
    assert_eq!(after["revision"], 2);
    let (err, stale) = c.call(
        "cancel_planner_event_occurrence",
        json!({ "series_id": id, "expected_revision": 1, "occurrence_key": "2026-12-07" }),
    );
    assert!(err && stale["code"] == "conflict", "{stale}");
    let keys: Vec<_> = occurrences(&mut c)
        .iter()
        .map(|o| o["occurrence_key"].clone())
        .collect();
    assert_eq!(keys, [json!("2026-11-23"), json!("2026-12-07")]);

    let (err, refused) = c.call(
        "replace_planner_event_occurrence",
        json!({
            "series_id": id, "expected_revision": 2, "occurrence_key": "2026-11-24",
            "start_value": "2026-11-24T10:00:00+01:00", "end_value": "2026-11-24T10:15:00+01:00"
        }),
    );
    assert!(
        err && refused["code"] == "invalid",
        "not an occurrence: {refused}"
    );
    let (err, replacement) = c.call(
        "replace_planner_event_occurrence",
        json!({
            "series_id": id, "expected_revision": 2, "occurrence_key": "2026-12-07",
            "title": "Standup (moved)",
            "start_value": "2026-12-08T10:00:00+01:00", "end_value": "2026-12-08T10:30:00+01:00"
        }),
    );
    assert!(!err, "{replacement}");
    assert_eq!(replacement["series_id"], id);
    assert_eq!(
        replacement["timezone"], "Europe/Paris",
        "taken from the series"
    );
    let all = occurrences(&mut c);
    assert_eq!(all.len(), 2, "{all:?}");
    let moved = &all[1];
    assert_eq!(moved["event_id"], replacement["id"]);
    assert_eq!(moved["series_id"], id);
    assert_eq!(moved["title"], "Standup (moved)");
    assert_eq!(moved["start_value"], "2026-12-08T09:00:00.000Z");
    assert_eq!(moved["series_revision"], 3);
}

const ICS: &str = "BEGIN:VCALENDAR\nVERSION:2.0\n\
BEGIN:VEVENT\nUID:one@example.com\nDTSTART:20261201T100000Z\nDTEND:20261201T110000Z\n\
SUMMARY:Imported meeting\nLOCATION:Room 4\nEND:VEVENT\n\
BEGIN:VEVENT\nUID:series@example.com\nDTSTART;TZID=Europe/Paris:20261202T090000\n\
DTEND;TZID=Europe/Paris:20261202T093000\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Daily sync\nEND:VEVENT\n\
BEGIN:VEVENT\nUID:series@example.com\nRECURRENCE-ID;TZID=Europe/Paris:20261203T090000\n\
DTSTART;TZID=Europe/Paris:20261203T110000\nDTEND;TZID=Europe/Paris:20261203T113000\n\
SUMMARY:Daily sync (late)\nEND:VEVENT\nEND:VCALENDAR\n";

#[test]
fn ical_text_is_previewed_and_imported() {
    let dir = fixture();
    let mut c = Client::start(dir.path());
    let (err, preview) = c.call("preview_ical_import", json!({ "content": ICS }));
    assert!(!err, "{preview}");
    assert_eq!(preview["duplicates"], 0);
    let candidates = preview["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 3, "{preview}");
    assert!(
        candidates.iter().all(|c| c.get("event").is_none()),
        "compact"
    );
    let one = find(
        &preview["candidates"],
        "source_uid",
        &json!("one@example.com"),
    )
    .unwrap();
    assert_eq!(one["location"], "Room 4");
    assert_eq!(one["start_value"], "2026-12-01T10:00:00.000Z");

    let (err, refused) = c.call(
        "import_ical",
        json!({ "content": ICS, "select": ["series@example.com", "nope"] }),
    );
    assert!(err && refused["code"] == "invalid", "{refused}");
    let (_, events) = c.call("list_planner_events", json!({}));
    assert_eq!(events, json!([]), "a refused import adds nothing");

    // A UID selects the series with its override.
    let (err, imported) = c.call(
        "import_ical",
        json!({ "content": ICS, "select": ["series@example.com"] }),
    );
    assert!(!err, "{imported}");
    assert_eq!(imported["imported_event_ids"].as_array().unwrap().len(), 2);
    let (_, range) = c.call(
        "get_planner_calendar",
        json!({ "from": "2026-12-02", "to": "2026-12-04" }),
    );
    let titles: Vec<_> = range["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["Daily sync", "Daily sync (late)", "Daily sync"]);

    let (_, preview) = c.call("preview_ical_import", json!({ "content": ICS }));
    assert_eq!(preview["duplicates"], 2);
    let (err, imported) = c.call("import_ical", json!({ "content": ICS }));
    assert!(!err, "{imported}");
    assert_eq!(imported["imported_event_ids"].as_array().unwrap().len(), 1);
    assert_eq!(imported["skipped_duplicates"].as_array().unwrap().len(), 2);
    let (_, events) = c.call("list_planner_events", json!({}));
    assert!(
        find(&events, "title", &json!("Imported meeting")).is_some(),
        "{events}"
    );
}

#[test]
fn calendar_writes_need_the_planner_scope_under_may_change() {
    let home = tempfile::tempdir().unwrap();
    let vault = home.path().join("V");
    std::fs::create_dir_all(vault.join("Daily")).unwrap();
    let settings = home.path().join("settings");
    let cache = home.path().join("cache");

    let mut c = Client::start_with(Some(&vault), &settings, &cache);
    let (_, task) = c.call("create_planner_task", json!({ "title": "T" }));
    let (_, series) = c.call("create_planner_event", standup());
    let (_, session) = c.call(
        "create_planner_work_session",
        json!({
            "task_id": task["id"], "all_day": true,
            "start_value": "2026-11-23", "end_value": "2026-11-24", "timezone": "Europe/Paris"
        }),
    );
    assert!(session["id"].is_string(), "{session}");
    drop(c);

    let writes = |series: &Value, session: &Value| {
        let id = &series["id"];
        let rev = &series["revision"];
        vec![
            ("create_planner_event", standup()),
            (
                "update_planner_event",
                json!({ "id": id, "expected_revision": rev, "title": "X" }),
            ),
            (
                "cancel_planner_event_occurrence",
                json!({ "series_id": id, "expected_revision": rev, "occurrence_key": "2026-11-30" }),
            ),
            (
                "replace_planner_event_occurrence",
                json!({
                    "series_id": id, "expected_revision": rev, "occurrence_key": "2026-12-07",
                    "start_value": "2026-12-07T11:00:00+01:00", "end_value": "2026-12-07T11:15:00+01:00"
                }),
            ),
            (
                "create_planner_work_session",
                json!({
                    "task_id": session["task_id"], "start_value": "2026-11-24T09:00:00+01:00",
                    "end_value": "2026-11-24T10:00:00+01:00", "timezone": "Europe/Paris"
                }),
            ),
            (
                "update_planner_work_session",
                json!({ "id": session["id"], "expected_revision": session["revision"], "end_value": "2026-11-25" }),
            ),
            (
                "cancel_planner_work_session",
                json!({ "id": session["id"], "expected_revision": session["revision"] }),
            ),
            ("import_ical", json!({ "content": ICS })),
            (
                "archive_planner_event",
                json!({ "id": id, "expected_revision": rev }),
            ),
        ]
    };

    let mut c = Client::start_restricted(Some(&vault), &settings, &cache, &["Daily"]);
    let mut lifecycle = writes(&series, &session);
    lifecycle.extend([
        (
            "trash_planner_event",
            json!({ "id": series["id"], "expected_revision": 1 }),
        ),
        (
            "restore_planner_event",
            json!({ "id": series["id"], "expected_revision": 1 }),
        ),
    ]);
    for (tool, args) in lifecycle {
        let (err, refused) = c.call(tool, args);
        assert!(err && refused["code"] == "denied", "{tool}: {refused}");
        assert!(
            refused["message"].as_str().unwrap().contains("`planner:`"),
            "{tool}: {refused}"
        );
    }
    // Reads still work, and nothing changed.
    let (err, events) = c.call("list_planner_events", json!({}));
    assert!(!err, "{events}");
    assert_eq!(events, json!([series]));
    let (_, sessions) = c.call("list_planner_work_sessions", json!({}));
    assert_eq!(sessions, json!([session]));
    let (err, _) = c.call(
        "get_planner_calendar",
        json!({ "from": "2026-11-23", "to": "2026-11-29" }),
    );
    assert!(!err);
    let (err, _) = c.call("preview_ical_import", json!({ "content": ICS }));
    assert!(!err);
    let (err, _) = c.call("export_ical", json!({}));
    assert!(!err);
    drop(c);

    // With `planner:`, the same agent may change the calendar.
    let mut c = Client::start_restricted(Some(&vault), &settings, &cache, &["Daily", "planner:"]);
    let id = &series["id"];
    let mut call = |tool: &str, args: Value| {
        let (err, result) = c.call(tool, args);
        assert!(!err, "{tool}: {result}");
        result
    };
    call("create_planner_event", standup());
    call("import_ical", json!({ "content": ICS }));
    let s = call(
        "update_planner_event",
        json!({ "id": id, "expected_revision": 1, "title": "X" }),
    );
    let s = call(
        "cancel_planner_event_occurrence",
        json!({ "series_id": id, "expected_revision": s["revision"], "occurrence_key": "2026-11-30" }),
    );
    call(
        "replace_planner_event_occurrence",
        json!({
            "series_id": id, "expected_revision": s["revision"], "occurrence_key": "2026-12-07",
            "start_value": "2026-12-07T11:00:00+01:00", "end_value": "2026-12-07T11:15:00+01:00"
        }),
    );
    let s = call(
        "archive_planner_event",
        json!({ "id": id, "expected_revision": 4 }),
    );
    let s = call(
        "trash_planner_event",
        json!({ "id": id, "expected_revision": s["revision"] }),
    );
    call(
        "restore_planner_event",
        json!({ "id": id, "expected_revision": s["revision"] }),
    );
    call(
        "create_planner_work_session",
        json!({
            "task_id": session["task_id"], "start_value": "2026-11-24T09:00:00+01:00",
            "end_value": "2026-11-24T10:00:00+01:00", "timezone": "Europe/Paris"
        }),
    );
    let w = call(
        "update_planner_work_session",
        json!({ "id": session["id"], "expected_revision": 1, "end_value": "2026-11-25" }),
    );
    call(
        "cancel_planner_work_session",
        json!({ "id": session["id"], "expected_revision": w["revision"] }),
    );
}
