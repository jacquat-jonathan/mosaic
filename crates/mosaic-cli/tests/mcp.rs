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
        let mut child = Command::new(env!("CARGO_BIN_EXE_mosaic"))
            .args(["--vault", vault.to_str().unwrap(), "mcp"])
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
        "delete_file",
        "create_folder",
        "get_backlinks",
        "list_tags",
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

    let (_, renamed) = c.call(
        "rename",
        json!({ "from": "AI/Summary.md", "to": "AI/Overview.md" }),
    );
    assert_eq!(renamed["path"], "AI/Overview.md");
    let (_, board) = c.call("read_file", json!({ "path": "AI/Board.canvas" }));
    assert!(
        board["content"]
            .as_str()
            .unwrap()
            .contains("AI/Overview.md")
    );

    let (err, payload) = c.call("read_file", json!({ "path": "../outside.md" }));
    assert!(err);
    assert_eq!(payload["code"], "invalid_path");

    let (err, _) = c.call("create_folder", json!({ "path": "AI/Later" }));
    assert!(!err);
    assert!(dir.path().join("AI/Later").is_dir());
}
