//! File history: every change made through Mosaic (app, CLI, MCP agents) keeps a version of the file,
//! so a bad edit — by a person or an agent — can be looked at and undone. Stored per vault in
//! `history.db` next to the search index (a cache folder, never the vault), shared by the app and
//! the CLI through SQLite's WAL mode.

use crate::error::{Error, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Versions kept per file (the newest are kept).
const KEEP_PER_FILE: i64 = 50;
/// Versions older than this are dropped, except each file's newest one.
const KEEP_DAYS: i64 = 60;
/// The app's autosaves to one file within this window become a single version.
const COALESCE_MS: i64 = 10 * 60 * 1000;
/// Text files above this size get no history.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

/// Who made a change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// The Mosaic app (a person).
    App,
    /// The `mosaic` command line.
    Cli,
    /// An AI agent over MCP.
    Agent,
    /// Another program (an editor, Obsidian, git…), noticed by the app's file watcher.
    External,
}

impl Source {
    pub(crate) fn parse(s: &str) -> Source {
        match s {
            "app" => Source::App,
            "cli" => Source::Cli,
            "external" => Source::External,
            _ => Source::Agent,
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Source::App => "app",
            Source::Cli => "cli",
            Source::Agent => "agent",
            Source::External => "external",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// The file as it was before Mosaic first changed it (or after another program did).
    Before,
    Created,
    Edited,
    Deleted,
    Renamed,
    Restored,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Action::Before => "before",
            Action::Created => "created",
            Action::Edited => "edited",
            Action::Deleted => "deleted",
            Action::Renamed => "renamed",
            Action::Restored => "restored",
        }
    }
}

/// One version of a file (its content is fetched separately with [`History::content`]).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Version {
    pub id: i64,
    pub path: String,
    /// Milliseconds since the Unix epoch.
    pub time: i64,
    pub source: String,
    /// The agent or client name (e.g. "claude-code"), when known.
    pub actor: Option<String>,
    pub action: String,
    /// Content hash (empty for renames).
    pub hash: String,
    pub size: i64,
    /// For renames: where the file came from.
    pub from_path: Option<String>,
}

pub struct History {
    pub(crate) conn: Connection,
}

