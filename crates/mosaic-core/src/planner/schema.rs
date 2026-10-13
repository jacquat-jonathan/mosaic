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
    if version < 2 {
        migrate_v2(conn)?;
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
        params![1, at],
    )
    .map_err(sql_error)?;
    tx.pragma_update(None, "user_version", 1)
        .map_err(sql_error)?;
    tx.commit().map_err(sql_error)
}

fn migrate_v2(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction().map_err(sql_error)?;
    let at = now();
    tx.execute_batch(
        "ALTER TABLE legacy_imports RENAME TO legacy_imports_v1;
         CREATE TABLE legacy_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            source_line INTEGER NOT NULL,
            block_id TEXT,
            source_fingerprint TEXT NOT NULL,
            imported_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
            imported_epic_id TEXT REFERENCES epics(id) ON DELETE RESTRICT,
            imported_at TEXT NOT NULL,
            CHECK((imported_task_id IS NOT NULL) != (imported_epic_id IS NOT NULL)),
            UNIQUE(source_fingerprint, imported_task_id),
            UNIQUE(source_fingerprint, imported_epic_id)
         );
         INSERT INTO legacy_imports(
            id, source_path, source_line, block_id, source_fingerprint, imported_task_id,
            imported_epic_id, imported_at
         )
         SELECT id, source_path, source_line, block_id, source_fingerprint, imported_task_id,
                NULL, imported_at
         FROM legacy_imports_v1;
         DROP TABLE legacy_imports_v1;
         CREATE INDEX legacy_import_source
            ON legacy_imports(source_path, block_id, source_fingerprint);
         INSERT INTO activity(entity_kind, entity_id, occurred_at, action, summary)
         SELECT 'work_session', work_sessions.id, datetime('now'), 'cancelled',
                'Moved imported task to Unscheduled'
         FROM work_sessions
         WHERE work_sessions.state = 'planned' AND work_sessions.revision = 1
           AND EXISTS (
             SELECT 1 FROM activity
             WHERE activity.entity_kind = 'work_session'
               AND activity.entity_id = work_sessions.id
               AND activity.action = 'imported'
               AND activity.summary = 'Imported all-day work session from daily note'
           );
         UPDATE work_sessions
         SET state = 'cancelled', revision = revision + 1, updated_at = datetime('now')
         WHERE state = 'planned' AND revision = 1
           AND EXISTS (
             SELECT 1 FROM activity
             WHERE activity.entity_kind = 'work_session'
               AND activity.entity_id = work_sessions.id
               AND activity.action = 'imported'
               AND activity.summary = 'Imported all-day work session from daily note'
           );",
    )
    .map_err(sql_error)?;

    // Upgrade untouched legacy imports in place so existing vaults immediately use the new
    // top-level epic convention. Modified root tasks, and roots with manually managed sessions,
    // stay unchanged rather than risking loss of user edits.
    let imported_roots = {
        let mut stmt = tx
            .prepare(
                "SELECT t.id, t.title, t.description, t.created_at, t.updated_at,
                        t.archived_at, t.trashed_at
                 FROM tasks t
                 JOIN legacy_imports i ON i.imported_task_id = t.id
                 WHERE t.parent_id IS NULL AND t.epic_id IS NULL AND t.revision = 1
                   AND NOT EXISTS (
                     SELECT 1 FROM work_sessions s
                     WHERE s.task_id = t.id
                       AND NOT (
                         s.revision = 1 AND EXISTS (
                           SELECT 1 FROM activity a
                           WHERE a.entity_kind = 'work_session' AND a.entity_id = s.id
                             AND a.action = 'imported'
                             AND a.summary = 'Imported all-day work session from daily note'
                         )
                       )
                   )
                 ORDER BY t.position, t.id",
            )
            .map_err(sql_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(sql_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_error)?
    };
    for (id, title, description, created_at, updated_at, archived_at, trashed_at) in imported_roots
    {
        tx.execute(
            "INSERT INTO epics(
                id, title, description, color, position, revision, created_at, updated_at,
                archived_at, trashed_at
             ) VALUES (
                ?1, ?2, ?3, '#6477d4',
                (SELECT COALESCE(MAX(position), 0) + 1024 FROM epics),
                1, ?4, ?5, ?6, ?7
             )",
            params![
                id,
                title,
                description,
                created_at,
                updated_at,
                archived_at,
                trashed_at
            ],
        )
        .map_err(sql_error)?;
        tx.execute(
            "WITH RECURSIVE descendants(id) AS (
                SELECT id FROM tasks WHERE parent_id = ?1
                UNION ALL
                SELECT task.id FROM tasks task JOIN descendants ON task.parent_id = descendants.id
             )
             UPDATE tasks SET epic_id = ?1 WHERE id IN (SELECT id FROM descendants)",
            [&id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "UPDATE tasks SET parent_id = NULL WHERE parent_id = ?1",
            [&id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "DELETE FROM activity WHERE entity_kind = 'work_session' AND entity_id IN (
                SELECT id FROM work_sessions WHERE task_id = ?1
             )",
            [&id],
        )
        .map_err(sql_error)?;
        tx.execute("DELETE FROM work_sessions WHERE task_id = ?1", [&id])
            .map_err(sql_error)?;
        tx.execute(
            "UPDATE note_links SET owner_kind = 'epic' WHERE owner_kind = 'task' AND owner_id = ?1",
            [&id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "UPDATE activity SET entity_kind = 'epic' WHERE entity_kind = 'task' AND entity_id = ?1",
            [&id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "UPDATE legacy_imports
             SET imported_task_id = NULL, imported_epic_id = ?1
             WHERE imported_task_id = ?1",
            [&id],
        )
        .map_err(sql_error)?;
        tx.execute("DELETE FROM tasks WHERE id = ?1", [&id])
            .map_err(sql_error)?;
    }
    tx.execute(
        "UPDATE planner_meta SET schema_version = 2, updated_at = ?1 WHERE id = 1",
        [&at],
    )
    .map_err(sql_error)?;
    tx.pragma_update(None, "user_version", 2)
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

    #[test]
    fn v2_migration_preserves_imports_and_unschedules_automatic_daily_sessions() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrate_v1(&mut conn).unwrap();
        let at = now();
        conn.execute(
            "INSERT INTO tasks(
                id, title, description, status, position, revision, created_at, updated_at
             ) VALUES ('task-1', 'Imported epic', '', 'new', 1024, 1, ?1, ?1)",
            [&at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks(
                id, parent_id, title, description, status, position, revision, created_at, updated_at
             ) VALUES ('task-2', 'task-1', 'Imported task', '', 'new', 1024, 1, ?1, ?1)",
            [&at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO legacy_imports(
                source_path, source_line, source_fingerprint, imported_task_id, imported_at
             ) VALUES ('Daily/2026-10-13.md', 1, 'fingerprint', 'task-1', ?1)",
            [&at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO work_sessions(
                id, task_id, all_day, start_value, end_value, timezone, state, revision,
                created_at, updated_at
             ) VALUES (
                'session-1', 'task-2', 1, '2026-10-13', '2026-10-14', 'Europe/Zurich',
                'planned', 1, ?1, ?1
             )",
            [&at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO activity(entity_kind, entity_id, occurred_at, action, summary)
             VALUES (
                'work_session', 'session-1', ?1, 'imported',
                'Imported all-day work session from daily note'
             )",
            [&at],
        )
        .unwrap();

        migrate(&mut conn, false, Path::new("")).unwrap();

        assert_eq!(
            conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT imported_epic_id FROM legacy_imports WHERE source_fingerprint = 'fingerprint'",
                [],
                |row| row.get::<_, String>(0),
            ).unwrap(),
            "task-1"
        );
        assert_eq!(
            conn.query_row(
                "SELECT epic_id || ':' || COALESCE(parent_id, '') FROM tasks WHERE id = 'task-2'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "task-1:"
        );
        assert_eq!(
            conn.query_row(
                "SELECT state FROM work_sessions WHERE id = 'session-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "cancelled"
        );
    }
}
