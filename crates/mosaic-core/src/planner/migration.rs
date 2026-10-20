use super::service::PlannerService;
use super::{
    PlannerStore, TaskStatus, bump_store_revision, now, record_activity, sql_error, store_revision,
};
use crate::api::{Context, Workspace};
use crate::error::{Error, Result};
use crate::index::TaskMeta;
use regex::Regex;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

static BLOCK_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s\^([A-Za-z0-9-]+)\s*$").expect("valid block regex"));
static DUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*📅\s*\d{4}-\d{2}-\d{2}").expect("valid due regex"));

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum MarkdownImportKind {
    Epic,
    Task,
    Subtask,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MarkdownImportCandidate {
    pub source_path: String,
    pub source_line: usize,
    pub block_id: Option<String>,
    pub fingerprint: String,
    pub parent_fingerprint: Option<String>,
    pub epic_fingerprint: Option<String>,
    pub depth: usize,
    pub kind: MarkdownImportKind,
    pub title: String,
    pub status: TaskStatus,
    pub due_date: Option<String>,
    pub all_day_session_date: Option<String>,
    pub archived: bool,
    pub default_selected: bool,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MarkdownImportGroup {
    pub source_path: String,
    pub tasks: Vec<MarkdownImportCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MarkdownImportPreview {
    pub planner_revision: i64,
    pub groups: Vec<MarkdownImportGroup>,
    pub candidates: usize,
    pub selected_by_default: usize,
    pub duplicates: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MarkdownImportResult {
    pub planner_revision: i64,
    pub imported_epic_ids: Vec<String>,
    pub imported_task_ids: Vec<String>,
    pub skipped_duplicates: Vec<String>,
}

#[derive(Debug, Clone)]
enum ImportedEntity {
    Epic(String),
    Task(String),
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

fn imported_entity(
    tx: &Transaction<'_>,
    candidate: &MarkdownImportCandidate,
) -> Result<Option<ImportedEntity>> {
    let read = |row: &rusqlite::Row<'_>| {
        let task_id: Option<String> = row.get(0)?;
        let epic_id: Option<String> = row.get(1)?;
        Ok(match (task_id, epic_id) {
            (Some(id), None) => Some(ImportedEntity::Task(id)),
            (None, Some(id)) => Some(ImportedEntity::Epic(id)),
            _ => None,
        })
    };
    if let Some(block) = candidate.block_id.as_deref() {
        tx.query_row(
            "SELECT imported_task_id, imported_epic_id FROM legacy_imports
             WHERE source_path = ?1 AND block_id = ?2 ORDER BY id DESC LIMIT 1",
            params![candidate.source_path, block],
            read,
        )
        .optional()
        .map(Option::flatten)
        .map_err(sql_error)
    } else {
        tx.query_row(
            "SELECT imported_task_id, imported_epic_id FROM legacy_imports
             WHERE source_fingerprint = ?1 ORDER BY id DESC LIMIT 1",
            [&candidate.fingerprint],
            read,
        )
        .optional()
        .map(Option::flatten)
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
                imported_epic_ids: Vec::new(),
                imported_task_ids: Vec::new(),
                skipped_duplicates: Vec::new(),
            });
        }

        let tx = self.conn.transaction().map_err(sql_error)?;
        let at = now();
        let mut mapped_epics: HashMap<String, String> = HashMap::new();
        let mut mapped_tasks: HashMap<String, String> = HashMap::new();
        let mut imported_epic_ids = Vec::new();
        let mut imported_task_ids = Vec::new();
        let mut skipped_duplicates = Vec::new();
        for candidate in candidates {
            if !allow_duplicates && let Some(existing) = imported_entity(&tx, candidate)? {
                match existing {
                    ImportedEntity::Epic(id) => {
                        mapped_epics.insert(candidate.fingerprint.clone(), id);
                    }
                    ImportedEntity::Task(id) => {
                        mapped_tasks.insert(candidate.fingerprint.clone(), id);
                    }
                }
                skipped_duplicates.push(candidate.fingerprint.clone());
                continue;
            }

            let id = uuid::Uuid::new_v4().to_string();
            if candidate.kind == MarkdownImportKind::Epic {
                let position: i64 = tx
                    .query_row(
                        "SELECT COALESCE(MAX(position), 0) + 1024 FROM epics",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(sql_error)?;
                let archived_at = candidate.archived.then_some(at.clone());
                tx.execute(
                    "INSERT INTO epics(id, title, description, color, position, revision,
                                       created_at, updated_at, archived_at)
                     VALUES (?1, ?2, '', '#6477d4', ?3, 1, ?4, ?4, ?5)",
                    params![id, candidate.title, position, at, archived_at],
                )
                .map_err(sql_error)?;
                tx.execute(
                    "INSERT INTO note_links(owner_kind, owner_id, path, heading, block_id)
                     VALUES ('epic', ?1, ?2, NULL, ?3)",
                    params![id, candidate.source_path, candidate.block_id],
                )
                .map_err(sql_error)?;
                tx.execute(
                    "INSERT INTO legacy_imports(
                        source_path, source_line, block_id, source_fingerprint,
                        imported_task_id, imported_epic_id, imported_at
                     ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)",
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
                    ("epic", &id),
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
                    })),
                )?;
                mapped_epics.insert(candidate.fingerprint.clone(), id.clone());
                imported_epic_ids.push(id);
                continue;
            }

            let epic_id = match candidate.epic_fingerprint.as_deref() {
                Some(epic) if mapped_epics.contains_key(epic) => mapped_epics.get(epic).cloned(),
                Some(epic) => match all.get(epic) {
                    Some(epic_candidate) => match imported_entity(&tx, epic_candidate)? {
                        Some(ImportedEntity::Epic(id)) => Some(id),
                        _ => None,
                    },
                    None => None,
                },
                None => None,
            };
            let parent_id = match candidate.parent_fingerprint.as_deref() {
                Some(parent)
                    if all
                        .get(parent)
                        .is_some_and(|candidate| candidate.kind == MarkdownImportKind::Epic) =>
                {
                    None
                }
                Some(parent) if mapped_tasks.contains_key(parent) => {
                    mapped_tasks.get(parent).cloned()
                }
                Some(parent) => match all.get(parent) {
                    Some(parent_candidate) => match imported_entity(&tx, parent_candidate)? {
                        Some(ImportedEntity::Task(id)) => Some(id),
                        _ => None,
                    },
                    None => None,
                },
                None => None,
            };
            let position: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(position), 0) + 1024 FROM tasks
                     WHERE epic_id IS ?1 AND parent_id IS ?2 AND status = ?3",
                    params![epic_id, parent_id, candidate.status.as_str()],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            let completed_at = (candidate.status == TaskStatus::Done).then_some(at.clone());
            let archived_at = candidate.archived.then_some(at.clone());
            tx.execute(
                "INSERT INTO tasks(id, epic_id, parent_id, title, description, status, due_date,
                                   estimate_minutes, position, revision, created_at, updated_at,
                                   completed_at, archived_at)
                 VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, NULL, ?7, 1, ?8, ?8, ?9, ?10)",
                params![
                    id,
                    epic_id,
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
                "INSERT INTO legacy_imports(
                    source_path, source_line, block_id, source_fingerprint,
                    imported_task_id, imported_epic_id, imported_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
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
            mapped_tasks.insert(candidate.fingerprint.clone(), id.clone());
            imported_task_ids.push(id);
        }
        let planner_revision = if imported_epic_ids.is_empty() && imported_task_ids.is_empty() {
            store_revision(&tx)?
        } else {
            bump_store_revision(&tx, &at)?
        };
        tx.commit().map_err(sql_error)?;
        Ok(MarkdownImportResult {
            planner_revision,
            imported_epic_ids,
            imported_task_ids,
            skipped_duplicates,
        })
    }
}

