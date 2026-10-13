use super::{SCHEMA_VERSION, now, sql_error};
use crate::error::{Error, Result};
use rusqlite::{Connection, backup::Backup, params};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DIRECTORY: &str = ".mosaic";
const DATABASE: &str = "planner.sqlite3";
const BACKUP: &str = "planner-backup.sqlite3";

pub(super) fn open(vault_root: &Path) -> Result<(Connection, PathBuf)> {
    let directory = vault_root.join(DIRECTORY);
    fs::create_dir_all(&directory).map_err(|e| Error::io(directory.display().to_string(), e))?;
    let path = directory.join(DATABASE);
    let existed = path.metadata().is_ok_and(|meta| meta.len() > 0);
    let mut conn = Connection::open(&path).map_err(sql_error)?;
    configure(&conn)?;
    ensure_integrity(&conn, &path)?;
    migrate(&mut conn, existed, &directory.join(BACKUP))?;
    Ok((conn, path))
}

pub(super) fn in_memory() -> Result<Connection> {
    let mut conn = Connection::open_in_memory().map_err(sql_error)?;
    configure(&conn)?;
    migrate(&mut conn, false, Path::new(""))?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(sql_error)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(sql_error)?;
    if !conn.is_autocommit() {
        return Err(Error::Invalid(
            "planner database opened inside a transaction".into(),
        ));
    }
    if conn.path().is_some() {
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(sql_error)?;
        if !mode.eq_ignore_ascii_case("delete") {
            conn.pragma_update(None, "journal_mode", "DELETE")
                .map_err(sql_error)?;
        }
    }
    Ok(())
}

fn ensure_integrity(conn: &Connection, path: &Path) -> Result<()> {
    let result: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(sql_error)?;
    if result == "ok" {
        Ok(())
    } else {
        Err(Error::Invalid(format!(
            "planner database {} failed its integrity check: {result}; restore the last backup explicitly",
            path.display()
        )))
    }
}

fn migrate(conn: &mut Connection, existed: bool, backup_path: &Path) -> Result<()> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(sql_error)?;
    if version > SCHEMA_VERSION {
        return Err(Error::Invalid(format!(
            "planner schema {version} is newer than supported schema {SCHEMA_VERSION}"
        )));
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    if existed {
        backup(conn, backup_path)?;
    }
    if version < 1 {
        migrate_v1(conn)?;
    }
    Ok(())
}

fn backup(source: &Connection, path: &Path) -> Result<()> {
    let temporary = path.with_extension("sqlite3.tmp");
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(|e| Error::io(temporary.display().to_string(), e))?;
    }
    let mut destination = Connection::open(&temporary).map_err(sql_error)?;
    {
        let backup = Backup::new(source, &mut destination).map_err(sql_error)?;
        backup
            .run_to_completion(64, Duration::from_millis(5), None)
            .map_err(sql_error)?;
    }
    ensure_integrity(&destination, &temporary)?;
    drop(destination);
    fs::rename(&temporary, path).map_err(|e| Error::io(path.display().to_string(), e))
}

