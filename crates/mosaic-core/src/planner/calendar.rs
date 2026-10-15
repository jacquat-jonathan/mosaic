use super::{
    CalendarRange, CalendarWorkSession, CreateEvent, CreateWorkSession, DayWorkload, DueMarker,
    EventOccurrence, PlannerEvent, PlannerStore, TaskStatus, UpdateEvent, UpdateWorkSession,
    WorkSession, bump_store_revision, expect_revision, now, record_activity, required_title,
    sql_error,
};
use crate::api::Workspace;
use crate::error::{Error, Result};
use crate::planner::tasks::task_in;
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use chrono_tz::Tz;
use rusqlite::{OptionalExtension, Row, Transaction, params};
use std::collections::{BTreeMap, HashMap};

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

pub(super) fn row_to_event(row: &Row<'_>) -> rusqlite::Result<PlannerEvent> {
    let participants: String = row.get(6)?;
    Ok(PlannerEvent {
        id: row.get(0)?,
        series_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        location: row.get(4)?,
        meeting_url: row.get(5)?,
        participants: serde_json::from_str(&participants).unwrap_or_default(),
        epic_id: row.get(7)?,
        color: row.get(8)?,
        all_day: row.get(9)?,
        start_value: row.get(10)?,
        end_value: row.get(11)?,
        timezone: row.get(12)?,
        recurrence_rule: row.get(13)?,
        revision: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        archived_at: row.get(17)?,
        trashed_at: row.get(18)?,
    })
}

const EVENT_COLUMNS: &str = "id, series_id, title, description, location, meeting_url,
    participants_json, epic_id, color, all_day, start_value, end_value, timezone,
    recurrence_rule, revision, created_at, updated_at, archived_at, trashed_at";

fn event_in(tx: &Transaction<'_>, id: &str) -> Result<PlannerEvent> {
    tx.query_row(
        &format!("SELECT {EVENT_COLUMNS} FROM events WHERE id = ?1"),
        [id],
        row_to_event,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Error::NotFound(format!("planner event/{id}")),
        other => sql_error(other),
    })
}

