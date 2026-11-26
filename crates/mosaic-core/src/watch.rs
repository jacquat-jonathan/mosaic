//! Watches a vault for changes made outside the app (AI tools, the CLI, other editors, sync), keeps
//! the index current and reports vault-relative paths. Hidden paths such as `.obsidian/` are never
//! indexed; they are reported separately, and only while the app shows hidden files.

use crate::api::Workspace;
use crate::error::{Error, Result};
use crate::index_health::IndexProblem;
use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// ~100 ms keeps the change-to-screen budget well inside one second.
pub const DEBOUNCE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Changes {
    /// Vault-relative paths that were created, modified, removed or renamed.
    pub paths: Vec<String>,
    /// Changed hidden paths the app shows ("Show hidden files and folders"), never `.git/` or
    /// `.mosaic/`. Empty while that preference is off. Kept apart from `paths`: they are not
    /// indexed and don't trigger workflows.
    pub hidden_paths: Vec<String>,
    /// Set when the vault folder itself disappeared (unmounted disk, moved folder).
    pub root_missing: bool,
}

/// How often a vault watcher marks the index as kept current (see `Workspace::heartbeat`).
pub const HEARTBEAT: Duration = Duration::from_secs(2);

/// How long the watcher trusts its last read of the "Show hidden files and folders" preference, so
/// a busy hidden folder (`.next/`, `.venv/`) doesn't make it read settings.json on every batch.
const SHOW_HIDDEN_TTL: Duration = Duration::from_secs(2);

/// The watcher's cached copy of `VaultPreferences::show_hidden_files`.
#[derive(Default)]
struct ShowHidden(Mutex<Option<(Instant, bool)>>);

impl ShowHidden {
    fn get(&self, ws: &Workspace) -> bool {
        let mut cached = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, on)) = *cached
            && at.elapsed() < SHOW_HIDDEN_TTL
        {
            return on;
        }
        let on = ws
            .vault_preferences()
            .map(|p| p.show_hidden_files)
            .unwrap_or(false);
        *cached = Some((Instant::now(), on));
        on
    }
}

/// Stops watching when dropped.
pub struct Watcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
    stop: Option<Arc<AtomicBool>>,
    workspace: Option<Arc<Workspace>>,
}

impl Drop for Watcher {
    fn drop(&mut self) {
        if let Some(stop) = &self.stop {
            stop.store(true, Ordering::Relaxed);
        }
        if let Some(ws) = &self.workspace {
            ws.watcher_failed(IndexProblem::WatcherEvent, "stopped");
        }
    }
}

pub fn watch(ws: Arc<Workspace>, on_change: impl Fn(Changes) + Send + 'static) -> Result<Watcher> {
    let root = ws.vault.root().to_path_buf();
    let handler_ws = ws.clone();
    let start = || -> Result<_> {
        let show_hidden = ShowHidden::default();
        let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
            handle_events(
                &handler_ws,
                res,
                &|| show_hidden.get(&handler_ws),
                &on_change,
            );
        })
        .map_err(|e| Error::io("vault watcher", std::io::Error::other(e.to_string())))?;
        debouncer
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| Error::io("vault watcher", std::io::Error::other(e.to_string())))?;
        Ok(debouncer)
    };
    let debouncer = match start() {
        Ok(watcher) => watcher,
        Err(e) => {
            ws.watcher_failed(IndexProblem::WatcherStart, e.code());
            return Err(e);
        }
    };
    ws.watcher_started();
    // While this watcher runs, other processes can rely on the index instead of walking the vault.
    let stop = Arc::new(AtomicBool::new(false));
    let beat = stop.clone();
    let workspace = ws.clone();
    std::thread::spawn(move || {
        while !beat.load(Ordering::Relaxed) {
            ws.heartbeat();
            std::thread::park_timeout(HEARTBEAT);
        }
    });
    Ok(Watcher {
        _debouncer: debouncer,
        stop: Some(stop),
        workspace: Some(workspace),
    })
}

