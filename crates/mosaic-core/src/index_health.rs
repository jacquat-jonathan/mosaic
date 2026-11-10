//! Local, path-free diagnostics for derived search state. No note content or OS error text is kept.
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum IndexStatus {
    Healthy,
    Rebuilding,
    Degraded,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum IndexProblem {
    WatcherStart,
    WatcherEvent,
    Refresh,
    Scan,
    Freshness,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IndexDiagnostic {
    pub problem: IndexProblem,
    pub error_code: String,
    pub occurred_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IndexHealth {
    pub status: IndexStatus,
    pub watching: bool,
    pub diagnostic: Option<IndexDiagnostic>,
}

pub(crate) struct Health {
    pub snapshot: IndexHealth,
    pub synced_token: Option<String>,
    pub generation: u64,
    pub watcher_required: bool,
}
impl Default for Health {
    fn default() -> Self {
        Self {
            snapshot: IndexHealth {
                status: IndexStatus::Rebuilding,
                watching: false,
                diagnostic: None,
            },
            synced_token: None,
            generation: 0,
            watcher_required: false,
        }
    }
}
impl Health {
    pub fn fail(&mut self, problem: IndexProblem, code: &str) {
        self.synced_token = None;
        self.generation += 1;
        self.snapshot.status = IndexStatus::Degraded;
        // Repeated identical errors do not churn the UI or log timestamps.
        if self
            .snapshot
            .diagnostic
            .as_ref()
            .is_none_or(|d| d.problem != problem || d.error_code != code)
        {
            self.snapshot.diagnostic = Some(IndexDiagnostic {
                problem,
                error_code: code.to_owned(),
                occurred_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Workspace, index::Index, vault::Vault};
    use std::time::Duration;

    fn fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Workspace,
        rusqlite::Connection,
    ) {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let db = cache.path().join("index.db");
        let ws = Workspace::new(
            Vault::open(root.path()).unwrap(),
            Index::open_at(&db).unwrap(),
        );
        let connection = rusqlite::Connection::open(db).unwrap();
        (root, cache, ws, connection)
    }
    fn break_updates(conn: &rusqlite::Connection) {
        conn.execute_batch("CREATE TRIGGER fail_index BEFORE INSERT ON files BEGIN SELECT RAISE(FAIL, 'injected update failure'); END;").unwrap();
    }
    #[test]
    fn failed_note_indexing_preserves_write_invalidates_freshness_and_recovers() {
        let (root, _cache, ws, conn) = fixture();
        ws.sync(|_, _| {}).unwrap();
        ws.heartbeat();
        assert!(ws.index().watched_within(Duration::from_secs(30)));
        break_updates(&conn);
        ws.files.write("note.md", "durable otters", None).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.md")).unwrap(),
            "durable otters"
        );
        assert_eq!(ws.index_health().status, IndexStatus::Degraded);
        assert_eq!(
            ws.index_health().diagnostic.unwrap().problem,
            IndexProblem::Refresh
        );
        ws.heartbeat();
        assert!(!ws.index().watched_within(Duration::from_secs(30)));
        conn.execute_batch("DROP TRIGGER fail_index;").unwrap();
        ws.sync(|_, _| {}).unwrap();
        ws.heartbeat();
        assert_eq!(ws.search("otters", 5).unwrap()[0].path, "note.md");
        assert_eq!(ws.index_health().status, IndexStatus::Healthy);
        assert!(ws.index().watched_within(Duration::from_secs(30)));
    }
    #[test]
    fn another_workspace_cannot_resurrect_a_failed_updates_freshness() {
        let (root, cache, ws, conn) = fixture();
        let other = Workspace::new(
            Vault::open(root.path()).unwrap(),
            Index::open_at(&cache.path().join("index.db")).unwrap(),
        );
        ws.sync(|_, _| {}).unwrap();
        other.sync(|_, _| {}).unwrap();
        other.heartbeat();
        break_updates(&conn);
        ws.files.write("note.md", "otters", None).unwrap();
        other.heartbeat();
        assert!(!ws.index().watched_within(Duration::from_secs(30)));
        assert_eq!(other.index_health().status, IndexStatus::Degraded);
    }
    #[test]
    fn scan_failure_and_failure_during_scan_do_not_signal_success() {
        let (root, _cache, ws, conn) = fixture();
        std::fs::write(root.path().join("note.md"), "otters").unwrap();
        break_updates(&conn);
        assert!(ws.sync(|_, _| {}).is_err());
        assert_eq!(
            ws.index_health().diagnostic.unwrap().problem,
            IndexProblem::Scan
        );
        conn.execute_batch("DROP TRIGGER fail_index;").unwrap();
        let mut injected = false;
        assert!(
            ws.sync(|_, _| {
                if !injected {
                    injected = true;
                    ws.watcher_failed(IndexProblem::WatcherEvent, "overflow");
                }
            })
            .is_err()
        );
        assert_eq!(ws.index_health().status, IndexStatus::Degraded);
        ws.watcher_started();
        ws.sync(|_, _| {}).unwrap();
        assert_eq!(ws.index_health().status, IndexStatus::Healthy);
    }
    #[test]
    fn failed_scan_of_missing_root_remains_degraded_and_recovers() {
        let (root, _cache, ws, _conn) = fixture();
        ws.sync(|_, _| {}).unwrap();
        std::fs::remove_dir(root.path()).unwrap();
        assert!(ws.sync(|_, _| {}).is_err());
        assert_eq!(ws.index_health().status, IndexStatus::Degraded);
        std::fs::create_dir(root.path()).unwrap();
        std::fs::write(root.path().join("recovered.md"), "reconciled otters").unwrap();
        ws.sync(|_, _| {}).unwrap();
        assert_eq!(ws.search("otters", 1).unwrap()[0].path, "recovered.md");
    }
    #[test]
    fn full_rebuild_rereads_unchanged_metadata_and_removes_missing_files() {
        let (root, _cache, ws, conn) = fixture();
        ws.files.write("note.md", "otters", None).unwrap();
        ws.files.write("gone.md", "old", None).unwrap();
        ws.sync(|_, _| {}).unwrap();
        conn.execute("DELETE FROM fts", []).unwrap();
        std::fs::remove_file(root.path().join("gone.md")).unwrap();
        ws.rebuild_index(|_, _| {}).unwrap();
        assert_eq!(ws.search("otters", 1).unwrap()[0].path, "note.md");
        assert!(ws.search("old", 1).unwrap().is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn inaccessible_metadata_is_not_treated_as_a_deleted_note() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _cache, ws, _conn) = fixture();
        std::fs::create_dir(root.path().join("private")).unwrap();
        ws.files.write("private/note.md", "otters", None).unwrap();
        ws.sync(|_, _| {}).unwrap();
        let directory = root.path().join("private");
        let permissions = std::fs::metadata(&directory).unwrap().permissions();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o0)).unwrap();
        let refresh = ws.refresh("private/note.md");
        let scan = ws.sync(|_, _| {});
        std::fs::set_permissions(&directory, permissions).unwrap();
        assert!(
            refresh.is_err(),
            "an inaccessible note must not be deleted from the index"
        );
        assert!(scan.is_err());
        assert_eq!(ws.index_health().status, IndexStatus::Degraded);
        assert_eq!(ws.search("otters", 1).unwrap()[0].path, "private/note.md");
        ws.heartbeat();
        assert!(!ws.index().watched_within(Duration::from_secs(30)));
        ws.sync(|_, _| {}).unwrap();
        assert_eq!(ws.index_health().status, IndexStatus::Healthy);
    }
    #[test]
    fn diagnostics_are_redacted_and_identical_errors_are_debounced() {
        let mut health = Health::default();
        health.fail(IndexProblem::Refresh, "io");
        let before = health.snapshot.clone();
        health.fail(IndexProblem::Refresh, "io");
        assert_eq!(health.snapshot, before);
        assert!(
            !serde_json::to_string(&health.snapshot)
                .unwrap()
                .contains("path")
        );
    }
}
