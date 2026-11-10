//! Real generated command dispatch/serialization on Tauri's test runtime. This is not WKWebView
//! coverage; docs/BEHAVIORAL_CONTRACTS.md separates it from the packaged smoke lane.
use super::*;
use mosaic_core::{Vault, index::Index};
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;

struct Host {
    _vault: tempfile::TempDir,
    _support: tempfile::TempDir,
    _app: tauri::App<MockRuntime>,
    window: tauri::WebviewWindow<MockRuntime>,
}
impl Host {
    fn new() -> Self {
        let vault = tempfile::tempdir().unwrap();
        let support = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("Note.md"), "before").unwrap();
        let ws = Workspace::with_history_file(
            Vault::open(vault.path()).unwrap(),
            Index::in_memory().unwrap(),
            &support.path().join("history.db"),
        );
        let state = AppState::default();
        state.install(Arc::new(ws));
        let app = mock_builder()
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                read_file,
                write_file,
                import_file,
                render_template,
                create_note,
                query_notes
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            _vault: vault,
            _support: support,
            _app: app,
            window,
        }
    }
    fn request(&self, cmd: &str, body: InvokeBody, header: Option<&str>) -> Result<Value, Value> {
        let mut headers = tauri::http::HeaderMap::new();
        if let Some(path) = header {
            headers.insert("x-path", path.parse().unwrap());
        }
        get_ipc_response(
            &self.window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    }
    fn json(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        self.request(cmd, InvokeBody::Json(args), None)
    }
}

#[test]
fn dispatch_honors_camel_case_hash_and_serializes_conflict() {
    let host = Host::new();
    let read = host.json("read_file", json!({"path":"Note.md"})).unwrap();
    let written = host
        .json(
            "write_file",
            json!({"path":"Note.md", "content":"after", "expectedHash":read["hash"], "root":null}),
        )
        .unwrap();
    let rejected = host
        .json(
            "write_file",
            json!({"path":"Note.md", "content":"lost", "expectedHash":read["hash"], "root":null}),
        )
        .unwrap_err();
    assert_eq!(rejected["code"], "conflict");
    assert_eq!(rejected["current_hash"], written["hash"]);
    assert!(rejected["message"].as_str().unwrap().contains("Note.md"));
    assert_eq!(
        host.json("read_file", json!({"path":"Note.md"})).unwrap()["content"],
        "after"
    );
    assert!(
        host.json("read_file", json!({"wrongKey":"Note.md"}))
            .is_err()
    );
    assert!(host.json("unknown_contract_command", json!({})).is_err());
}

#[test]
fn raw_import_routes_bytes_and_percent_decoded_header_without_json() {
    let host = Host::new();
    let bytes = vec![137, 80, 78, 71, 0, 255];
    let saved = host
        .request(
            "import_file",
            InvokeBody::Raw(bytes.clone()),
            Some("caf%C3%A9%20image.png"),
        )
        .unwrap();
    assert_eq!(saved["path"], "café image.png");
    assert_eq!(
        std::fs::read(host._vault.path().join("café image.png")).unwrap(),
        bytes
    );
    let duplicate = host
        .request(
            "import_file",
            InvokeBody::Raw(vec![1]),
            Some("caf%C3%A9%20image.png"),
        )
        .unwrap();
    assert_eq!(duplicate["path"], "café image 1.png");
    for (body, header, code) in [
        (
            InvokeBody::Json(json!([0, 255])),
            Some("file.png"),
            "invalid",
        ),
        (InvokeBody::Raw(vec![0]), None, "invalid"),
        (InvokeBody::Raw(vec![0]), Some("bad%GG.png"), "invalid"),
        (
            InvokeBody::Raw(vec![0]),
            Some("%2E%2E%2Fescape.png"),
            "invalid_path",
        ),
    ] {
        assert_eq!(
            host.request("import_file", body, header).unwrap_err()["code"],
            code
        );
    }
}

#[test]
fn nested_template_request_reaches_real_handler() {
    let host = Host::new();
    std::fs::create_dir(host._vault.path().join("Templates")).unwrap();
    std::fs::write(host._vault.path().join("Templates/Note.md"), "# {{title}}").unwrap();
    let request =
        json!({"path":"Made.md","template":"Templates/Note.md","timestamp":"2026-11-05T12:00:00Z"});
    let preview = host
        .json("render_template", json!({"request":request}))
        .unwrap();
    assert_eq!(preview["content"], "# Made");
    std::fs::write(host._vault.path().join("Templates/Note.md"), "changed").unwrap();
    let mut stale = request;
    stale["expected_template_hash"] = preview["template_hash"].clone();
    assert_eq!(
        host.json("create_note", json!({"request":stale}))
            .unwrap_err()["code"],
        "conflict"
    );
    assert!(!host._vault.path().join("Made.md").exists());
}

#[test]
fn event_payloads_serialize_through_tauri_emitter() {
    use tauri::Listener;
    let fixture: Value = serde_json::from_str(include_str!("../../fixtures/events.json")).unwrap();
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    let received = Arc::new(Mutex::new(Vec::new()));
    for name in ["index-progress", "vault-changed", "history-changed"] {
        let received = received.clone();
        app.listen(name, move |event| {
            received.lock().unwrap().push((
                name,
                serde_json::from_str::<Value>(event.payload()).unwrap(),
            ))
        });
    }
    let session = crate::VaultSession::mock();
    app.emit(
        "index-progress",
        IndexProgress {
            session: session.clone(),
            done: 2,
            total: 3,
            finished: false,
            failed: false,
        },
    )
    .unwrap();
    app.emit(
        "vault-changed",
        crate::VaultChanges {
            session: session.clone(),
            changes: mosaic_core::watch::Changes {
                paths: vec!["Note.md".into()],
                root_missing: false,
            },
        },
    )
    .unwrap();
    app.emit("history-changed", &session).unwrap();
    for (name, payload) in received.lock().unwrap().iter() {
        assert_eq!(payload, &fixture[name]);
    }
    assert_eq!(received.lock().unwrap().len(), 3);
}