/// A lost/overflowed event is not evidence that the index is current. Keep change notifications
/// flowing even if indexing fails, so successful file edits remain visible and usable.
fn handle_events(
    ws: &Workspace,
    result: DebounceEventResult,
    show_hidden: &dyn Fn() -> bool,
    on_change: &impl Fn(Changes),
) {
    let events = match result {
        Ok(events) => events,
        Err(_) => {
            ws.watcher_failed(IndexProblem::WatcherEvent, "watcher_error");
            return;
        }
    };
    if events.iter().any(|e| e.need_rescan()) {
        ws.watcher_failed(IndexProblem::WatcherEvent, "overflow");
    }
    let (paths, mut hidden_paths) = partition(ws, events.iter().flat_map(|e| &e.paths));
    if !hidden_paths.is_empty() && !show_hidden() {
        hidden_paths.clear();
    }
    let root_missing = !ws.vault.root().is_dir();
    if root_missing {
        ws.watcher_failed(IndexProblem::WatcherEvent, "root_missing");
    }
    if paths.is_empty() && hidden_paths.is_empty() && !root_missing {
        return;
    }
    for path in &paths {
        let _ = ws.refresh(path);
    }
    on_change(Changes {
        paths: paths.into_iter().collect(),
        hidden_paths: hidden_paths.into_iter().collect(),
        root_missing,
    });
}

/// Splits changed absolute paths into vault paths and hidden paths the app can show. Paths outside
/// the vault, the root itself and internal ones (`.git/`, `.mosaic/`) are dropped.
fn partition<'a>(
    ws: &Workspace,
    changed: impl IntoIterator<Item = &'a std::path::PathBuf>,
) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut paths = BTreeSet::new();
    let mut hidden = BTreeSet::new();
    for path in changed {
        if let Some(relative) = ws.vault.relative(path) {
            if !relative.is_empty() {
                paths.insert(relative);
            }
        } else if let Some(relative) = ws.vault.relative_shown(path) {
            hidden.insert(relative);
        }
    }
    (paths, hidden)
}

/// Watches settings.json and each vault's bookmarks and rules, which agents also write (bookmarks
/// through the CLI or MCP), so the app can reload them.
pub fn watch_settings(on_change: impl Fn() + Send + 'static) -> Result<Watcher> {
    let dir = crate::settings::app_support_dir()
        .ok_or_else(|| Error::Invalid("no settings folder (HOME not set)".into()))?;
    let io = |e: std::io::Error| Error::io(dir.display().to_string(), e);
    std::fs::create_dir_all(&dir).map_err(io)?;
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        // Per-vault bookmarks and rules live in `vaults/<id>/`; the scheduler's frequent writes to
        // its own state file there are deliberately not settings changes.
        let watched = [
            crate::settings::SETTINGS_FILE,
            crate::vault_state::BOOKMARKS_FILE,
            crate::vault_state::RULES_FILE,
        ];
        let touched = events.iter().any(|ev| {
            ev.paths.iter().any(|p| {
                p.file_name()
                    .is_some_and(|n| watched.iter().any(|w| n == *w))
            })
        });
        if touched {
            on_change();
        }
    })
    .map_err(|e| io(std::io::Error::other(e.to_string())))?;
    debouncer
        .watch(&dir, RecursiveMode::Recursive)
        .map_err(|e| io(std::io::Error::other(e.to_string())))?;
    Ok(Watcher {
        _debouncer: debouncer,
        stop: None,
        workspace: None,
    })
}

/// Watches the undo history and proposals of the vault at `root` (in Application Support, see
/// `history`), which agents' MCP servers and the CLI write too, so the app can show new proposals
/// as they arrive instead of asking every few seconds. `None` when the vault has no id yet.
pub fn watch_history(
    root: &std::path::Path,
    on_change: impl Fn() + Send + 'static,
) -> Result<Option<Watcher>> {
    let Some(vault) = crate::vault_id::peek(root)? else {
        return Ok(None);
    };
    let dir = crate::settings::app_support_dir()
        .ok_or_else(|| Error::Invalid("no settings folder (HOME not set)".into()))?
        .join("vaults")
        .join(vault.id);
    watch_files(&dir, &["history.db", "history.db-wal"], on_change).map(Some)
}

