//! Independent per-vault planning data. Markdown checkboxes remain note content; this module owns
//! epics, tasks, work sessions and their activity history in `<vault>/.mosaic/planner.sqlite3`.

mod calendar;
mod epics;
mod migration;
mod recurrence;
mod schema;
mod tasks;

#[cfg(test)]
mod tests;

use crate::api::Workspace;
use crate::error::{Error, Result};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub use migration::{
    MarkdownImportCandidate, MarkdownImportGroup, MarkdownImportPreview, MarkdownImportResult,
};

pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug)]
pub struct PlannerStore {
    pub(super) conn: Connection,
    path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannerSummary {
    pub schema_version: i64,
    pub revision: i64,
    pub epics: usize,
    pub tasks: usize,
    pub work_sessions: usize,
    pub events: usize,
    pub is_empty: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    New,
    Blocked,
    InProgress,
    InQa,
    Done,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Blocked => "blocked",
            Self::InProgress => "in-progress",
            Self::InQa => "in-qa",
            Self::Done => "done",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "new" => Ok(Self::New),
            "blocked" => Ok(Self::Blocked),
            "in-progress" => Ok(Self::InProgress),
            "in-qa" => Ok(Self::InQa),
            "done" => Ok(Self::Done),
            _ => Err(Error::Invalid(format!(
                "unknown planner task status {value:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FutureSessionPolicy {
    Cancel,
    Keep,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Epic {
    pub id: String,
    pub title: String,
    pub description: String,
    pub color: String,
    pub position: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub trashed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateEpic {
    pub title: String,
    pub description: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateEpic {
    pub expected_revision: i64,
    pub title: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub position: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannerTask {
    pub id: String,
    pub epic_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub due_date: Option<String>,
    pub estimate_minutes: Option<i64>,
    pub position: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub archived_at: Option<String>,
    pub trashed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateTask {
    pub epic_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub due_date: Option<String>,
    pub estimate_minutes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateTask {
    pub expected_revision: i64,
    pub title: Option<String>,
    pub description: Option<String>,
    pub due_date: Option<String>,
    pub clear_due_date: bool,
    pub estimate_minutes: Option<i64>,
    pub clear_estimate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoveTask {
    pub expected_revision: i64,
    pub epic_id: Option<String>,
    pub parent_id: Option<String>,
    pub status: TaskStatus,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkSession {
    pub id: String,
    pub task_id: String,
    pub all_day: bool,
    /// RFC 3339 UTC instant for timed sessions; ISO date for all-day sessions.
    pub start_value: String,
    /// RFC 3339 UTC instant for timed sessions; exclusive ISO date for all-day sessions.
    pub end_value: String,
    pub timezone: String,
    pub state: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannerEvent {
    pub id: String,
    pub series_id: Option<String>,
    pub title: String,
    pub description: String,
    pub location: String,
    pub meeting_url: Option<String>,
    pub participants: Vec<String>,
    pub epic_id: Option<String>,
    pub color: Option<String>,
    pub all_day: bool,
    /// RFC 3339 UTC instant for timed events; ISO date for all-day events.
    pub start_value: String,
    /// RFC 3339 UTC instant for timed events; exclusive ISO date for all-day events.
    pub end_value: String,
    pub timezone: String,
    pub recurrence_rule: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub trashed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateEvent {
    pub title: String,
    pub description: String,
    pub location: String,
    pub meeting_url: Option<String>,
    pub participants: Vec<String>,
    pub epic_id: Option<String>,
    pub color: Option<String>,
    pub all_day: bool,
    pub start_value: String,
    pub end_value: String,
    pub timezone: String,
    pub recurrence_rule: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateEvent {
    pub expected_revision: i64,
    pub title: String,
    pub description: String,
    pub location: String,
    pub meeting_url: Option<String>,
    pub participants: Vec<String>,
    pub epic_id: Option<String>,
    pub color: Option<String>,
    pub all_day: bool,
    pub start_value: String,
    pub end_value: String,
    pub timezone: String,
    pub recurrence_rule: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EventOccurrence {
    pub event_id: String,
    pub series_id: String,
    pub occurrence_key: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub meeting_url: Option<String>,
    pub participants: Vec<String>,
    pub epic_id: Option<String>,
    pub color: Option<String>,
    pub all_day: bool,
    pub start_value: String,
    pub end_value: String,
    pub timezone: String,
    pub recurring: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CalendarWorkSession {
    pub session: WorkSession,
    pub task_title: String,
    pub task_status: TaskStatus,
    pub epic_id: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DueMarker {
    pub task_id: String,
    pub title: String,
    pub date: String,
    pub status: TaskStatus,
    pub epic_id: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DayWorkload {
    pub date: String,
    pub minutes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CalendarRange {
    pub from: String,
    pub to: String,
    pub events: Vec<EventOccurrence>,
    pub work_sessions: Vec<CalendarWorkSession>,
    pub due_markers: Vec<DueMarker>,
    pub unscheduled_tasks: Vec<PlannerTask>,
    pub workload: Vec<DayWorkload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateWorkSession {
    pub task_id: String,
    pub all_day: bool,
    pub start_value: String,
    pub end_value: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateWorkSession {
    pub expected_revision: i64,
    pub all_day: bool,
    pub start_value: String,
    pub end_value: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivityEntry {
    pub id: i64,
    pub entity_kind: String,
    pub entity_id: String,
    pub occurred_at: String,
    pub action: String,
    pub summary: String,
    pub before: Option<serde_json::Value>,
    pub after: Option<serde_json::Value>,
}

impl PlannerStore {
    pub fn open(vault_root: &Path) -> Result<Self> {
        let (conn, path) = schema::open(vault_root)?;
        Ok(Self {
            conn,
            path: Some(path),
        })
    }

    pub fn in_memory() -> Result<Self> {
        Ok(Self {
            conn: schema::in_memory()?,
            path: None,
        })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn restore_last_backup(vault_root: &Path) -> Result<PathBuf> {
        schema::restore_last_backup(vault_root)
    }

    pub fn summary(&self) -> Result<PlannerSummary> {
        let (schema_version, revision): (i64, i64) = self
            .conn
            .query_row(
                "SELECT schema_version, revision FROM planner_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(sql_error)?;
        let epics = count(&self.conn, "epics")?;
        let tasks = count(&self.conn, "tasks")?;
        let work_sessions = count(&self.conn, "work_sessions")?;
        let events = count(&self.conn, "events")?;
        Ok(PlannerSummary {
            schema_version,
            revision,
            epics,
            tasks,
            work_sessions,
            events,
            is_empty: epics == 0 && tasks == 0 && work_sessions == 0 && events == 0,
        })
    }

    pub fn activity(&self, entity_kind: &str, entity_id: &str) -> Result<Vec<ActivityEntry>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, entity_kind, entity_id, occurred_at, action, summary, before_json, after_json
                 FROM activity WHERE entity_kind = ?1 AND entity_id = ?2 ORDER BY id",
            )
            .map_err(sql_error)?;
        stmt.query_map(params![entity_kind, entity_id], |row| {
            let before: Option<String> = row.get(6)?;
            let after: Option<String> = row.get(7)?;
            Ok(ActivityEntry {
                id: row.get(0)?,
                entity_kind: row.get(1)?,
                entity_id: row.get(2)?,
                occurred_at: row.get(3)?,
                action: row.get(4)?,
                summary: row.get(5)?,
                before: before.and_then(|value| serde_json::from_str(&value).ok()),
                after: after.and_then(|value| serde_json::from_str(&value).ok()),
            })
        })
        .map_err(sql_error)?
        .collect::<std::result::Result<_, _>>()
        .map_err(sql_error)
    }
}

impl Workspace {
    pub fn planner_summary(&self) -> Result<PlannerSummary> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .summary()
    }

    pub fn planner_activity(
        &self,
        entity_kind: &str,
        entity_id: &str,
    ) -> Result<Vec<ActivityEntry>> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .activity(entity_kind, entity_id)
    }
}

pub(super) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn sql_error(error: rusqlite::Error) -> Error {
    Error::Io {
        path: "planner".into(),
        source: std::io::Error::other(error.to_string()),
    }
}

pub(super) fn count(conn: &Connection, table: &str) -> Result<usize> {
    let sql = match table {
        "epics" => "SELECT COUNT(*) FROM epics",
        "tasks" => "SELECT COUNT(*) FROM tasks",
        "work_sessions" => "SELECT COUNT(*) FROM work_sessions",
        "events" => "SELECT COUNT(*) FROM events",
        _ => return Err(Error::Invalid(format!("unknown planner table {table}"))),
    };
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .map(|value| value as usize)
        .map_err(sql_error)
}

pub(super) fn store_revision(conn: &Connection) -> Result<i64> {
    conn.query_row(
        "SELECT revision FROM planner_meta WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .map_err(sql_error)
}

pub(super) fn bump_store_revision(tx: &Transaction<'_>, at: &str) -> Result<i64> {
    tx.execute(
        "UPDATE planner_meta SET revision = revision + 1, updated_at = ?1 WHERE id = 1",
        [at],
    )
    .map_err(sql_error)?;
    store_revision(tx)
}

pub(super) fn record_activity(
    tx: &Transaction<'_>,
    entity: (&str, &str),
    at: &str,
    action: &str,
    summary: &str,
    before: Option<serde_json::Value>,
    after: Option<serde_json::Value>,
) -> Result<()> {
    let (entity_kind, entity_id) = entity;
    let before = before
        .map(|value| serde_json::to_string(&value))
        .transpose()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let after = after
        .map(|value| serde_json::to_string(&value))
        .transpose()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    tx.execute(
        "INSERT INTO activity(entity_kind, entity_id, occurred_at, action, summary, before_json, after_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![entity_kind, entity_id, at, action, summary, before, after],
    )
    .map_err(sql_error)?;
    Ok(())
}

pub(super) fn current_revision(tx: &Transaction<'_>, table: &str, id: &str) -> Result<Option<i64>> {
    let sql = match table {
        "epics" => "SELECT revision FROM epics WHERE id = ?1",
        "tasks" => "SELECT revision FROM tasks WHERE id = ?1",
        "work_sessions" => "SELECT revision FROM work_sessions WHERE id = ?1",
        "events" => "SELECT revision FROM events WHERE id = ?1",
        _ => return Err(Error::Invalid(format!("unknown planner table {table}"))),
    };
    tx.query_row(sql, [id], |row| row.get(0))
        .optional()
        .map_err(sql_error)
}

pub(super) fn expect_revision(
    tx: &Transaction<'_>,
    table: &str,
    id: &str,
    expected: i64,
) -> Result<()> {
    match current_revision(tx, table, id)? {
        None => Err(Error::NotFound(format!("planner {table}/{id}"))),
        Some(current) if current != expected => Err(Error::Conflict {
            path: format!("planner/{table}/{id}"),
            current_hash: current.to_string(),
        }),
        Some(_) => Ok(()),
    }
}

pub(super) fn required_title(title: &str, kind: &str) -> Result<String> {
    let title = title.trim();
    if title.is_empty() {
        Err(Error::Invalid(format!("{kind} title cannot be empty")))
    } else {
        Ok(title.to_string())
    }
}
