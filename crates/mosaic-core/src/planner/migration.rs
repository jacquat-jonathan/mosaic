use super::{
    PlannerStore, TaskStatus, bump_store_revision, now, record_activity, sql_error, store_revision,
};
use crate::api::Workspace;
use crate::error::{Error, Result};
use crate::index::TaskMeta;
use chrono::Days;
use regex::Regex;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

static BLOCK_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s\^([A-Za-z0-9-]+)\s*$").expect("valid block regex"));
static DUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*📅\s*\d{4}-\d{2}-\d{2}").expect("valid due regex"));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarkdownImportCandidate {
    pub source_path: String,
    pub source_line: usize,
    pub block_id: Option<String>,
    pub fingerprint: String,
    pub parent_fingerprint: Option<String>,
    pub depth: usize,
    pub title: String,
    pub status: TaskStatus,
    pub due_date: Option<String>,
    pub all_day_session_date: Option<String>,
    pub archived: bool,
    pub default_selected: bool,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarkdownImportGroup {
    pub source_path: String,
    pub tasks: Vec<MarkdownImportCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarkdownImportPreview {
    pub planner_revision: i64,
    pub groups: Vec<MarkdownImportGroup>,
    pub candidates: usize,
    pub selected_by_default: usize,
    pub duplicates: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarkdownImportResult {
    pub planner_revision: i64,
    pub imported_task_ids: Vec<String>,
    pub skipped_duplicates: Vec<String>,
}

fn block_id(text: &str) -> Option<String> {
    BLOCK_ID
        .captures(text)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_string())
}

fn title(text: &str) -> String {
    let text = crate::task_board::label(text);
    let text = BLOCK_ID.replace(&text, "");
    let title = DUE.replace_all(&text, "").trim().to_string();
    if title.is_empty() {
        "Untitled task".into()
    } else {
        title
    }
}

fn fingerprint(task: &TaskMeta, block_id: Option<&str>) -> String {
    let stable = match block_id {
        Some(block) => format!("{}\0block\0{block}", task.path),
        None => format!("{}\0line\0{}\0{}", task.path, task.line, title(&task.text)),
    };
    crate::vault::hash_bytes(stable.as_bytes())
}

fn mapped_status(task: &TaskMeta) -> TaskStatus {
    match task.mark {
        'x' | 'X' => TaskStatus::Done,
        '>' | '-' => TaskStatus::New,
        _ => match crate::task_board::state(&task.text, task.mark) {
            "blocked" => TaskStatus::Blocked,
            "in-progress" => TaskStatus::InProgress,
            "in-qa" => TaskStatus::InQa,
            "done" => TaskStatus::Done,
            _ => TaskStatus::New,
        },
    }
}

fn imported_task(
    tx: &Transaction<'_>,
    candidate: &MarkdownImportCandidate,
) -> Result<Option<String>> {
    if let Some(block) = candidate.block_id.as_deref() {
        tx.query_row(
            "SELECT imported_task_id FROM legacy_imports
             WHERE source_path = ?1 AND block_id = ?2 ORDER BY id DESC LIMIT 1",
            params![candidate.source_path, block],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)
    } else {
        tx.query_row(
            "SELECT imported_task_id FROM legacy_imports
             WHERE source_fingerprint = ?1 ORDER BY id DESC LIMIT 1",
            [&candidate.fingerprint],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)
    }
}

fn already_imported(store: &PlannerStore, candidate: &MarkdownImportCandidate) -> Result<bool> {
    if let Some(block) = candidate.block_id.as_deref() {
        store
            .conn
            .query_row(
                "SELECT 1 FROM legacy_imports WHERE source_path = ?1 AND block_id = ?2 LIMIT 1",
                params![candidate.source_path, block],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(sql_error)
    } else {
        store
            .conn
            .query_row(
                "SELECT 1 FROM legacy_imports WHERE source_fingerprint = ?1 LIMIT 1",
                [&candidate.fingerprint],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(sql_error)
    }
}

impl PlannerStore {
    fn import_markdown(
        &mut self,
        preview: &MarkdownImportPreview,
        selected: &[String],
        allow_duplicates: bool,
        timezone: &str,
    ) -> Result<MarkdownImportResult> {
        let timezone = timezone.trim();
        if timezone.is_empty() {
            return Err(Error::Invalid("import timezone cannot be empty".into()));
        }
        let all: HashMap<&str, &MarkdownImportCandidate> = preview
            .groups
            .iter()
            .flat_map(|group| &group.tasks)
            .map(|candidate| (candidate.fingerprint.as_str(), candidate))
            .collect();
        let selected: HashSet<&str> = selected.iter().map(String::as_str).collect();
        for fingerprint in &selected {
            if !all.contains_key(fingerprint) {
                return Err(Error::Invalid(format!(
                    "migration selection contains unknown task {fingerprint}"
                )));
            }
        }
        let mut candidates: Vec<&MarkdownImportCandidate> = all
            .values()
            .copied()
            .filter(|candidate| selected.contains(candidate.fingerprint.as_str()))
            .collect();
        candidates.sort_by_key(|candidate| {
            (
                candidate.source_path.as_str(),
                candidate.depth,
                candidate.source_line,
            )
        });
        if candidates.is_empty() {
            return Ok(MarkdownImportResult {
                planner_revision: store_revision(&self.conn)?,
                imported_task_ids: Vec::new(),
                skipped_duplicates: Vec::new(),
            });
        }

        let tx = self.conn.transaction().map_err(sql_error)?;
        let at = now();
        let mut mapped: HashMap<String, String> = HashMap::new();
        let mut imported_task_ids = Vec::new();
        let mut skipped_duplicates = Vec::new();
        for candidate in candidates {
            if !allow_duplicates && let Some(existing) = imported_task(&tx, candidate)? {
                mapped.insert(candidate.fingerprint.clone(), existing);
                skipped_duplicates.push(candidate.fingerprint.clone());
                continue;
            }
            let id = uuid::Uuid::new_v4().to_string();
            let parent_id = match candidate.parent_fingerprint.as_deref() {
                Some(parent) if mapped.contains_key(parent) => mapped.get(parent).cloned(),
                Some(parent) => match all.get(parent) {
                    Some(parent_candidate) => imported_task(&tx, parent_candidate)?,
                    None => None,
                },
                None => None,
            };
            let position: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(position), 0) + 1024 FROM tasks
                     WHERE epic_id IS NULL AND parent_id IS ?1 AND status = ?2",
                    params![parent_id, candidate.status.as_str()],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            let completed_at = (candidate.status == TaskStatus::Done).then_some(at.clone());
            let archived_at = candidate.archived.then_some(at.clone());
            tx.execute(
                "INSERT INTO tasks(id, epic_id, parent_id, title, description, status, due_date,
                                   estimate_minutes, position, revision, created_at, updated_at,
                                   completed_at, archived_at)
                 VALUES (?1, NULL, ?2, ?3, '', ?4, ?5, NULL, ?6, 1, ?7, ?7, ?8, ?9)",
                params![
                    id,
                    parent_id,
                    candidate.title,
                    candidate.status.as_str(),
                    candidate.due_date,
                    position,
                    at,
                    completed_at,
                    archived_at
                ],
            )
            .map_err(sql_error)?;
            tx.execute(
                "INSERT INTO note_links(owner_kind, owner_id, path, heading, block_id)
                 VALUES ('task', ?1, ?2, NULL, ?3)",
                params![id, candidate.source_path, candidate.block_id],
            )
            .map_err(sql_error)?;
            tx.execute(
                "INSERT INTO legacy_imports(source_path, source_line, block_id, source_fingerprint,
                                            imported_task_id, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    candidate.source_path,
                    candidate.source_line as i64,
                    candidate.block_id,
                    candidate.fingerprint,
                    id,
                    at
                ],
            )
            .map_err(sql_error)?;
            record_activity(
                &tx,
                ("task", &id),
                &at,
                "imported",
                &format!(
                    "Imported from Markdown at {}:{}",
                    candidate.source_path, candidate.source_line
                ),
                None,
                Some(serde_json::json!({
                    "source_path": candidate.source_path,
                    "source_line": candidate.source_line,
                    "block_id": candidate.block_id,
                    "status": candidate.status,
                })),
            )?;
            if let Some(date) = candidate.all_day_session_date.as_deref() {
                let date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .map_err(|_| Error::Invalid(format!("invalid daily-note date {date}")))?;
                let end = date
                    .checked_add_days(Days::new(1))
                    .ok_or_else(|| Error::Invalid("daily-note date is out of range".into()))?;
                let session_id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO work_sessions(id, task_id, all_day, start_value, end_value, timezone,
                                               state, revision, created_at, updated_at)
                     VALUES (?1, ?2, 1, ?3, ?4, ?5, 'planned', 1, ?6, ?6)",
                    params![session_id, id, date.to_string(), end.to_string(), timezone, at],
                )
                .map_err(sql_error)?;
                record_activity(
                    &tx,
                    ("work_session", &session_id),
                    &at,
                    "imported",
                    "Imported all-day work session from daily note",
                    None,
                    Some(serde_json::json!({"task_id": id, "date": date.to_string()})),
                )?;
            }
            mapped.insert(candidate.fingerprint.clone(), id.clone());
            imported_task_ids.push(id);
        }
        let planner_revision = if imported_task_ids.is_empty() {
            store_revision(&tx)?
        } else {
            bump_store_revision(&tx, &at)?
        };
        tx.commit().map_err(sql_error)?;
        Ok(MarkdownImportResult {
            planner_revision,
            imported_task_ids,
            skipped_duplicates,
        })
    }
}

