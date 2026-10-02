//! Runs the `mosaic` command line against a copy of the fixture vault, like a script or a shell
//! agent would: subcommands, exit codes and JSON output.

use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

fn mosaic(vault: &Path, args: &[&str], stdin: Option<&str>) -> Out {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mosaic"))
        .arg("--vault")
        .arg(vault)
        .args(args)
        .env("MOSAIC_CACHE_DIR", vault.join(".test-cache"))
        .env("MOSAIC_SETTINGS_DIR", vault.join(".test-settings"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run mosaic");
    {
        let mut pipe = child.stdin.take().unwrap();
        if let Some(text) = stdin {
            pipe.write_all(text.as_bytes()).unwrap();
        }
    }
    let out = child.wait_with_output().unwrap();
    Out {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

fn json(vault: &Path, args: &[&str]) -> Value {
    let mut all = vec!["--json"];
    all.extend_from_slice(args);
    let out = mosaic(vault, &all, None);
    assert_eq!(out.code, 0, "{args:?}: {}", out.stderr);
    serde_json::from_str(&out.stdout)
        .unwrap_or_else(|e| panic!("{args:?} printed no JSON ({e}): {}", out.stdout))
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vault");
    assert!(
        Command::new("cp")
            .arg("-R")
            .arg(format!("{}/.", src.display()))
            .arg(dir.path())
            .status()
            .unwrap()
            .success()
    );
    dir
}

#[test]
fn create_read_append_and_patch() {
    let dir = fixture();
    let v = dir.path();
    assert_eq!(
        mosaic(v, &["create", "Notes/New.md"], Some("# New\nhello hello")).code,
        0
    );
    assert_eq!(
        mosaic(v, &["read", "Notes/New.md"], None).stdout.trim(),
        "# New\nhello hello"
    );
    assert_eq!(
        mosaic(v, &["append", "Notes/New.md", "--content", "more"], None).code,
        0
    );
    assert!(
        std::fs::read_to_string(v.join("Notes/New.md"))
            .unwrap()
            .ends_with("hello hello\nmore")
    );

    // The text occurs twice: refused, with a message saying so, and the file is untouched.
    let twice = mosaic(
        v,
        &[
            "patch",
            "Notes/New.md",
            "--find",
            "hello",
            "--replace",
            "bye",
        ],
        None,
    );
    assert_eq!(twice.code, 1);
    assert!(twice.stderr.contains("occurs 2 times"), "{}", twice.stderr);
    assert_eq!(
        mosaic(
            v,
            &[
                "patch",
                "Notes/New.md",
                "--find",
                "hello hello",
                "--replace",
                "bye"
            ],
            None
        )
        .code,
        0
    );

    // A file that already exists isn't overwritten by create.
    let again = mosaic(
        v,
        &["--json", "create", "Notes/New.md", "--content", "x"],
        None,
    );
    assert_eq!(again.code, 1);
    assert_eq!(
        serde_json::from_str::<Value>(&again.stderr).unwrap()["code"],
        "already_exists"
    );
}

#[test]
fn a_stale_hash_is_a_conflict_with_exit_code_3() {
    let dir = fixture();
    let v = dir.path();
    let read = json(v, &["read", "Ideas.md"]);
    let hash = read["hash"].as_str().unwrap().to_string();
    std::fs::write(v.join("Ideas.md"), "changed by someone else").unwrap();
    let out = mosaic(
        v,
        &[
            "--json",
            "write",
            "Ideas.md",
            "--content",
            "mine",
            "--expected-hash",
            &hash,
        ],
        None,
    );
    assert_eq!(out.code, 3);
    assert_eq!(
        serde_json::from_str::<Value>(&out.stderr).unwrap()["code"],
        "conflict"
    );
    assert_eq!(
        std::fs::read_to_string(v.join("Ideas.md")).unwrap(),
        "changed by someone else"
    );
    assert_eq!(
        mosaic(v, &["read", "Nope.md"], None).code,
        2,
        "not found exits with 2"
    );
}

#[test]
fn renaming_a_folder_keeps_links_between_and_into_its_notes() {
    let dir = fixture();
    let v = dir.path();
    std::fs::create_dir_all(v.join("Team")).unwrap();
    std::fs::write(
        v.join("Team/Alice.md"),
        "Works with [[Team/Bob]] and [Bob](Bob.md)",
    )
    .unwrap();
    std::fs::write(v.join("Team/Bob.md"), "Works with [[Team/Alice]]").unwrap();
    std::fs::write(v.join("Roster.md"), "See [[Team/Alice]]").unwrap();
    let out = json(v, &["rename", "Team", "People"]);
    assert_eq!(out["path"], "People");
    let alice = std::fs::read_to_string(v.join("People/Alice.md")).unwrap();
    assert!(
        alice.contains("[[People/Bob]]") || alice.contains("[[Bob]]"),
        "{alice}"
    );
    assert!(
        alice.contains("(Bob.md)"),
        "a relative link between moved notes still works: {alice}"
    );
    let roster = std::fs::read_to_string(v.join("Roster.md")).unwrap();
    assert!(
        roster.contains("People/Alice") || roster.contains("[[Alice]]"),
        "{roster}"
    );
}

#[test]
fn move_history_restore_and_render() {
    let dir = fixture();
    let v = dir.path();
    let moved = json(v, &["move", "Ideas.md", "Home.md", "--to", "Archive"]);
    assert_eq!(moved.as_array().unwrap().len(), 2);
    assert!(v.join("Archive/Ideas.md").exists());

    let original = std::fs::read_to_string(v.join("Archive/Ideas.md")).unwrap();
    mosaic(
        v,
        &["write", "Archive/Ideas.md", "--content", "overwritten"],
        None,
    );
    let history = json(v, &["history", "Archive/Ideas.md"]);
    let before = history
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["action"] == "before")
        .expect("the version before the write");
    let id = before["id"].as_i64().unwrap().to_string();
    assert_eq!(
        mosaic(v, &["restore", "Archive/Ideas.md", &id], None).code,
        0
    );
    assert_eq!(
        std::fs::read_to_string(v.join("Archive/Ideas.md")).unwrap(),
        original
    );
    // CLI changes show up in the activity log, and can be undone.
    let activity = json(v, &["activity"]);
    assert!(
        activity
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["source"] == "cli" && a["action"] == "restored")
    );

    let svg = v.join("board.svg");
    assert_eq!(
        mosaic(
            v,
            &["render", "Board.canvas", "-o", svg.to_str().unwrap()],
            None
        )
        .code,
        0
    );
    assert!(std::fs::read_to_string(&svg).unwrap().starts_with("<svg"));
    assert_eq!(
        mosaic(v, &["render", "Home.md"], None).code,
        2,
        "Home.md moved: not found"
    );
}