/// Watches the planner database inside a vault so changes made by an MCP server or the CLI can be
/// pushed into the open app instead of waiting for the Board or Calendar to be reopened.
pub fn watch_planner(
    root: &std::path::Path,
    on_change: impl Fn() + Send + 'static,
) -> Result<Watcher> {
    watch_directory(&root.join(".mosaic"), on_change)
}

/// Calls `on_change` (debounced) when anything immediately inside `dir` changes.
fn watch_directory(
    dir: &std::path::Path,
    on_change: impl Fn() + Send + 'static,
) -> Result<Watcher> {
    let io = |e: std::io::Error| Error::io(dir.display().to_string(), e);
    std::fs::create_dir_all(dir).map_err(io)?;
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
        if res.is_ok_and(|events| !events.is_empty()) {
            on_change();
        }
    })
    .map_err(|e| io(std::io::Error::other(e.to_string())))?;
    debouncer
        .watch(dir, RecursiveMode::NonRecursive)
        .map_err(|e| io(std::io::Error::other(e.to_string())))?;
    Ok(Watcher {
        _debouncer: debouncer,
        stop: None,
        workspace: None,
    })
}

/// Calls `on_change` (debounced) when a file named one of `names` in `dir` changes.
fn watch_files(
    dir: &std::path::Path,
    names: &'static [&'static str],
    on_change: impl Fn() + Send + 'static,
) -> Result<Watcher> {
    let io = |e: std::io::Error| Error::io(dir.display().to_string(), e);
    std::fs::create_dir_all(dir).map_err(io)?;
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        if events.iter().any(|ev| {
            ev.paths
                .iter()
                .any(|p| p.file_name().is_some_and(|n| names.iter().any(|w| n == *w)))
        }) {
            on_change();
        }
    })
    .map_err(|e| io(std::io::Error::other(e.to_string())))?;
    debouncer
        .watch(dir, RecursiveMode::NonRecursive)
        .map_err(|e| io(std::io::Error::other(e.to_string())))?;
    Ok(Watcher {
        _debouncer: debouncer,
        stop: None,
        workspace: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Index;
    use crate::vault::Vault;
    use std::sync::mpsc;
    use std::time::Instant;

    #[test]
    fn watcher_start_and_event_failures_invalidate_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Arc::new(Workspace::new(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
        ));
        ws.sync(|_, _| {}).unwrap();
        handle_events(
            &ws,
            Err(vec![notify::Error::generic("private path hidden")]),
            &|| false,
            &|_| {},
        );
        assert_eq!(
            ws.index_health().status,
            crate::index_health::IndexStatus::Degraded
        );
        assert_eq!(
            ws.index_health().diagnostic.unwrap().problem,
            IndexProblem::WatcherEvent
        );
        ws.watcher_started();
        ws.sync(|_, _| {}).unwrap();
        handle_events(
            &ws,
            Ok(vec![notify_debouncer_full::DebouncedEvent::new(
                notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan),
                Instant::now(),
            )]),
            &|| false,
            &|_| {},
        );
        assert_eq!(ws.index_health().diagnostic.unwrap().error_code, "overflow");
        assert!(!ws.index_health().watching);
        std::fs::remove_dir(dir.path()).unwrap();
        assert!(watch(ws.clone(), |_| {}).is_err());
        assert_eq!(
            ws.index_health().diagnostic.unwrap().problem,
            IndexProblem::WatcherStart
        );
        std::fs::create_dir(dir.path()).unwrap();
        let _watcher = watch(ws.clone(), |_| {}).unwrap();
        ws.sync(|_, _| {}).unwrap();
        assert_eq!(
            ws.index_health().status,
            crate::index_health::IndexStatus::Healthy
        );
    }

    fn changed(paths: &[std::path::PathBuf]) -> DebounceEventResult {
        let mut event = notify::Event::new(notify::EventKind::Any);
        for path in paths {
            event = event.add_path(path.clone());
        }
        Ok(vec![notify_debouncer_full::DebouncedEvent::new(
            event,
            Instant::now(),
        )])
    }

    #[test]
    fn hidden_changes_are_reported_apart_only_when_shown_and_never_indexed() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
        );
        let root = ws.vault.root().to_path_buf();
        let paths = [
            root.join("note.md"),
            root.join(".claude/settings.json"),
            root.join("a/.github/ci.yml"),
            root.join(".git/index"),
            root.join(".mosaic/planner.sqlite3"),
            root.join("a/.mosaic-x.tmp"),
            root.join(".DS_Store"),
        ];
        let (plain, hidden) = partition(&ws, &paths);
        assert_eq!(plain.into_iter().collect::<Vec<_>>(), vec!["note.md"]);
        assert_eq!(
            hidden.into_iter().collect::<Vec<_>>(),
            vec![".claude/settings.json", "a/.github/ci.yml"]
        );

        let seen = Mutex::new(Vec::new());
        let record = |c: Changes| seen.lock().unwrap().push(c);
        handle_events(&ws, changed(&paths[1..]), &|| true, &record);
        handle_events(&ws, changed(&paths[1..]), &|| false, &record);
        handle_events(&ws, changed(&paths[3..]), &|| true, &record);
        let seen = seen.into_inner().unwrap();
        // Shown: reported apart from `paths`; off, or only internal paths: nothing at all.
        assert_eq!(seen.len(), 1);
        assert!(seen[0].paths.is_empty());
        assert_eq!(
            seen[0].hidden_paths,
            vec![".claude/settings.json", "a/.github/ci.yml"]
        );
    }

    #[test]
    fn a_changed_history_database_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = watch_files(dir.path(), &["history.db", "history.db-wal"], move || {
            let _ = tx.send(());
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(dir.path().join("other.json"), "{}").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(600)).is_err());
        let history = crate::history::History::open_at(&dir.path().join("history.db")).unwrap();
        history
            .begin_rename("a.md", "b.md", &["c.md".to_string()])
            .unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn a_changed_planner_database_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let mut planner = crate::planner::PlannerStore::open(dir.path()).unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch_planner(dir.path(), move || {
            let _ = tx.send(());
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        planner
            .create_task(crate::planner::CreateTask {
                epic_id: None,
                parent_id: None,
                title: "From an agent".into(),
                description: String::new(),
                status: crate::planner::TaskStatus::New,
                due_date: None,
                estimate_minutes: None,
            })
            .unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn external_changes_are_reported_and_indexed_within_a_second() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Arc::new(Workspace::new(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
        ));
        ws.sync(|_, _| {}).unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = watch(ws.clone(), move |c| {
            let _ = tx.send(c);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(200)); // let FSEvents start

        let start = Instant::now();
        std::fs::write(
            dir.path().join("From AI.md"),
            "Written by an agent about #otters",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join(".obsidian")).unwrap();
        std::fs::write(dir.path().join(".obsidian/workspace.json"), "{}").unwrap();
        let mut seen = Vec::new();
        while start.elapsed() < Duration::from_secs(3) {
            if let Ok(c) = rx.recv_timeout(Duration::from_millis(50)) {
                seen.extend(c.paths);
                if seen.iter().any(|p| p == "From AI.md") {
                    break;
                }
            }
        }
        let took = start.elapsed();
        assert!(seen.iter().any(|p| p == "From AI.md"), "saw {seen:?}");
        assert!(seen.iter().all(|p| !p.starts_with(".obsidian")));
        assert!(took < Duration::from_secs(1), "took {took:?}");
        assert_eq!(ws.search("otters", 5).unwrap()[0].path, "From AI.md");
    }
}
