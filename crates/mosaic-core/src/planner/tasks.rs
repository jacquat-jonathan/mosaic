use super::{
    CreateTask, FutureSessionPolicy, MoveTask, PlannerStore, PlannerTask, TaskStatus, UpdateTask,
    bump_store_revision, expect_revision, now, record_activity, required_title, sql_error,
};
use crate::api::Workspace;
use crate::error::{Error, Result};
use chrono::NaiveDate;
use rusqlite::{OptionalExtension, Row, Transaction, params};
use std::collections::HashMap;

pub(super) fn row_to_task(row: &Row<'_>) -> rusqlite::Result<PlannerTask> {
    let status: String = row.get(5)?;
    Ok(PlannerTask {
        id: row.get(0)?,
        epic_id: row.get(1)?,
        parent_id: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        status: TaskStatus::parse(&status).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::other(error.to_string())),
            )
        })?,
        due_date: row.get(6)?,
        estimate_minutes: row.get(7)?,
        position: row.get(8)?,
        revision: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        completed_at: row.get(12)?,
        archived_at: row.get(13)?,
        trashed_at: row.get(14)?,
    })
}

pub(super) fn task_in(tx: &Transaction<'_>, id: &str) -> Result<PlannerTask> {
    tx.query_row(
        "SELECT id, epic_id, parent_id, title, description, status, due_date, estimate_minutes,
                position, revision, created_at, updated_at, completed_at, archived_at, trashed_at
         FROM tasks WHERE id = ?1",
        [id],
        row_to_task,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Error::NotFound(format!("planner task/{id}")),
        other => sql_error(other),
    })
}

fn validate_due_date(value: Option<String>) -> Result<Option<String>> {
    value
        .map(|date| {
            NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
                .map(|parsed| parsed.to_string())
                .map_err(|_| Error::Invalid(format!("{date:?} isn't a date like 2026-10-13")))
        })
        .transpose()
}

fn validate_estimate(value: Option<i64>) -> Result<Option<i64>> {
    match value {
        Some(minutes) if minutes < 0 => {
            Err(Error::Invalid("task estimate cannot be negative".into()))
        }
        other => Ok(other),
    }
}

fn ensure_epic(tx: &Transaction<'_>, epic_id: Option<&str>) -> Result<()> {
    let Some(epic_id) = epic_id else {
        return Ok(());
    };
    let exists = tx
        .query_row(
            "SELECT 1 FROM epics WHERE id = ?1 AND trashed_at IS NULL",
            [epic_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(sql_error)?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(Error::NotFound(format!("planner epic/{epic_id}")))
    }
}

fn next_position(
    tx: &Transaction<'_>,
    epic_id: Option<&str>,
    parent_id: Option<&str>,
    status: TaskStatus,
) -> Result<i64> {
    tx.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1024 FROM tasks
         WHERE epic_id IS ?1 AND parent_id IS ?2 AND status = ?3",
        params![epic_id, parent_id, status.as_str()],
        |row| row.get(0),
    )
    .map_err(sql_error)
}

fn descendant_ids(tx: &Transaction<'_>, id: &str) -> Result<Vec<String>> {
    let mut stmt = tx
        .prepare(
            "WITH RECURSIVE descendants(id) AS (
                SELECT id FROM tasks WHERE parent_id = ?1
                UNION ALL
                SELECT tasks.id FROM tasks JOIN descendants ON tasks.parent_id = descendants.id
             ) SELECT id FROM descendants",
        )
        .map_err(sql_error)?;
    stmt.query_map([id], |row| row.get(0))
        .map_err(sql_error)?
        .collect::<std::result::Result<_, _>>()
        .map_err(sql_error)
}