fn validate_event_range(
    all_day: bool,
    start: &str,
    end: &str,
    timezone: &str,
) -> Result<(String, String, String)> {
    let normalized = normalize_range(all_day, start, end, timezone)?;
    normalized
        .2
        .parse::<Tz>()
        .map_err(|_| Error::Invalid(format!("unknown IANA timezone {:?}", normalized.2)))?;
    Ok(normalized)
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

pub(super) fn insert_event(
    tx: &Transaction<'_>,
    input: CreateEvent,
    series_id: Option<&str>,
    at: &str,
) -> Result<PlannerEvent> {
    let title = required_title(&input.title, "event")?;
    let (start, end, timezone) = validate_event_range(
        input.all_day,
        &input.start_value,
        &input.end_value,
        &input.timezone,
    )?;
    let recurrence_rule = super::recurrence::normalize_rule(input.recurrence_rule)?;
    if series_id.is_some() && recurrence_rule.is_some() {
        return Err(Error::Invalid(
            "a replacement occurrence cannot itself recur".into(),
        ));
    }
    if let Some(epic_id) = input.epic_id.as_deref() {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM epics WHERE id = ?1 AND trashed_at IS NULL)",
                [epic_id],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if !exists {
            return Err(Error::NotFound(format!("planner epic/{epic_id}")));
        }
    }
    let participants = input
        .participants
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let participants_json =
        serde_json::to_string(&participants).map_err(|error| Error::Invalid(error.to_string()))?;
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO events(id, series_id, title, description, location, meeting_url,
          participants_json, epic_id, color, all_day, start_value, end_value, timezone,
          recurrence_rule, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1, ?15, ?15)",
        params![
            id,
            series_id,
            title,
            input.description,
            input.location,
            normalize_optional(input.meeting_url),
            participants_json,
            input.epic_id,
            normalize_optional(input.color),
            input.all_day,
            start,
            end,
            timezone,
            recurrence_rule,
            at
        ],
    )
    .map_err(sql_error)?;
    event_in(tx, &id)
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

    pub fn list_events(
        &self,
        include_archived: bool,
        include_trashed: bool,
    ) -> Result<Vec<PlannerEvent>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT {EVENT_COLUMNS} FROM events
                 WHERE series_id IS NULL AND (?1 OR archived_at IS NULL)
                   AND (?2 OR trashed_at IS NULL) ORDER BY start_value, id"
            ))
            .map_err(sql_error)?;
        stmt.query_map(params![include_archived, include_trashed], row_to_event)
            .map_err(sql_error)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_error)
    }

    pub fn create_event(&mut self, input: CreateEvent) -> Result<PlannerEvent> {
        let at = now();
        let tx = self.conn.transaction().map_err(sql_error)?;
        let event = insert_event(&tx, input, None, &at)?;
        record_activity(
            &tx,
            ("event", &event.id),
            &at,
            "created",
            "Created event",
            None,
            Some(serde_json::to_value(&event).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(event)
    }

    pub fn update_event(&mut self, id: &str, input: UpdateEvent) -> Result<PlannerEvent> {
        let title = required_title(&input.title, "event")?;
        let (start, end, timezone) = validate_event_range(
            input.all_day,
            &input.start_value,
            &input.end_value,
            &input.timezone,
        )?;
        let recurrence_rule = super::recurrence::normalize_rule(input.recurrence_rule)?;
        let participants = input
            .participants
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        let participants_json = serde_json::to_string(&participants)
            .map_err(|error| Error::Invalid(error.to_string()))?;
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "events", id, input.expected_revision)?;
        let before = event_in(&tx, id)?;
        if before.series_id.is_some() {
            return Err(Error::Invalid(
                "edit a replacement through its parent series occurrence".into(),
            ));
        }
        if let Some(epic_id) = input.epic_id.as_deref() {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM epics WHERE id = ?1 AND trashed_at IS NULL)",
                    [epic_id],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if !exists {
                return Err(Error::NotFound(format!("planner epic/{epic_id}")));
            }
        }
        let at = now();
        tx.execute(
            "UPDATE events SET title = ?2, description = ?3, location = ?4, meeting_url = ?5,
              participants_json = ?6, epic_id = ?7, color = ?8, all_day = ?9,
              start_value = ?10, end_value = ?11, timezone = ?12, recurrence_rule = ?13,
              revision = revision + 1, updated_at = ?14 WHERE id = ?1",
            params![
                id,
                title,
                input.description,
                input.location,
                normalize_optional(input.meeting_url),
                participants_json,
                input.epic_id,
                normalize_optional(input.color),
                input.all_day,
                start,
                end,
                timezone,
                recurrence_rule,
                at
            ],
        )
        .map_err(sql_error)?;
        let after = event_in(&tx, id)?;
        record_activity(
            &tx,
            ("event", id),
            &at,
            "updated",
            "Updated event series",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }

    fn event_lifecycle(
        &mut self,
        id: &str,
        expected_revision: i64,
        action: &str,
    ) -> Result<PlannerEvent> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "events", id, expected_revision)?;
        let before = event_in(&tx, id)?;
        let at = now();
        match action {
            "archived" => {
                tx.execute(
                    "UPDATE events SET archived_at = COALESCE(archived_at, ?2),
                     revision = revision + 1, updated_at = ?2 WHERE id = ?1",
                    params![id, at],
                )
                .map_err(sql_error)?;
            }
            "restored" => {
                tx.execute(
                    "UPDATE events SET archived_at = NULL, trashed_at = NULL,
                     revision = revision + 1, updated_at = ?2 WHERE id = ?1",
                    params![id, at],
                )
                .map_err(sql_error)?;
            }
            "trashed" => {
                if before.archived_at.is_none() {
                    return Err(Error::Invalid(
                        "archive an event before moving it to Trash".into(),
                    ));
                }
                tx.execute(
                    "UPDATE events SET trashed_at = COALESCE(trashed_at, ?2),
                     revision = revision + 1, updated_at = ?2 WHERE id = ?1",
                    params![id, at],
                )
                .map_err(sql_error)?;
            }
            _ => return Err(Error::Invalid(format!("unknown event lifecycle {action}"))),
        }
        let after = event_in(&tx, id)?;
        record_activity(
            &tx,
            ("event", id),
            &at,
            action,
            &format!("{} event", action.trim_end_matches('d')),
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }

    pub fn archive_event(&mut self, id: &str, revision: i64) -> Result<PlannerEvent> {
        self.event_lifecycle(id, revision, "archived")
    }

    pub fn restore_event(&mut self, id: &str, revision: i64) -> Result<PlannerEvent> {
        self.event_lifecycle(id, revision, "restored")
    }

    pub fn trash_event(&mut self, id: &str, revision: i64) -> Result<PlannerEvent> {
        self.event_lifecycle(id, revision, "trashed")
    }

    pub fn cancel_event_occurrence(
        &mut self,
        series_id: &str,
        expected_revision: i64,
        occurrence_key: &str,
    ) -> Result<PlannerEvent> {
        let occurrence_date = NaiveDate::parse_from_str(occurrence_key, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("occurrence key must be an ISO date".into()))?;
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "events", series_id, expected_revision)?;
        let before = event_in(&tx, series_id)?;
        if before.recurrence_rule.is_none()
            || super::recurrence::expand(&before, occurrence_date, occurrence_date)?.is_empty()
        {
            return Err(Error::Invalid(
                "the requested occurrence does not belong to this series".into(),
            ));
        }
        let at = now();
        tx.execute(
            "INSERT INTO event_exceptions(series_id, occurrence_key, action, replacement_event_id)
             VALUES (?1, ?2, 'cancelled', NULL)
             ON CONFLICT(series_id, occurrence_key) DO UPDATE SET action = 'cancelled', replacement_event_id = NULL",
            params![series_id, occurrence_key],
        )
        .map_err(sql_error)?;
        tx.execute(
            "UPDATE events SET revision = revision + 1, updated_at = ?2 WHERE id = ?1",
            params![series_id, at],
        )
        .map_err(sql_error)?;
        let after = event_in(&tx, series_id)?;
        record_activity(
            &tx,
            ("event", series_id),
            &at,
            "occurrence-cancelled",
            &format!("Cancelled occurrence {occurrence_key}"),
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }

    pub fn replace_event_occurrence(
        &mut self,
        series_id: &str,
        expected_revision: i64,
        occurrence_key: &str,
        input: CreateEvent,
    ) -> Result<PlannerEvent> {
        let occurrence_date = NaiveDate::parse_from_str(occurrence_key, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("occurrence key must be an ISO date".into()))?;
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "events", series_id, expected_revision)?;
        let series = event_in(&tx, series_id)?;
        if series.recurrence_rule.is_none()
            || super::recurrence::expand(&series, occurrence_date, occurrence_date)?.is_empty()
        {
            return Err(Error::Invalid(
                "the requested occurrence does not belong to this series".into(),
            ));
        }
        let at = now();
        let replacement = insert_event(&tx, input, Some(series_id), &at)?;
        tx.execute(
            "INSERT INTO event_exceptions(series_id, occurrence_key, action, replacement_event_id)
             VALUES (?1, ?2, 'replaced', ?3)
             ON CONFLICT(series_id, occurrence_key) DO UPDATE SET action = 'replaced', replacement_event_id = ?3",
            params![series_id, occurrence_key, replacement.id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "UPDATE events SET revision = revision + 1, updated_at = ?2 WHERE id = ?1",
            params![series_id, at],
        )
        .map_err(sql_error)?;
        record_activity(
            &tx,
            ("event", series_id),
            &at,
            "occurrence-replaced",
            &format!("Edited occurrence {occurrence_key}"),
            None,
            Some(serde_json::to_value(&replacement).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(replacement)
    }

    pub fn calendar_range(&self, from: &str, to: &str) -> Result<CalendarRange> {
        let from_date = NaiveDate::parse_from_str(from, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("calendar from must be an ISO date".into()))?;
        let to_date = NaiveDate::parse_from_str(to, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("calendar to must be an ISO date".into()))?;
        if to_date < from_date || (to_date - from_date).num_days() > 370 {
            return Err(Error::Invalid(
                "calendar range must be ordered and at most 371 days".into(),
            ));
        }

        let events = self.list_events(false, false)?;
        let mut event_occurrences = Vec::new();
        for event in events {
            let mut exceptions = HashMap::new();
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT occurrence_key, action, replacement_event_id FROM event_exceptions
                     WHERE series_id = ?1",
                )
                .map_err(sql_error)?;
            for row in stmt
                .query_map([&event.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(sql_error)?
            {
                let (key, action, replacement) = row.map_err(sql_error)?;
                exceptions.insert(key, (action, replacement));
            }
            for (key, start, end) in super::recurrence::expand(&event, from_date, to_date)? {
                if let Some((action, replacement_id)) = exceptions.get(&key) {
                    if action == "cancelled" {
                        continue;
                    }
                    if let Some(replacement_id) = replacement_id {
                        let replacement = self
                            .conn
                            .query_row(
                                &format!("SELECT {EVENT_COLUMNS} FROM events WHERE id = ?1"),
                                [replacement_id],
                                row_to_event,
                            )
                            .map_err(sql_error)?;
                        for (replacement_key, replacement_start, replacement_end) in
                            super::recurrence::expand(&replacement, from_date, to_date)?
                        {
                            let mut expanded = occurrence(
                                &replacement,
                                &event.id,
                                replacement_key,
                                replacement_start,
                                replacement_end,
                                true,
                            );
                            if expanded.color.is_none() {
                                expanded.color =
                                    epic_color(&self.conn, expanded.epic_id.as_deref())?;
                            }
                            event_occurrences.push(expanded);
                        }
                        continue;
                    }
                }
                let mut expanded = occurrence(
                    &event,
                    &event.id,
                    key,
                    start,
                    end,
                    event.recurrence_rule.is_some(),
                );
                if expanded.color.is_none() {
                    expanded.color = epic_color(&self.conn, expanded.epic_id.as_deref())?;
                }
                event_occurrences.push(expanded);
            }
        }
        event_occurrences.sort_by(|a, b| {
            a.start_value
                .cmp(&b.start_value)
                .then_with(|| a.title.cmp(&b.title))
        });

        let tasks = self.list_tasks(false, false)?;
        let task_by_id: HashMap<&str, &super::PlannerTask> =
            tasks.iter().map(|task| (task.id.as_str(), task)).collect();
        let mut sessions = self.list_work_sessions(None, false)?;
        sessions.retain(|session| session_overlaps(session, from_date, to_date));
        let mut work_sessions = Vec::new();
        let mut workload = BTreeMap::<String, i64>::new();
        let mut date = from_date;
        while date <= to_date {
            workload.insert(date.to_string(), 0);
            date = date
                .succ_opt()
                .ok_or_else(|| Error::Invalid("calendar range overflow".into()))?;
        }
        for session in sessions {
            let task = task_by_id.get(session.task_id.as_str()).ok_or_else(|| {
                Error::Invalid(format!(
                    "work session {} references a missing task",
                    session.id
                ))
            })?;
            let color = epic_color(&self.conn, task.epic_id.as_deref())?;
            let (day, minutes) = session_workload(&session, task.estimate_minutes)?;
            if let Some(total) = workload.get_mut(&day) {
                *total += minutes;
            }
            work_sessions.push(CalendarWorkSession {
                session,
                task_title: task.title.clone(),
                task_status: task.status,
                epic_id: task.epic_id.clone(),
                color,
            });
        }
        drop(task_by_id);

        let mut due_markers = Vec::new();
        let mut unscheduled_tasks = Vec::new();
        for task in tasks {
            if let Some(due_date) = task.due_date.as_deref()
                && due_date >= from
                && due_date <= to
            {
                due_markers.push(DueMarker {
                    task_id: task.id.clone(),
                    title: task.title.clone(),
                    date: due_date.to_string(),
                    status: task.status,
                    epic_id: task.epic_id.clone(),
                    color: epic_color(&self.conn, task.epic_id.as_deref())?,
                });
            }
            if task.status != TaskStatus::Done {
                unscheduled_tasks.push(task);
            }
        }
        due_markers.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.title.cmp(&b.title)));
        unscheduled_tasks.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));

        Ok(CalendarRange {
            from: from.to_string(),
            to: to.to_string(),
            events: event_occurrences,
            work_sessions,
            due_markers,
            unscheduled_tasks,
            workload: workload
                .into_iter()
                .map(|(date, minutes)| DayWorkload { date, minutes })
                .collect(),
        })
    }
}