impl Workspace {
    pub fn preview_markdown_planner_import(&self) -> Result<MarkdownImportPreview> {
        let rules = self.rules();
        let preferences = self.vault_preferences()?;
        let tasks: Vec<TaskMeta> = self
            .reading()
            .tasks()?
            .into_iter()
            .filter(|task| Self::visible(&rules, &task.path))
            .collect();

        let mut fingerprints: HashMap<(String, usize), String> = HashMap::new();
        for task in &tasks {
            let block = block_id(&task.text);
            fingerprints.insert(
                (task.path.clone(), task.line),
                fingerprint(task, block.as_deref()),
            );
        }
        let planner = self.planner.lock().unwrap_or_else(|p| p.into_inner());
        let mut groups: BTreeMap<String, Vec<MarkdownImportCandidate>> = BTreeMap::new();
        for task in tasks {
            let block_id = block_id(&task.text);
            let fingerprint = fingerprints[&(task.path.clone(), task.line)].clone();
            let parent_fingerprint = task
                .parent
                .and_then(|line| fingerprints.get(&(task.path.clone(), line)).cloned());
            let status = mapped_status(&task);
            let archived = matches!(task.mark, '>' | '-');
            let default_selected = !archived && status != TaskStatus::Done;
            let daily_date = preferences
                .daily_date(&task.path)
                .map(|date| date.to_string());
            let mut candidate = MarkdownImportCandidate {
                source_path: task.path.clone(),
                source_line: task.line,
                block_id,
                fingerprint,
                parent_fingerprint,
                depth: task.depth,
                title: title(&task.text),
                status,
                due_date: task.due,
                all_day_session_date: daily_date,
                archived,
                default_selected,
                duplicate: false,
            };
            candidate.duplicate = already_imported(&planner, &candidate)?;
            groups
                .entry(candidate.source_path.clone())
                .or_default()
                .push(candidate);
        }
        let groups: Vec<MarkdownImportGroup> = groups
            .into_iter()
            .map(|(source_path, tasks)| MarkdownImportGroup { source_path, tasks })
            .collect();
        let candidates = groups.iter().map(|group| group.tasks.len()).sum();
        let selected_by_default = groups
            .iter()
            .flat_map(|group| &group.tasks)
            .filter(|candidate| candidate.default_selected && !candidate.duplicate)
            .count();
        let duplicates = groups
            .iter()
            .flat_map(|group| &group.tasks)
            .filter(|candidate| candidate.duplicate)
            .count();
        Ok(MarkdownImportPreview {
            planner_revision: store_revision(&planner.conn)?,
            groups,
            candidates,
            selected_by_default,
            duplicates,
        })
    }

    pub fn import_markdown_tasks_to_planner(
        &self,
        preview: &MarkdownImportPreview,
        selected_fingerprints: &[String],
        allow_duplicates: bool,
        timezone: &str,
    ) -> Result<MarkdownImportResult> {
        self.planner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .import_markdown(preview, selected_fingerprints, allow_duplicates, timezone)
    }
}