impl PlannerStore {
    pub fn list_tasks(
        &self,
        include_archived: bool,
        include_trashed: bool,
    ) -> Result<Vec<PlannerTask>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, epic_id, parent_id, title, description, status, due_date, estimate_minutes,
                        position, revision, created_at, updated_at, completed_at, archived_at, trashed_at
                 FROM tasks
                 WHERE (?1 OR archived_at IS NULL) AND (?2 OR trashed_at IS NULL)
                 ORDER BY COALESCE(epic_id, ''), COALESCE(parent_id, ''), status, position, id",
            )
            .map_err(sql_error)?;
        stmt.query_map(params![include_archived, include_trashed], row_to_task)
            .map_err(sql_error)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_error)
    }

    pub fn create_task(&mut self, input: CreateTask) -> Result<PlannerTask> {
        let title = required_title(&input.title, "task")?;
        let due_date = validate_due_date(input.due_date)?;
        let estimate_minutes = validate_estimate(input.estimate_minutes)?;
        let id = uuid::Uuid::new_v4().to_string();
        let at = now();
        let tx = self.conn.transaction().map_err(sql_error)?;
        ensure_epic(&tx, input.epic_id.as_deref())?;
        if let Some(parent_id) = input.parent_id.as_deref() {
            let parent = task_in(&tx, parent_id)?;
            if parent.trashed_at.is_some() {
                return Err(Error::Invalid(
                    "cannot add a subtask to a trashed task".into(),
                ));
            }
            if parent.epic_id != input.epic_id {
                return Err(Error::Invalid(
                    "a subtask must belong to the same epic as its parent".into(),
                ));
            }
        }
        let position = next_position(
            &tx,
            input.epic_id.as_deref(),
            input.parent_id.as_deref(),
            input.status,
        )?;
        let completed_at = (input.status == TaskStatus::Done).then_some(at.clone());
        tx.execute(
            "INSERT INTO tasks(id, epic_id, parent_id, title, description, status, due_date,
                               estimate_minutes, position, revision, created_at, updated_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10, ?11)",
            params![
                id,
                input.epic_id,
                input.parent_id,
                title,
                input.description,
                input.status.as_str(),
                due_date,
                estimate_minutes,
                position,
                at,
                completed_at
            ],
        )
        .map_err(sql_error)?;
        let task = task_in(&tx, &id)?;
        record_activity(
            &tx,
            ("task", &id),
            &at,
            "created",
            "Created task",
            None,
            Some(serde_json::to_value(&task).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(task)
    }

    pub fn update_task(&mut self, id: &str, input: UpdateTask) -> Result<PlannerTask> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "tasks", id, input.expected_revision)?;
        let before = task_in(&tx, id)?;
        let title = match input.title {
            Some(title) => required_title(&title, "task")?,
            None => before.title.clone(),
        };
        let due_date = match (input.due_date, input.clear_due_date) {
            (Some(value), _) => validate_due_date(Some(value))?,
            (None, true) => None,
            (None, false) => before.due_date.clone(),
        };
        let estimate_minutes = match (input.estimate_minutes, input.clear_estimate) {
            (Some(value), _) => validate_estimate(Some(value))?,
            (None, true) => None,
            (None, false) => before.estimate_minutes,
        };
        let at = now();
        tx.execute(
            "UPDATE tasks SET title = ?2, description = ?3, due_date = ?4, estimate_minutes = ?5,
                    revision = revision + 1, updated_at = ?6 WHERE id = ?1",
            params![
                id,
                title,
                input
                    .description
                    .unwrap_or_else(|| before.description.clone()),
                due_date,
                estimate_minutes,
                at
            ],
        )
        .map_err(sql_error)?;
        let after = task_in(&tx, id)?;
        record_activity(
            &tx,
            ("task", id),
            &at,
            "updated",
            "Updated task",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }

    pub fn move_task(&mut self, id: &str, input: MoveTask) -> Result<PlannerTask> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "tasks", id, input.expected_revision)?;
        let current = task_in(&tx, id)?;
        if current.status != input.status
            && matches!(current.status, TaskStatus::Done)
                != matches!(input.status, TaskStatus::Done)
        {
            return Err(Error::Invalid(
                "use the complete or reopen operation when crossing the Done boundary".into(),
            ));
        }
        ensure_epic(&tx, input.epic_id.as_deref())?;
        if input.parent_id.as_deref() == Some(id) {
            return Err(Error::Invalid("a task cannot be its own parent".into()));
        }
        if let Some(parent_id) = input.parent_id.as_deref() {
            let parent = task_in(&tx, parent_id)?;
            if parent.epic_id != input.epic_id {
                return Err(Error::Invalid(
                    "a subtask must belong to the same epic as its parent".into(),
                ));
            }
            if descendant_ids(&tx, id)?
                .iter()
                .any(|child| child == parent_id)
            {
                return Err(Error::Invalid(
                    "moving this task there would create a hierarchy cycle".into(),
                ));
            }
        }

        let mut ids = vec![id.to_string()];
        ids.extend(descendant_ids(&tx, id)?);
        let before: HashMap<String, PlannerTask> = ids
            .iter()
            .map(|task_id| Ok((task_id.clone(), task_in(&tx, task_id)?)))
            .collect::<Result<_>>()?;
        let at = now();
        tx.execute(
            "UPDATE tasks SET epic_id = ?2, parent_id = ?3, status = ?4, position = ?5,
                    completed_at = CASE WHEN ?4 = 'done' THEN COALESCE(completed_at, ?6) ELSE NULL END,
                    revision = revision + 1, updated_at = ?6 WHERE id = ?1",
            params![
                id,
                input.epic_id,
                input.parent_id,
                input.status.as_str(),
                input.position,
                at
            ],
        )
        .map_err(sql_error)?;
        if ids.len() > 1 {
            tx.execute(
                "WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM tasks WHERE parent_id = ?1
                    UNION ALL
                    SELECT tasks.id FROM tasks JOIN descendants ON tasks.parent_id = descendants.id
                 ) UPDATE tasks SET epic_id = ?2, revision = revision + 1, updated_at = ?3
                   WHERE id IN (SELECT id FROM descendants)",
                params![id, input.epic_id, at],
            )
            .map_err(sql_error)?;
        }
        for task_id in &ids {
            let after = task_in(&tx, task_id)?;
            record_activity(
                &tx,
                ("task", task_id),
                &at,
                "moved",
                if task_id == id {
                    "Moved task"
                } else {
                    "Moved with parent task"
                },
                Some(serde_json::to_value(&before[task_id]).unwrap()),
                Some(serde_json::to_value(&after).unwrap()),
            )?;
        }
        bump_store_revision(&tx, &at)?;
        let result = task_in(&tx, id)?;
        tx.commit().map_err(sql_error)?;
        Ok(result)
    }

    pub fn complete_task(
        &mut self,
        id: &str,
        expected_revision: i64,
        allow_incomplete_subtasks: bool,
        future_sessions: FutureSessionPolicy,
    ) -> Result<PlannerTask> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "tasks", id, expected_revision)?;
        if !allow_incomplete_subtasks {
            let incomplete: i64 = tx
                .query_row(
                    "WITH RECURSIVE descendants(id) AS (
                        SELECT id FROM tasks WHERE parent_id = ?1
                        UNION ALL SELECT tasks.id FROM tasks JOIN descendants ON tasks.parent_id = descendants.id
                     ) SELECT COUNT(*) FROM tasks WHERE id IN (SELECT id FROM descendants)
                       AND status != 'done' AND archived_at IS NULL AND trashed_at IS NULL",
                    [id],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if incomplete > 0 {
                return Err(Error::Invalid(format!(
                    "task has {incomplete} incomplete subtasks; confirm before completing it"
                )));
            }
        }
        let before = task_in(&tx, id)?;
        let at = now();
        tx.execute(
            "UPDATE tasks SET status = 'done', completed_at = COALESCE(completed_at, ?2),
                    revision = revision + 1, updated_at = ?2 WHERE id = ?1",
            params![id, at],
        )
        .map_err(sql_error)?;
        if future_sessions == FutureSessionPolicy::Cancel {
            let today = chrono::Local::now().date_naive().to_string();
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM work_sessions WHERE task_id = ?1 AND state = 'planned'
                     AND ((all_day = 1 AND start_value > ?2) OR (all_day = 0 AND start_value > ?3))",
                )
                .map_err(sql_error)?;
            let session_ids: Vec<String> = stmt
                .query_map(params![id, today, at], |row| row.get(0))
                .map_err(sql_error)?
                .collect::<std::result::Result<_, _>>()
                .map_err(sql_error)?;
            drop(stmt);
            for session_id in session_ids {
                tx.execute(
                    "UPDATE work_sessions SET state = 'cancelled', revision = revision + 1,
                            updated_at = ?2 WHERE id = ?1",
                    params![session_id, at],
                )
                .map_err(sql_error)?;
                record_activity(
                    &tx,
                    ("work_session", &session_id),
                    &at,
                    "cancelled",
                    "Cancelled future session when task completed",
                    None,
                    None,
                )?;
            }
        }
        let after = task_in(&tx, id)?;
        record_activity(
            &tx,
            ("task", id),
            &at,
            "completed",
            "Completed task",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }

    pub fn reopen_task(&mut self, id: &str, expected_revision: i64) -> Result<PlannerTask> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "tasks", id, expected_revision)?;
        let before = task_in(&tx, id)?;
        let at = now();
        tx.execute(
            "UPDATE tasks SET status = 'new', completed_at = NULL, revision = revision + 1,
                    updated_at = ?2 WHERE id = ?1",
            params![id, at],
        )
        .map_err(sql_error)?;
        let after = task_in(&tx, id)?;
        record_activity(
            &tx,
            ("task", id),
            &at,
            "reopened",
            "Reopened task",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }

    pub fn archive_task(&mut self, id: &str, expected_revision: i64) -> Result<PlannerTask> {
        self.set_task_lifecycle(id, expected_revision, "archived")
    }

    pub fn restore_task(&mut self, id: &str, expected_revision: i64) -> Result<PlannerTask> {
        self.set_task_lifecycle(id, expected_revision, "restored")
    }

    pub fn trash_task(&mut self, id: &str, expected_revision: i64) -> Result<PlannerTask> {
        self.set_task_lifecycle(id, expected_revision, "trashed")
    }

    fn set_task_lifecycle(
        &mut self,
        id: &str,
        expected_revision: i64,
        action: &str,
    ) -> Result<PlannerTask> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "tasks", id, expected_revision)?;
        let before = task_in(&tx, id)?;
        if action == "trashed" && before.archived_at.is_none() {
            return Err(Error::Invalid(
                "archive a task before moving it to Trash".into(),
            ));
        }
        let at = now();
        let changed = match action {
            "archived" => tx.execute(
                "UPDATE tasks SET archived_at = COALESCE(archived_at, ?2), revision = revision + 1,
                        updated_at = ?2 WHERE id = ?1",
                params![id, at],
            ),
            "restored" => tx.execute(
                "UPDATE tasks SET archived_at = NULL, trashed_at = NULL, revision = revision + 1,
                        updated_at = ?2 WHERE id = ?1",
                params![id, at],
            ),
            "trashed" => tx.execute(
                "UPDATE tasks SET trashed_at = ?2, revision = revision + 1, updated_at = ?2
                        WHERE id = ?1",
                params![id, at],
            ),
            _ => return Err(Error::Invalid(format!("unknown task action {action}"))),
        };
        changed.map_err(sql_error)?;
        let after = task_in(&tx, id)?;
        record_activity(
            &tx,
            ("task", id),
            &at,
            action,
            &format!("{} task", action),
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }
}