fn occurrence(
    event: &PlannerEvent,
    series_id: &str,
    occurrence_key: String,
    start_value: String,
    end_value: String,
    recurring: bool,
) -> EventOccurrence {
    EventOccurrence {
        event_id: event.id.clone(),
        series_id: series_id.to_string(),
        occurrence_key,
        title: event.title.clone(),
        description: event.description.clone(),
        location: event.location.clone(),
        meeting_url: event.meeting_url.clone(),
        participants: event.participants.clone(),
        epic_id: event.epic_id.clone(),
        color: event.color.clone(),
        all_day: event.all_day,
        start_value,
        end_value,
        timezone: event.timezone.clone(),
        recurring,
    }
}

fn epic_color(conn: &rusqlite::Connection, epic_id: Option<&str>) -> Result<Option<String>> {
    let Some(epic_id) = epic_id else {
        return Ok(None);
    };
    conn.query_row("SELECT color FROM epics WHERE id = ?1", [epic_id], |row| {
        row.get(0)
    })
    .optional()
    .map_err(sql_error)
}

fn session_overlaps(session: &WorkSession, from: NaiveDate, to: NaiveDate) -> bool {
    if session.all_day {
        let Ok(start) = NaiveDate::parse_from_str(&session.start_value, "%Y-%m-%d") else {
            return false;
        };
        let Ok(end) = NaiveDate::parse_from_str(&session.end_value, "%Y-%m-%d") else {
            return false;
        };
        return start <= to && end > from;
    }
    let Ok(timezone) = session.timezone.parse::<Tz>() else {
        return false;
    };
    let Ok(start) = DateTime::parse_from_rfc3339(&session.start_value) else {
        return false;
    };
    let Ok(end) = DateTime::parse_from_rfc3339(&session.end_value) else {
        return false;
    };
    start.with_timezone(&timezone).date_naive() <= to
        && end.with_timezone(&timezone).date_naive() >= from
}