fn migrate_v1(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction().map_err(sql_error)?;
    tx.execute_batch(
        "CREATE TABLE planner_meta (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            schema_version INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
         );
         CREATE TABLE epics (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            color TEXT NOT NULL,
            position INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT,
            trashed_at TEXT
         );
         CREATE INDEX epics_position ON epics(position, id);
         CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            epic_id TEXT REFERENCES epics(id) ON DELETE RESTRICT,
            parent_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('new', 'blocked', 'in-progress', 'in-qa', 'done')),
            due_date TEXT,
            estimate_minutes INTEGER CHECK(estimate_minutes IS NULL OR estimate_minutes >= 0),
            position INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            archived_at TEXT,
            trashed_at TEXT,
            CHECK(parent_id IS NULL OR parent_id != id)
         );
         CREATE INDEX tasks_board_order ON tasks(epic_id, parent_id, status, position, id);
         CREATE INDEX tasks_due_date ON tasks(due_date);
         CREATE TABLE work_sessions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
            all_day INTEGER NOT NULL CHECK(all_day IN (0, 1)),
            start_value TEXT NOT NULL,
            end_value TEXT NOT NULL,
            timezone TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('planned', 'cancelled')),
            revision INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
         );
         CREATE INDEX work_sessions_range ON work_sessions(state, start_value, end_value);
         CREATE INDEX work_sessions_task ON work_sessions(task_id);
         CREATE TABLE events (
            id TEXT PRIMARY KEY,
            series_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            location TEXT NOT NULL,
            meeting_url TEXT,
            participants_json TEXT NOT NULL DEFAULT '[]',
            epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL,
            color TEXT,
            all_day INTEGER NOT NULL CHECK(all_day IN (0, 1)),
            start_value TEXT NOT NULL,
            end_value TEXT NOT NULL,
            timezone TEXT NOT NULL,
            recurrence_rule TEXT,
            revision INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT,
            trashed_at TEXT
         );
         CREATE INDEX events_range ON events(start_value, end_value);
         CREATE TABLE event_exceptions (
            series_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            occurrence_key TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('cancelled', 'replaced')),
            replacement_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
            PRIMARY KEY(series_id, occurrence_key)
         );
         CREATE TABLE note_links (
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('epic', 'task', 'event')),
            owner_id TEXT NOT NULL,
            path TEXT NOT NULL,
            heading TEXT,
            block_id TEXT,
            PRIMARY KEY(owner_kind, owner_id, path, heading, block_id)
         );
         CREATE INDEX note_links_path ON note_links(path);
         CREATE TABLE activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            action TEXT NOT NULL,
            summary TEXT NOT NULL,
            before_json TEXT,
            after_json TEXT
         );
         CREATE INDEX activity_entity ON activity(entity_kind, entity_id, id);
         CREATE TABLE legacy_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            source_line INTEGER NOT NULL,
            block_id TEXT,
            source_fingerprint TEXT NOT NULL,
            imported_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
            imported_at TEXT NOT NULL,
            UNIQUE(source_fingerprint, imported_task_id)
         );
         CREATE INDEX legacy_import_source ON legacy_imports(source_path, block_id, source_fingerprint);
         CREATE TABLE event_imports (
            source_kind TEXT NOT NULL,
            source_uid TEXT NOT NULL,
            recurrence_id TEXT NOT NULL DEFAULT '',
            imported_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
            imported_at TEXT NOT NULL,
            PRIMARY KEY(source_kind, source_uid, recurrence_id, imported_event_id)
         );",
    )
    .map_err(sql_error)?;
    let at = now();
    tx.execute(
        "INSERT INTO planner_meta(id, schema_version, revision, created_at, updated_at)
         VALUES (1, ?1, 0, ?2, ?2)",
        params![SCHEMA_VERSION, at],
    )
    .map_err(sql_error)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(sql_error)?;
    tx.commit().map_err(sql_error)
}

pub(super) fn restore_last_backup(vault_root: &Path) -> Result<PathBuf> {
    let directory = vault_root.join(DIRECTORY);
    let backup_path = directory.join(BACKUP);
    if !backup_path.is_file() {
        return Err(Error::NotFound(backup_path.display().to_string()));
    }
    let backup_conn =
        Connection::open_with_flags(&backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(sql_error)?;
    ensure_integrity(&backup_conn, &backup_path)?;
    drop(backup_conn);

    let database_path = directory.join(DATABASE);
    let temporary_path = directory.join("planner-restore.sqlite3");
    fs::copy(&backup_path, &temporary_path)
        .map_err(|e| Error::io(temporary_path.display().to_string(), e))?;
    let replaced_path = directory.join(format!(
        "planner-corrupt-{}.sqlite3",
        chrono::Utc::now().timestamp_millis()
    ));
    if database_path.exists() {
        fs::rename(&database_path, &replaced_path)
            .map_err(|e| Error::io(database_path.display().to_string(), e))?;
    }
    if let Err(error) = fs::rename(&temporary_path, &database_path) {
        if replaced_path.exists() {
            let _ = fs::rename(&replaced_path, &database_path);
        }
        return Err(Error::io(database_path.display().to_string(), error));
    }
    Ok(replaced_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_existing_schema_is_backed_up_before_migration() {
        let dir = tempfile::tempdir().unwrap();
        let hidden = dir.path().join(DIRECTORY);
        fs::create_dir(&hidden).unwrap();
        let db = hidden.join(DATABASE);
        let old = Connection::open(&db).unwrap();
        old.execute("CREATE TABLE old_marker(value TEXT)", [])
            .unwrap();
        old.execute("INSERT INTO old_marker VALUES ('kept')", [])
            .unwrap();
        drop(old);

        let (conn, _) = open(dir.path()).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let backup = Connection::open(hidden.join(BACKUP)).unwrap();
        assert_eq!(
            backup
                .query_row("SELECT value FROM old_marker", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "kept"
        );
    }
}
