//! Watches a vault for changes made outside the app (AI tools, the CLI, other editors, sync), keeps
//! the index current and reports vault-relative paths. Hidden paths such as `.obsidian/` are ignored.

use crate::api::Workspace;
use crate::error::{Error, Result};
use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

/// ~100 ms keeps the change-to-screen budget well inside one second.
pub const DEBOUNCE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Changes {
    /// Vault-relative paths that were created, modified, removed or renamed.
    pub paths: Vec<String>,
    /// Set when the vault folder itself disappeared (unmounted disk, moved folder).
    pub root_missing: bool,
}

/// Stops watching when dropped.
pub struct Watcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

pub fn watch(ws: Arc<Workspace>, on_change: impl Fn(Changes) + Send + 'static) -> Result<Watcher> {
    let root = ws.vault.root().to_path_buf();
    let handler_ws = ws.clone();
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths = BTreeSet::new();
        for ev in &events {
            for p in &ev.paths {
                if let Some(rel) = handler_ws.vault.relative(p)
                    && !rel.is_empty()
                {
                    paths.insert(rel);
                }
            }
        }
        let root_missing = !handler_ws.vault.root().is_dir();
        if paths.is_empty() && !root_missing {
            return;
        }
        for p in &paths {
            let _ = handler_ws.refresh(p);
        }
        on_change(Changes {
            paths: paths.into_iter().collect(),
            root_missing,
        });
    })
    .map_err(|e| Error::Io {
        path: root.display().to_string(),
        source: std::io::Error::other(e.to_string()),
    })?;
    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| Error::Io {
            path: root.display().to_string(),
            source: std::io::Error::other(e.to_string()),
        })?;
    Ok(Watcher {
        _debouncer: debouncer,
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
