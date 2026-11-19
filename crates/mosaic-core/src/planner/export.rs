use super::service::PlannerService;
use super::{
    ACTIVITY_SELECT, ActivityEntry, PlannerStore, PlannerSummary, activity_row, now, sql_error,
};
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

/// One export and the state it was taken at.
#[derive(Debug)]
pub struct PlannerExportSnapshot {
    pub revision: i64,
    pub exported_at: String,
    pub content: String,
}

impl PlannerStore {
    fn all_activity(&self) -> Result<Vec<ActivityEntry>> {
        let mut statement = self
            .conn
            .prepare(&format!("{ACTIVITY_SELECT} ORDER BY id"))
            .map_err(sql_error)?;
        statement
            .query_map([], activity_row)
            .map_err(sql_error)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_error)
    }

    pub fn export_json(&self) -> Result<String> {
        self.export_json_at(&now())
    }

    /// The JSON export stamped with `exported_at`, so the same planner revision gives the same
    /// bytes (MCP pages one export over several calls).
    pub fn export_json_at(&self, exported_at: &str) -> Result<String> {
        let export = PlannerExport {
            format_version: 1,
            exported_at: exported_at.to_string(),
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

impl PlannerService {
    pub fn export_json(&self) -> Result<String> {
        self.store()?.export_json()
    }

    pub fn export_csv(&self) -> Result<String> {
        self.store()?.export_csv()
    }

    /// The `json` or `csv` export with the planner revision it reflects, read under one lock.
    /// `exported_at` stamps the JSON export (default now; CSV has no timestamp), so the same
    /// revision and stamp give the same bytes.
    pub fn export_snapshot(
        &self,
        format: &str,
        exported_at: Option<&str>,
    ) -> Result<PlannerExportSnapshot> {
        let store = self.store()?;
        let exported_at = exported_at.map_or_else(now, str::to_string);
        let content = match format {
            "json" => store.export_json_at(&exported_at)?,
            "csv" => store.export_csv()?,
            _ => {
                return Err(crate::error::Error::Invalid(
                    "planner export must be JSON or CSV".into(),
                ));
            }
        };
        Ok(PlannerExportSnapshot {
            revision: store.summary()?.revision,
            exported_at,
            content,
        })
    }
}
