use super::{
    CreateWorkSession, PlannerStore, TaskStatus, UpdateWorkSession, WorkSession,
    bump_store_revision, expect_revision, now, record_activity, sql_error,
};
use crate::api::Workspace;
use crate::error::{Error, Result};
use crate::planner::tasks::task_in;
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{Row, Transaction, params};

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<WorkSession> {
    Ok(WorkSession {
        id: row.get(0)?,
        task_id: row.get(1)?,
        all_day: row.get(2)?,
        start_value: row.get(3)?,
        end_value: row.get(4)?,
        timezone: row.get(5)?,
        state: row.get(6)?,
        revision: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn session_in(tx: &Transaction<'_>, id: &str) -> Result<WorkSession> {
    tx.query_row(
        "SELECT id, task_id, all_day, start_value, end_value, timezone, state, revision,
                created_at, updated_at FROM work_sessions WHERE id = ?1",
        [id],
        row_to_session,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => {
            Error::NotFound(format!("planner work_session/{id}"))
        }
        other => sql_error(other),
    })
}

fn normalize_range(
    all_day: bool,
    start: &str,
    end: &str,
    timezone: &str,
) -> Result<(String, String, String)> {
    let timezone = timezone.trim();
    if timezone.is_empty() {
        return Err(Error::Invalid(
            "work-session timezone cannot be empty".into(),
        ));
    }
    if all_day {
        let start_date = NaiveDate::parse_from_str(start.trim(), "%Y-%m-%d")
            .map_err(|_| Error::Invalid(format!("{start:?} isn't an ISO all-day start date")))?;
        let end_date = NaiveDate::parse_from_str(end.trim(), "%Y-%m-%d")
            .map_err(|_| Error::Invalid(format!("{end:?} isn't an ISO all-day end date")))?;
        if end_date <= start_date {
            return Err(Error::Invalid(
                "work-session end must be after its start".into(),
            ));
        }
        Ok((
            start_date.to_string(),
            end_date.to_string(),
            timezone.to_string(),
        ))
    } else {
        let start_time = DateTime::parse_from_rfc3339(start)
            .map_err(|_| Error::Invalid(format!("{start:?} isn't an RFC 3339 instant")))?;
        let end_time = DateTime::parse_from_rfc3339(end)
            .map_err(|_| Error::Invalid(format!("{end:?} isn't an RFC 3339 instant")))?;
        if end_time <= start_time {
            return Err(Error::Invalid(
                "work-session end must be after its start".into(),
            ));
        }
        Ok((
            start_time
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            end_time
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            timezone.to_string(),
        ))
    }
}

impl PlannerStore {
    pub fn list_work_sessions(
        &self,
        task_id: Option<&str>,
        include_cancelled: bool,
    ) -> Result<Vec<WorkSession>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, task_id, all_day, start_value, end_value, timezone, state, revision,
                        created_at, updated_at FROM work_sessions
                 WHERE (?1 IS NULL OR task_id = ?1) AND (?2 OR state != 'cancelled')
                 ORDER BY all_day DESC, start_value, id",
            )
            .map_err(sql_error)?;
        stmt.query_map(params![task_id, include_cancelled], row_to_session)
            .map_err(sql_error)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_error)
    }

    pub fn create_work_session(&mut self, input: CreateWorkSession) -> Result<WorkSession> {
        let (start, end, timezone) = normalize_range(
            input.all_day,
            &input.start_value,
            &input.end_value,
            &input.timezone,
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        let at = now();
        let tx = self.conn.transaction().map_err(sql_error)?;
        let task = task_in(&tx, &input.task_id)?;
        if task.archived_at.is_some()
            || task.trashed_at.is_some()
            || task.status == TaskStatus::Done
        {
            return Err(Error::Invalid(
                "work sessions can only be added to active incomplete tasks".into(),
            ));
        }
        tx.execute(
            "INSERT INTO work_sessions(id, task_id, all_day, start_value, end_value, timezone,
                                       state, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'planned', 1, ?7, ?7)",
            params![id, input.task_id, input.all_day, start, end, timezone, at],
        )
        .map_err(sql_error)?;
        let session = session_in(&tx, &id)?;
        record_activity(
            &tx,
            ("work_session", &id),
            &at,
            "created",
            "Created work session",
            None,
            Some(serde_json::to_value(&session).unwrap()),
        )?;
        record_activity(
            &tx,
            ("task", &task.id),
            &at,
            "session-created",
            "Added a work session",
            None,
            Some(serde_json::to_value(&session).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(session)
    }

    pub fn update_work_session(
        &mut self,
        id: &str,
        input: UpdateWorkSession,
    ) -> Result<WorkSession> {
        let (start, end, timezone) = normalize_range(
            input.all_day,
            &input.start_value,
            &input.end_value,
            &input.timezone,
        )?;
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "work_sessions", id, input.expected_revision)?;
        let before = session_in(&tx, id)?;
        if before.state == "cancelled" {
            return Err(Error::Invalid(
                "a cancelled work session cannot be moved or resized".into(),
            ));
        }
        let at = now();
        tx.execute(
            "UPDATE work_sessions SET all_day = ?2, start_value = ?3, end_value = ?4,
                    timezone = ?5, revision = revision + 1, updated_at = ?6 WHERE id = ?1",
            params![id, input.all_day, start, end, timezone, at],
        )
        .map_err(sql_error)?;
        let after = session_in(&tx, id)?;
        record_activity(
            &tx,
            ("work_session", id),
            &at,
            "rescheduled",
            "Moved or resized work session",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        record_activity(
            &tx,
            ("task", &after.task_id),
            &at,
            "session-rescheduled",
            "Moved or resized a work session",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }

    pub fn cancel_work_session(&mut self, id: &str, expected_revision: i64) -> Result<WorkSession> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "work_sessions", id, expected_revision)?;
        let before = session_in(&tx, id)?;
        let at = now();
        tx.execute(
            "UPDATE work_sessions SET state = 'cancelled', revision = revision + 1,
                    updated_at = ?2 WHERE id = ?1",
            params![id, at],
        )
        .map_err(sql_error)?;
        let after = session_in(&tx, id)?;
        record_activity(
            &tx,
            ("work_session", id),
            &at,
            "cancelled",
            "Cancelled work session",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        record_activity(
            &tx,
            ("task", &after.task_id),
            &at,
            "session-cancelled",
            "Cancelled a work session",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }
}

impl Workspace {
    pub fn planner_work_sessions(
        &self,
        task_id: Option<&str>,
        include_cancelled: bool,
    ) -> Result<Vec<WorkSession>> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .list_work_sessions(task_id, include_cancelled)
    }

    pub fn create_planner_work_session(&self, input: CreateWorkSession) -> Result<WorkSession> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .create_work_session(input)
    }

    pub fn update_planner_work_session(
        &self,
        id: &str,
        input: UpdateWorkSession,
    ) -> Result<WorkSession> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .update_work_session(id, input)
    }

    pub fn cancel_planner_work_session(
        &self,
        id: &str,
        expected_revision: i64,
    ) -> Result<WorkSession> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cancel_work_session(id, expected_revision)
    }
}
