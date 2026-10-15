//! A plain `#[tauri::command] fn` runs on the main thread, which on macOS is also the UI event
//! loop: a slow disk, SQLite or process call there freezes the window. Every command must be
//! `#[tauri::command(async)]` (or an `async fn`), except the few that must touch the window.

/// Commands that must stay on the main thread.
const MAIN_THREAD: &[&str] = &["print_window"];

#[test]
fn every_command_runs_off_the_main_thread() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut blocking = Vec::new();
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let mut lines = text.lines();
        while let Some(line) = lines.next() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            // The signature: skip further attributes up to the `fn` line.
            let sig = lines
                .by_ref()
                .find(|l| l.contains("fn "))
                .unwrap_or_default();
            let name = sig
                .split("fn ")
                .nth(1)
                .and_then(|r| r.split(['(', '<']).next())
                .unwrap_or_default()
                .trim();
            if !sig.contains("async fn") && !MAIN_THREAD.contains(&name) {
                blocking.push(format!(
                    "{}: {name}",
                    path.file_name().unwrap().to_string_lossy()
                ));
            }
        }
    }
    assert!(
        blocking.is_empty(),
        "these commands run on the main thread; use #[tauri::command(async)]:\n{}",
        blocking.join("\n")
    );
}