fn session_workload(session: &WorkSession, estimate: Option<i64>) -> Result<(String, i64)> {
    if session.all_day {
        return Ok((session.start_value.clone(), estimate.unwrap_or(60)));
    }
    let timezone: Tz = session
        .timezone
        .parse()
        .map_err(|_| Error::Invalid(format!("unknown IANA timezone {:?}", session.timezone)))?;
    let start = DateTime::parse_from_rfc3339(&session.start_value)
        .map_err(|_| Error::Invalid("invalid session start".into()))?;
    let end = DateTime::parse_from_rfc3339(&session.end_value)
        .map_err(|_| Error::Invalid("invalid session end".into()))?;
    Ok((
        start.with_timezone(&timezone).date_naive().to_string(),
        (end - start).num_minutes().max(0),
    ))
}

impl Workspace {
    pub fn planner_work_sessions(
        &self,
        task_id: Option<&str>,
        include_cancelled: bool,
    ) -> Result<Vec<WorkSession>> {
        self.planner()?
            .list_work_sessions(task_id, include_cancelled)
    }

    pub fn create_planner_work_session(&self, input: CreateWorkSession) -> Result<WorkSession> {
        self.planner()?.create_work_session(input)
    }

    pub fn update_planner_work_session(
        &self,
        id: &str,
        input: UpdateWorkSession,
    ) -> Result<WorkSession> {
        self.planner()?.update_work_session(id, input)
    }