impl Workspace {
    pub fn planner_tasks(
        &self,
        include_archived: bool,
        include_trashed: bool,
    ) -> Result<Vec<PlannerTask>> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .list_tasks(include_archived, include_trashed)
    }

    pub fn create_planner_task(&self, input: CreateTask) -> Result<PlannerTask> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .create_task(input)
    }

    pub fn update_planner_task(&self, id: &str, input: UpdateTask) -> Result<PlannerTask> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .update_task(id, input)
    }

    pub fn move_planner_task(&self, id: &str, input: MoveTask) -> Result<PlannerTask> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .move_task(id, input)
    }

    pub fn complete_planner_task(
        &self,
        id: &str,
        expected_revision: i64,
        allow_incomplete_subtasks: bool,
        future_sessions: FutureSessionPolicy,
    ) -> Result<PlannerTask> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .complete_task(
                id,
                expected_revision,
                allow_incomplete_subtasks,
                future_sessions,
            )
    }

    pub fn reopen_planner_task(&self, id: &str, expected_revision: i64) -> Result<PlannerTask> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .reopen_task(id, expected_revision)
    }

    pub fn archive_planner_task(&self, id: &str, expected_revision: i64) -> Result<PlannerTask> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .archive_task(id, expected_revision)
    }

    pub fn restore_planner_task(&self, id: &str, expected_revision: i64) -> Result<PlannerTask> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .restore_task(id, expected_revision)
    }

    pub fn trash_planner_task(&self, id: &str, expected_revision: i64) -> Result<PlannerTask> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .trash_task(id, expected_revision)
    }
}
