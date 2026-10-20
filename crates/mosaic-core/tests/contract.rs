//! Runs fixtures/contract.json against the real core. ui/src/ipc/contract.test.ts runs the same
//! scenarios against the browser mock, so the two can't quietly drift apart.

use mosaic_core::history::Source;
use mosaic_core::index::Index;
use mosaic_core::settings::{Access, AgentRule};
use mosaic_core::{Error, Vault, Workspace};
use serde_json::{Value, json};

/// Calls a command the way the app's Tauri command of that name does.
fn call(ws: &Workspace, cmd: &str, a: &Value) -> Result<Value, Error> {
    let s = |k: &str| a[k].as_str().map(str::to_string);
    let path = || s("path").unwrap_or_default();
    let out = match cmd {
        "read_file" => json!(ws.files.read(&path())?),
        "write_file" => json!(ws.files.write(
            &path(),
            &s("content").unwrap(),
            s("expectedHash").as_deref()
        )?),
        "create_file" => json!(ws.files.create(&path(), &s("content").unwrap())?),
        "rename_path" => json!(
            ws.files
                .rename(&s("from").unwrap(), &s("to").unwrap(), true)?
        ),
        "accept_proposal" => json!(ws.review().accept_selected(
            a["id"].as_i64().unwrap(),
            a["force"].as_bool().unwrap_or(false),
            s("content").as_deref(),
        )?),
        "reject_proposal" => {
            ws.review()
                .reject(a["id"].as_i64().unwrap(), s("reason").as_deref())?;
            Value::Null
        }
        other => panic!(
            "contract.rs doesn't know the command {other}; add it here and in contract.test.ts"
        ),
    };
    Ok(out)
}

/// `$last.<field>` and `$proposal` in step arguments.
fn resolve(args: &Value, last: &Value, proposal: Option<i64>) -> Value {
    match args {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), resolve(v, last, proposal)))
                .collect(),
        ),
        Value::String(v) if v == "$proposal" => json!(proposal.expect("no proposal yet")),
        Value::String(v) if v.starts_with("$last.") => last[&v["$last.".len()..]].clone(),
        other => other.clone(),
    }
}

#[test]
fn the_core_follows_the_shared_command_scenarios() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/contract.json")).unwrap();
    for scenario in fixture["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        for (path, content) in scenario["files"].as_object().unwrap() {
            let file = dir.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, content.as_str().unwrap()).unwrap();
        }
        let db = dir.path().join(".history-test.db");
        let open = || {
            Workspace::with_history_file(
                Vault::open(dir.path()).unwrap(),
                Index::in_memory().unwrap(),
                &db,
            )
        };
        let app = open();
        app.sync(|_, _| {}).unwrap();
        let agent = open()
            .with_source(Source::Agent)
            .with_agent_rules(vec![AgentRule {
                path: "Contract".into(),
                access: Access::Review,
                written_as: None,
            }]);

        let (mut last, mut proposal) = (Value::Null, None);
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name}, step {}", i + 1);
            if let Some(p) = step.get("agent_proposes") {
                let written = agent
                    .files
                    .write(
                        p["path"].as_str().unwrap(),
                        p["content"].as_str().unwrap(),
                        None,
                    )
                    .unwrap();
                proposal = Some(
                    written
                        .review
                        .unwrap_or_else(|| panic!("{at}: no proposal")),
                );
                continue;
            }
            let cmd = step["cmd"].as_str().unwrap();
            let result = call(&app, cmd, &resolve(&step["args"], &last, proposal));
            match (step.get("error"), result) {
                (Some(code), Err(e)) => assert_eq!(e.code(), code.as_str().unwrap(), "{at}: {e}"),
                (Some(code), Ok(v)) => panic!("{at}: expected error {code}, got {v}"),
                (None, Err(e)) => panic!("{at}: {e}"),
                (None, Ok(v)) => {
                    if let Some(expect) = step.get("expect") {
                        for (k, want) in expect.as_object().unwrap() {
                            assert_eq!(&v[k], want, "{at}: field {k} of {v}");
                        }
                    }
                    if let Some(want) = step.get("result") {
                        assert_eq!(&v, want, "{at}");
                    }
                    last = v;
                }
            }
        }
    }
}