// Reads the vault's Markdown tasks (index and agent folder rules) as well as the planner, so it
// lives on the workspace, which coordinates the services, rather than on `PlannerService`.
impl Workspace {
    pub fn preview_markdown_planner_import(&self) -> Result<MarkdownImportPreview> {
        let rules = self.rules()?;
        let tasks: Vec<TaskMeta> = self
            .reading()
            .tasks()?
            .into_iter()
            .filter(|task| Context::visible(&rules, &task.path))
            .collect();

        let mut fingerprints: HashMap<(String, usize), String> = HashMap::new();
        let mut structure: HashMap<(String, usize), (usize, Option<usize>)> = HashMap::new();
        for task in &tasks {
            let block = block_id(&task.text);
            fingerprints.insert(
                (task.path.clone(), task.line),
                fingerprint(task, block.as_deref()),
            );
            structure.insert((task.path.clone(), task.line), (task.depth, task.parent));
        }
        let planner = self.planner.store()?;
        let mut groups: BTreeMap<String, Vec<MarkdownImportCandidate>> = BTreeMap::new();
        for task in tasks {
            let block_id = block_id(&task.text);
            let fingerprint = fingerprints[&(task.path.clone(), task.line)].clone();
            let parent_fingerprint = task
                .parent
                .and_then(|line| fingerprints.get(&(task.path.clone(), line)).cloned());
            let mut ancestor_line = Some(task.line);
            let mut epic_fingerprint = None;
            while let Some(line) = ancestor_line {
                let Some((depth, parent)) = structure.get(&(task.path.clone(), line)) else {
                    break;
                };
                if *depth == 0 {
                    epic_fingerprint = fingerprints.get(&(task.path.clone(), line)).cloned();
                    break;
                }
                ancestor_line = *parent;
            }
            let kind = match task.depth {
                0 => MarkdownImportKind::Epic,
                1 => MarkdownImportKind::Task,
                _ => MarkdownImportKind::Subtask,
            };
            let status = mapped_status(&task);
            let archived = matches!(task.mark, '>' | '-');
            let default_selected =
                !archived && (kind == MarkdownImportKind::Epic || status != TaskStatus::Done);
            let mut candidate = MarkdownImportCandidate {
                source_path: task.path.clone(),
                source_line: task.line,
                block_id,
                fingerprint,
                parent_fingerprint,
                epic_fingerprint,
                depth: task.depth,
                kind,
                title: title(&task.text),
                status,
                due_date: task.due,
                all_day_session_date: None,
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
}

impl PlannerService {
    pub fn import_markdown_tasks(
        &self,
        preview: &MarkdownImportPreview,
        selected_fingerprints: &[String],
        allow_duplicates: bool,
        timezone: &str,
    ) -> Result<MarkdownImportResult> {
        self.store()?
            .import_markdown(preview, selected_fingerprints, allow_duplicates, timezone)
    }
}
