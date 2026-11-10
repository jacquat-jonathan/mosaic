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
        "planner_create_task" => json!(
            ws.planner
                .create_task(serde_json::from_value(a["input"].clone()).unwrap())?
        ),
        "planner_update_task" => json!(ws.planner.update_task(
            &s("id").unwrap(),
            serde_json::from_value(a["input"].clone()).unwrap()
        )?),
        "planner_tasks" => json!(ws.planner.tasks(
            a["includeArchived"].as_bool().unwrap_or(false),
            a["includeTrashed"].as_bool().unwrap_or(false)
        )?),
        "planner_complete_task" => json!(ws.planner.complete_task(
            &s("id").unwrap(),
            a["expectedRevision"].as_i64().unwrap(),
            a["allowIncompleteSubtasks"].as_bool().unwrap_or(false),
            serde_json::from_value(a["futureSessions"].clone()).unwrap()
        )?),
        "planner_reopen_task" => json!(
            ws.planner
                .reopen_task(&s("id").unwrap(), a["expectedRevision"].as_i64().unwrap())?
        ),
        "planner_archive_task" => json!(
            ws.planner
                .archive_task(&s("id").unwrap(), a["expectedRevision"].as_i64().unwrap())?
        ),
        "planner_trash_task" => json!(
            ws.planner
                .trash_task(&s("id").unwrap(), a["expectedRevision"].as_i64().unwrap())?
        ),
        "planner_restore_task" => json!(
            ws.planner
                .restore_task(&s("id").unwrap(), a["expectedRevision"].as_i64().unwrap())?
        ),
        "render_template" => {
            json!(ws.render_template(&serde_json::from_value(a["request"].clone()).unwrap())?)
        }
        "create_note" => {
            json!(ws.create_note(&serde_json::from_value(a["request"].clone()).unwrap())?)
        }
        "query_notes" => json!(ws.query(&s("query").unwrap())?),
        "import_file" => json!(
            ws.files.import(
                &path(),
                &a["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u8)
                    .collect::<Vec<_>>()
            )?
        ),
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
fn resolve(args: &Value, last: &Value, proposal: Option<i64>, saved: &Value) -> Value {
    match args {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), resolve(v, last, proposal, saved)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| resolve(v, last, proposal, saved))
                .collect(),
        ),
        Value::String(v) if v == "$proposal" => json!(proposal.expect("no proposal yet")),
        Value::String(v) if v.starts_with("$last.") => lookup(last, &v["$last.".len()..]).clone(),
        Value::String(v) if v.starts_with("$saved.") => lookup(saved, &v[7..]).clone(),
        other => other.clone(),
    }
}

fn lookup<'a>(value: &'a Value, path: &str) -> &'a Value {
    path.split('.').fold(value, |v, key| {
        v.get(key)
            .or_else(|| key.parse::<usize>().ok().and_then(|i| v.get(i)))
            .unwrap_or_else(|| panic!("unknown fixture reference: {path}"))
    })
}

fn assert_subset(actual: &Value, expected: &Value, at: &str) {
    match expected {
        Value::Object(map) => {
            for (key, value) in map {
                assert_subset(
                    actual
                        .get(key)
                        .unwrap_or_else(|| panic!("{at}: missing field {key}")),
                    value,
                    at,
                );
            }
        }
        Value::Array(items) => {
            assert_eq!(
                actual.as_array().map(Vec::len),
                Some(items.len()),
                "{at}: {actual}"
            );
            for (i, value) in items.iter().enumerate() {
                assert_subset(&actual[i], value, at);
            }
        }
        _ => assert_eq!(actual, expected, "{at}"),
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
        let support = tempfile::tempdir().unwrap();
        let db = support.path().join("history.db");
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

        let mut saved = json!({});
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
            if let Some(path) = step.get("external_directory") {
                let path = dir.path().join(path.as_str().unwrap());
                std::fs::remove_file(&path).unwrap();
                std::fs::create_dir(&path).unwrap();
                continue;
            }
            let restricted = open().with_source(Source::Agent).with_agent_rules(
                serde_json::from_value(scenario.get("rules").cloned().unwrap_or(json!([])))
                    .unwrap(),
            );
            let target = if step["actor"] == "agent" {
                &restricted
            } else {
                &app
            };
            let cmd = step["cmd"].as_str().unwrap();
            let result = call(
                target,
                cmd,
                &resolve(&step["args"], &last, proposal, &saved),
            );
            match (step.get("error"), result) {
                (Some(code), Err(e)) => assert_eq!(e.code(), code.as_str().unwrap(), "{at}: {e}"),
                (Some(code), Ok(v)) => panic!("{at}: expected error {code}, got {v}"),
                (None, Err(e)) => panic!("{at}: {e}"),
                (None, Ok(v)) => {
                    if let Some(expect) = step.get("expect") {
                        assert_subset(&v, &resolve(expect, &last, proposal, &saved), &at);
                    }
                    if let Some(want) = step.get("result") {
                        assert_eq!(v, resolve(want, &last, proposal, &saved), "{at}");
                    }
                    if let Some(key) = step["save"].as_str() {
                        saved[key] = v.clone();
                    }
                    last = v;
                }
            }
        }
    }
}
