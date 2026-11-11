//! Real CLI restore is a dry run unless explicitly applied and never needs an active vault.
use std::{fs, process::Command};
#[test]
fn backup_cli_roundtrip_and_dry_run_are_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let vault = temp.path().join("vault");
    fs::create_dir(&vault).unwrap();
    fs::write(vault.join("Note.md"), "persisted").unwrap();
    let bundle = temp.path().join("bundle");
    let restored = temp.path().join("restored");
    let support = temp.path().join("settings");
    let cache = temp.path().join("cache");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_mosaic"))
            .args(args)
            .env_remove("MOSAIC_VAULT")
            .env("MOSAIC_SETTINGS_DIR", &support)
            .env("MOSAIC_CACHE_DIR", &cache)
            .output()
            .unwrap()
    };
    let out = run(&[
        "--vault",
        vault.to_str().unwrap(),
        "--json",
        "backup",
        "create",
        bundle.to_str().unwrap(),
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!vault.join(".mosaic").exists());
    let out = run(&[
        "--json",
        "backup",
        "restore",
        bundle.to_str().unwrap(),
        restored.to_str().unwrap(),
    ]);
    assert!(out.status.success());
    let preview: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(preview["can_restore"], true);
    assert!(!restored.exists());
    let out = run(&[
        "--json",
        "backup",
        "restore",
        bundle.to_str().unwrap(),
        restored.to_str().unwrap(),
        "--apply",
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(fs::read(restored.join("Note.md")).unwrap(), b"persisted");
    let out = run(&[
        "backup",
        "restore",
        bundle.to_str().unwrap(),
        restored.to_str().unwrap(),
        "--apply",
    ]);
    assert!(!out.status.success());
    assert_eq!(fs::read(vault.join("Note.md")).unwrap(), b"persisted");
    assert!(!cache.exists());
}
