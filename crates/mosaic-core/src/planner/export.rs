use super::{ActivityEntry, PlannerStore, PlannerSummary, now, sql_error};
use crate::api::Workspace;
use crate::error::Result;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct PlannerExport {
    format_version: u32,
    exported_at: String,
    summary: PlannerSummary,
    epics: Vec<super::Epic>,
    tasks: Vec<super::PlannerTask>,
    work_sessions: Vec<super::WorkSession>,
    events: Vec<super::PlannerEvent>,
    activity: Vec<ActivityEntry>,
}

impl PlannerStore {
    fn all_activity(&self) -> Result<Vec<ActivityEntry>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, entity_kind, entity_id, occurred_at, action, summary, before_json, after_json
                 FROM activity ORDER BY id",
            )
            .map_err(sql_error)?;
        statement
            .query_map([], |row| {
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

    pub fn export_json(&self) -> Result<String> {
        let export = PlannerExport {
            format_version: 1,
            exported_at: now(),
            summary: self.summary()?,
            epics: self.list_epics(true, true)?,
            tasks: self.list_tasks(true, true)?,
            work_sessions: self.list_work_sessions(None, true)?,
            events: self.list_events(true, true)?,
            activity: self.all_activity()?,
        };
        serde_json::to_string_pretty(&export)
            .map(|value| format!("{value}\n"))
            .map_err(|error| crate::error::Error::Invalid(error.to_string()))
    }

    pub fn export_csv(&self) -> Result<String> {
        let mut output = vec![
            "entity_type,id,parent_id,epic_id,status,title,start,end,due_date,estimate_minutes,archived_at,trashed_at".to_string(),
        ];
        for epic in self.list_epics(true, true)? {
            output.push(csv_row(&[
                "epic",
                &epic.id,
                "",
                &epic.id,
                "",
                &epic.title,
                "",
                "",
                "",
                "",
                epic.archived_at.as_deref().unwrap_or(""),
                epic.trashed_at.as_deref().unwrap_or(""),
            ]));
        }
        for task in self.list_tasks(true, true)? {
            output.push(csv_row(&[
                "task",
                &task.id,
                task.parent_id.as_deref().unwrap_or(""),
                task.epic_id.as_deref().unwrap_or(""),
                task.status.as_str(),
                &task.title,
                "",
                "",
                task.due_date.as_deref().unwrap_or(""),
                &task
                    .estimate_minutes
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
                task.archived_at.as_deref().unwrap_or(""),
                task.trashed_at.as_deref().unwrap_or(""),
            ]));
        }
        for session in self.list_work_sessions(None, true)? {
            output.push(csv_row(&[
                "work_session",
                &session.id,
                &session.task_id,
                "",
                &session.state,
                "",
                &session.start_value,
                &session.end_value,
                "",
                "",
                "",
                "",
            ]));
        }
        for event in self.list_events(true, true)? {
            output.push(csv_row(&[
                "event",
                &event.id,
                "",
                event.epic_id.as_deref().unwrap_or(""),
                "",
                &event.title,
                &event.start_value,
                &event.end_value,
                "",
                "",
                event.archived_at.as_deref().unwrap_or(""),
                event.trashed_at.as_deref().unwrap_or(""),
            ]));
        }
        Ok(format!("{}\r\n", output.join("\r\n")))
    }
}

fn csv_row(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| format!("\"{}\"", value.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(",")
}

impl Workspace {
    pub fn export_planner_json(&self) -> Result<String> {
        self.planner()?.export_json()
    }

    pub fn export_planner_csv(&self) -> Result<String> {
        self.planner()?.export_csv()
    }
}
