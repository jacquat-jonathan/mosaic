//! Drives `mosaic mcp` like an MCP client (Claude Code / Claude Desktop) would: JSON-RPC over stdio.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
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
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_mosaic"));
        if let Some(v) = vault {
            cmd.args(["--vault", v.to_str().unwrap()]);
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
            let msg: Value = serde_json::from_str(&line).expect("json line");
            if msg["id"] == json!(id) {
                return msg;
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
    ] {
        assert!(
            names.contains(&expected),
            "missing tool {expected}: {names:?}"
        );
    }

    let (_, guide) = c.call("vault_guide", json!({}));
    assert!(guide.as_str().unwrap().contains("JSON Canvas"));

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