fn sql_err(e: rusqlite::Error) -> Error {
    Error::Io {
        path: "history".into(),
        source: std::io::Error::other(e.to_string()),
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn default_db_path(vault_root: &Path) -> Option<PathBuf> {
    crate::index::default_db_path(vault_root).map(|p| p.with_file_name("history.db"))
}

impl History {
    pub fn open_for(vault_root: &Path) -> Result<Self> {
        let db =
            default_db_path(vault_root).ok_or_else(|| Error::Invalid("HOME is not set".into()))?;
        if let Some(dir) = db.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::io(dir.display().to_string(), e))?;
        }
        Self::init(Connection::open(db).map_err(sql_err)?)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory().map_err(sql_err)?)
    }

    /// A history in a given database file (tests where two workspaces share one history).
    pub fn open_at(db: &Path) -> Result<Self> {
        Self::init(Connection::open(db).map_err(sql_err)?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(sql_err)?;
        crate::index::retry_busy(|| conn.pragma_update(None, "journal_mode", "WAL"))
            .map_err(sql_err)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, time INTEGER NOT NULL,
                source TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, hash TEXT NOT NULL,
                size INTEGER NOT NULL, content TEXT, from_path TEXT);
             CREATE INDEX IF NOT EXISTS versions_path ON versions(path, id);
             CREATE INDEX IF NOT EXISTS versions_source ON versions(source, id);
             CREATE TABLE IF NOT EXISTS proposals (
                id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, action TEXT NOT NULL,
                base_hash TEXT, content TEXT, hash TEXT, source TEXT NOT NULL, actor TEXT,
                created INTEGER NOT NULL, updated INTEGER NOT NULL, status TEXT NOT NULL,
                reason TEXT, decided INTEGER);
             CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status, path);",
        )
        .map_err(sql_err)?;
        // Added in 0.9.1: what an accepted proposal overwrote, and the change it made (for Undo).
        for (col, ty) in [
            ("overwrote", "INTEGER NOT NULL DEFAULT 0"),
            ("version_id", "INTEGER"),
            ("binary", "INTEGER NOT NULL DEFAULT 0"),
            ("to_path", "TEXT"),
            ("update_links", "INTEGER NOT NULL DEFAULT 1"),
        ] {
            let has: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('proposals') WHERE name = ?1",
                    [col],
                    |r| r.get(0),
                )
                .map_err(sql_err)?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE proposals ADD COLUMN {col} {ty}"))
                    .map_err(sql_err)?;
            }
        }
        let h = History { conn };
        h.prune()?;
        Ok(h)
    }

    fn row(r: &rusqlite::Row) -> rusqlite::Result<Version> {
        Ok(Version {
            id: r.get(0)?,
            path: r.get(1)?,
            time: r.get(2)?,
            source: r.get(3)?,
            actor: r.get(4)?,
            action: r.get(5)?,
            hash: r.get(6)?,
            size: r.get(7)?,
            from_path: r.get(8)?,
        })
    }

    const COLUMNS: &'static str = "id, path, time, source, actor, action, hash, size, from_path";

    /// The newest version of `path` that has content (not a rename marker).
    pub fn latest(&self, path: &str) -> Result<Option<Version>> {
        self.conn
            .query_row(
                &format!("SELECT {} FROM versions WHERE path = ?1 AND action != 'renamed' ORDER BY id DESC LIMIT 1", Self::COLUMNS),
                [path],
                Self::row,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Before Mosaic changes a file: keeps its current content if the history doesn't have it yet
    /// (first change through Mosaic, or another program changed it since).
    pub fn keep_before(
        &self,
        path: &str,
        content: &str,
        hash: &str,
        source: &Source,
    ) -> Result<()> {
        if content.len() > MAX_BYTES {
            return Ok(());
        }
        match self.latest(path)? {
            Some(v) if v.hash == hash && v.action != "deleted" => Ok(()),
            _ => self.insert(
                path,
                Some(content),
                hash,
                source,
                None,
                Action::Before,
                None,
            ),
        }
    }

    /// Records a change. The app's repeated autosaves of one file merge into one version.
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &self,
        path: &str,
        content: Option<&str>,
        hash: &str,
        source: &Source,
        actor: Option<&str>,
        action: Action,
        from: Option<&str>,
    ) -> Result<()> {
        if content.is_some_and(|c| c.len() > MAX_BYTES) {
            return Ok(());
        }
        let latest = self.latest(path)?;
        if let Some(v) = &latest {
            if action == Action::Edited && v.hash == hash {
                return Ok(());
            }
            if action == Action::Edited
                && *source == Source::App
                && v.source == "app"
                && (v.action == "edited" || v.action == "created")
                && now_ms() - v.time < COALESCE_MS
            {
                self.conn
                    .execute(
                        "UPDATE versions SET content = ?1, hash = ?2, size = ?3, time = ?4 WHERE id = ?5",
                        params![content, hash, content.map_or(0, |c| c.len() as i64), now_ms(), v.id],
                    )
                    .map_err(sql_err)?;
                return Ok(());
            }
        }
        self.insert(path, content, hash, source, actor, action, from)?;
        self.prune_path(path)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert(
        &self,
        path: &str,
        content: Option<&str>,
        hash: &str,
        source: &Source,
        actor: Option<&str>,
        action: Action,
        from: Option<&str>,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO versions (path, time, source, actor, action, hash, size, content, from_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![path, now_ms(), source.as_str(), actor, action.as_str(), hash, content.map_or(0, |c| c.len() as i64), content, from],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// A file or folder moved: its history follows it, and the move itself is recorded once.
    pub fn renamed(
        &self,
        from: &str,
        to: &str,
        source: &Source,
        actor: Option<&str>,
    ) -> Result<i64> {
        self.conn
            .execute(
                "UPDATE versions SET path = ?2 || substr(path, length(?1) + 1) WHERE path = ?1 OR path LIKE ?3 ESCAPE '\\'",
                params![from, to, format!("{}/%", from.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))],
            )
            .map_err(sql_err)?;
        self.insert(to, None, "", source, actor, Action::Renamed, Some(from))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Versions of `path`, newest first.
    pub fn list(&self, path: &str, limit: usize) -> Result<Vec<Version>> {
        let mut stmt = self
            .conn
            .prepare_cached(&format!(
                "SELECT {} FROM versions WHERE path = ?1 ORDER BY id DESC LIMIT ?2",
                Self::COLUMNS
            ))
            .map_err(sql_err)?;
        stmt.query_map(params![path, limit as i64], Self::row)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(sql_err)
    }

    /// The newest kept content of `path` with this hash.
    pub fn content_by_hash(&self, path: &str, hash: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT content FROM versions WHERE path = ?1 AND hash = ?2 AND content IS NOT NULL ORDER BY id DESC LIMIT 1",
                params![path, hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn get(&self, id: i64) -> Result<Option<Version>> {
        self.conn
            .query_row(
                &format!("SELECT {} FROM versions WHERE id = ?1", Self::COLUMNS),
                [id],
                Self::row,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn content(&self, id: i64) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT content FROM versions WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sql_err)
            .map(Option::flatten)
    }

    /// The version of the same file just before `id` (what an undo goes back to).
    pub fn previous(&self, id: i64) -> Result<Option<Version>> {
        let Some(v) = self.get(id)? else {
            return Ok(None);
        };
        self.conn
            .query_row(
                &format!("SELECT {} FROM versions WHERE path = ?1 AND id < ?2 AND action != 'renamed' ORDER BY id DESC LIMIT 1", Self::COLUMNS),
                params![v.path, id],
                Self::row,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Changes made by agents and the command line, newest first: the AI activity log.
    pub fn activity(&self, limit: usize) -> Result<Vec<Version>> {
        let mut stmt = self
            .conn
            .prepare_cached(&format!(
                "SELECT {} FROM versions WHERE source IN ('agent', 'cli') AND action != 'before' ORDER BY id DESC LIMIT ?1",
                Self::COLUMNS
            ))
            .map_err(sql_err)?;
        stmt.query_map([limit as i64], Self::row)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(sql_err)
    }

    fn prune_path(&self, path: &str) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM versions WHERE path = ?1 AND id NOT IN (SELECT id FROM versions WHERE path = ?1 ORDER BY id DESC LIMIT ?2)",
                params![path, KEEP_PER_FILE],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Drops versions older than the retention period, keeping each file's newest one.
    fn prune(&self) -> Result<()> {
        let cutoff = now_ms() - KEEP_DAYS * 24 * 3600 * 1000;
        self.conn
            .execute(
                "DELETE FROM versions WHERE time < ?1 AND id NOT IN (SELECT MAX(id) FROM versions GROUP BY path)",
                [cutoff],
            )
            .map_err(sql_err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h() -> History {
        History::in_memory().unwrap()
    }

    #[test]
    fn a_090_database_gains_the_new_proposal_columns() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let old = Connection::open(&db).unwrap();
        old.execute_batch(
            "CREATE TABLE proposals (
                id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, action TEXT NOT NULL,
                base_hash TEXT, content TEXT, hash TEXT, source TEXT NOT NULL, actor TEXT,
                created INTEGER NOT NULL, updated INTEGER NOT NULL, status TEXT NOT NULL,
                reason TEXT, decided INTEGER);
             INSERT INTO proposals (path, action, source, created, updated, status)
                VALUES ('A.md', 'edited', 'agent', 1, 1, 'accepted');",
        )
        .unwrap();
        drop(old);
        let h = History::open_at(&db).unwrap();
        let p = h.proposals(true, 10).unwrap();
        assert_eq!((p.len(), p[0].overwrote), (1, false));
        // Opening it again doesn't try to add the columns twice.
        drop(h);
        History::open_at(&db).unwrap();
    }

    #[test]
    fn keeps_the_original_before_the_first_change() {
        let h = h();
        h.keep_before("a.md", "v1", "h1", &Source::Agent).unwrap();
        h.record(
            "a.md",
            Some("v2"),
            "h2",
            &Source::Agent,
            Some("claude-code"),
            Action::Edited,
            None,
        )
        .unwrap();
        // Unchanged since: no second "before".
        h.keep_before("a.md", "v2", "h2", &Source::Agent).unwrap();
        let list = h.list("a.md", 10).unwrap();
        assert_eq!(
            list.iter().map(|v| v.action.as_str()).collect::<Vec<_>>(),
            ["edited", "before"]
        );
        assert_eq!(list[0].actor.as_deref(), Some("claude-code"));
        assert_eq!(h.content(list[1].id).unwrap().as_deref(), Some("v1"));
        assert_eq!(h.previous(list[0].id).unwrap().unwrap().id, list[1].id);
    }

    #[test]
    fn app_autosaves_merge_but_agent_edits_do_not() {
        let h = h();
        for i in 0..5 {
            h.record(
                "n.md",
                Some(&format!("t{i}")),
                &format!("h{i}"),
                &Source::App,
                None,
                Action::Edited,
                None,
            )
            .unwrap();
        }
        assert_eq!(h.list("n.md", 10).unwrap().len(), 1);
        assert_eq!(
            h.content(h.latest("n.md").unwrap().unwrap().id)
                .unwrap()
                .as_deref(),
            Some("t4")
        );
        h.record(
            "n.md",
            Some("a1"),
            "a1",
            &Source::Agent,
            None,
            Action::Edited,
            None,
        )
        .unwrap();
        h.record(
            "n.md",
            Some("a2"),
            "a2",
            &Source::Agent,
            None,
            Action::Edited,
            None,
        )
        .unwrap();
        assert_eq!(h.list("n.md", 10).unwrap().len(), 3);
        // The same content twice is one version.
        h.record(
            "n.md",
            Some("a2"),
            "a2",
            &Source::Agent,
            None,
            Action::Edited,
            None,
        )
        .unwrap();
        assert_eq!(h.list("n.md", 10).unwrap().len(), 3);
    }

    #[test]
    fn history_follows_renames_of_files_and_folders() {
        let h = h();
        h.record(
            "Old/a.md",
            Some("x"),
            "hx",
            &Source::App,
            None,
            Action::Created,
            None,
        )
        .unwrap();
        h.record(
            "Old_b.md",
            Some("y"),
            "hy",
            &Source::App,
            None,
            Action::Created,
            None,
        )
        .unwrap();
        h.renamed("Old", "New", &Source::Agent, Some("bot"))
            .unwrap();
        assert_eq!(h.list("New/a.md", 10).unwrap().len(), 1);
        assert!(h.list("Old/a.md", 10).unwrap().is_empty());
        assert_eq!(
            h.list("Old_b.md", 10).unwrap().len(),
            1,
            "a sibling with a similar name stays"
        );
        let moves = h.list("New", 10).unwrap();
        assert_eq!(
            (moves[0].action.as_str(), moves[0].from_path.as_deref()),
            ("renamed", Some("Old"))
        );
    }

    #[test]
    fn activity_lists_agent_and_cli_changes_only() {
        let h = h();
        h.record(
            "a.md",
            Some("1"),
            "1",
            &Source::App,
            None,
            Action::Created,
            None,
        )
        .unwrap();
        h.keep_before("a.md", "1", "1", &Source::Agent).unwrap();
        h.record(
            "a.md",
            Some("2"),
            "2",
            &Source::Agent,
            Some("claude-code"),
            Action::Edited,
            None,
        )
        .unwrap();
        h.record("b.md", None, "", &Source::Cli, None, Action::Deleted, None)
            .unwrap();
        let acts = h.activity(10).unwrap();
        assert_eq!(
            acts.iter()
                .map(|v| (v.path.as_str(), v.action.as_str()))
                .collect::<Vec<_>>(),
            [("b.md", "deleted"), ("a.md", "edited")]
        );
    }

    #[test]
    fn keeps_at_most_fifty_versions_per_file() {
        let h = h();
        for i in 0..60 {
            h.record(
                "a.md",
                Some(&i.to_string()),
                &i.to_string(),
                &Source::Agent,
                None,
                Action::Edited,
                None,
            )
            .unwrap();
        }
        let list = h.list("a.md", 100).unwrap();
        assert_eq!(list.len(), 50);
        assert_eq!(h.content(list[0].id).unwrap().as_deref(), Some("59"));
    }
}