    pub fn cancel_planner_work_session(
        &self,
        id: &str,
        expected_revision: i64,
    ) -> Result<WorkSession> {
        self.planner()?.cancel_work_session(id, expected_revision)
    }

    pub fn planner_events(
        &self,
        include_archived: bool,
        include_trashed: bool,
    ) -> Result<Vec<PlannerEvent>> {
        self.planner()?
            .list_events(include_archived, include_trashed)
    }

    pub fn create_planner_event(&self, input: CreateEvent) -> Result<PlannerEvent> {
        self.planner()?.create_event(input)
    }

    pub fn update_planner_event(&self, id: &str, input: UpdateEvent) -> Result<PlannerEvent> {
        self.planner()?.update_event(id, input)
    }

    pub fn archive_planner_event(&self, id: &str, revision: i64) -> Result<PlannerEvent> {
        self.planner()?.archive_event(id, revision)
    }

    pub fn restore_planner_event(&self, id: &str, revision: i64) -> Result<PlannerEvent> {
        self.planner()?.restore_event(id, revision)
    }

    pub fn trash_planner_event(&self, id: &str, revision: i64) -> Result<PlannerEvent> {
        self.planner()?.trash_event(id, revision)
    }

    pub fn cancel_planner_event_occurrence(
        &self,
        series_id: &str,
        revision: i64,
        occurrence_key: &str,
    ) -> Result<PlannerEvent> {
        self.planner()?
            .cancel_event_occurrence(series_id, revision, occurrence_key)
    }

    pub fn replace_planner_event_occurrence(
        &self,
        series_id: &str,
        revision: i64,
        occurrence_key: &str,
        input: CreateEvent,
    ) -> Result<PlannerEvent> {
        self.planner()?
            .replace_event_occurrence(series_id, revision, occurrence_key, input)
    }

    pub fn planner_calendar_range(&self, from: &str, to: &str) -> Result<CalendarRange> {
        self.planner()?.calendar_range(from, to)
    }
}
