use crate::{AppState, CmdResult};
use mosaic_core::Workspace;
use mosaic_core::planner::{
    CreateEpic, CreateTask, Epic, FutureSessionPolicy, MarkdownImportPreview, MarkdownImportResult,
    MoveTask, PlannerSummary, PlannerTask, UpdateEpic, UpdateTask,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
struct PlannerChanged {
    root: String,
    revision: i64,
    affected_ids: Vec<String>,
}

fn changed(
    app: &AppHandle,
    workspace: &Arc<Workspace>,
    affected_ids: Vec<String>,
) -> CmdResult<()> {
    app.emit(
        "planner-changed",
        PlannerChanged {
            root: workspace.vault.root().display().to_string(),
            revision: workspace.planner_summary()?.revision,
            affected_ids,
        },
    )
    .ok();
    Ok(())
}

#[tauri::command]
pub(crate) fn planner_summary(state: State<AppState>) -> CmdResult<PlannerSummary> {
    state.get()?.planner_summary()
}

#[tauri::command]
pub(crate) fn planner_epics(
    state: State<AppState>,
    include_archived: bool,
    include_trashed: bool,
) -> CmdResult<Vec<Epic>> {
    state
        .get()?
        .planner_epics(include_archived, include_trashed)
}

#[tauri::command]
pub(crate) fn planner_tasks(
    state: State<AppState>,
    include_archived: bool,
    include_trashed: bool,
) -> CmdResult<Vec<PlannerTask>> {
    state
        .get()?
        .planner_tasks(include_archived, include_trashed)
}

#[tauri::command]
pub(crate) fn planner_create_epic(
    app: AppHandle,
    state: State<AppState>,
    input: CreateEpic,
) -> CmdResult<Epic> {
    let workspace = state.get()?;
    let epic = workspace.create_planner_epic(input)?;
    changed(&app, &workspace, vec![epic.id.clone()])?;
    Ok(epic)
}

#[tauri::command]
pub(crate) fn planner_update_epic(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: UpdateEpic,
) -> CmdResult<Epic> {
    let workspace = state.get()?;
    let epic = workspace.update_planner_epic(&id, input)?;
    changed(&app, &workspace, vec![epic.id.clone()])?;
    Ok(epic)
}

macro_rules! epic_lifecycle {
    ($name:ident, $method:ident) => {
        #[tauri::command]
        pub(crate) fn $name(
            app: AppHandle,
            state: State<AppState>,
            id: String,
            expected_revision: i64,
        ) -> CmdResult<Epic> {
            let workspace = state.get()?;
            let epic = workspace.$method(&id, expected_revision)?;
            changed(&app, &workspace, vec![epic.id.clone()])?;
            Ok(epic)
        }
    };
}

epic_lifecycle!(planner_archive_epic, archive_planner_epic);
epic_lifecycle!(planner_restore_epic, restore_planner_epic);
epic_lifecycle!(planner_trash_epic, trash_planner_epic);

#[tauri::command]
pub(crate) fn planner_create_task(
    app: AppHandle,
    state: State<AppState>,
    input: CreateTask,
) -> CmdResult<PlannerTask> {
    let workspace = state.get()?;
    let task = workspace.create_planner_task(input)?;
    changed(&app, &workspace, vec![task.id.clone()])?;
    Ok(task)
}

#[tauri::command]
pub(crate) fn planner_update_task(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: UpdateTask,
) -> CmdResult<PlannerTask> {
    let workspace = state.get()?;
    let task = workspace.update_planner_task(&id, input)?;
    changed(&app, &workspace, vec![task.id.clone()])?;
    Ok(task)
}

#[tauri::command]
pub(crate) fn planner_move_task(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: MoveTask,
) -> CmdResult<PlannerTask> {
    let workspace = state.get()?;
    let task = workspace.move_planner_task(&id, input)?;
    changed(&app, &workspace, vec![task.id.clone()])?;
    Ok(task)
}

#[tauri::command]
pub(crate) fn planner_complete_task(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    expected_revision: i64,
    allow_incomplete_subtasks: bool,
    future_sessions: FutureSessionPolicy,
) -> CmdResult<PlannerTask> {
    let workspace = state.get()?;
    let task = workspace.complete_planner_task(
        &id,
        expected_revision,
        allow_incomplete_subtasks,
        future_sessions,
    )?;
    changed(&app, &workspace, vec![task.id.clone()])?;
    Ok(task)
}

macro_rules! task_lifecycle {
    ($name:ident, $method:ident) => {
        #[tauri::command]
        pub(crate) fn $name(
            app: AppHandle,
            state: State<AppState>,
            id: String,
            expected_revision: i64,
        ) -> CmdResult<PlannerTask> {
            let workspace = state.get()?;
            let task = workspace.$method(&id, expected_revision)?;
            changed(&app, &workspace, vec![task.id.clone()])?;
            Ok(task)
        }
    };
}

task_lifecycle!(planner_reopen_task, reopen_planner_task);
task_lifecycle!(planner_archive_task, archive_planner_task);
task_lifecycle!(planner_restore_task, restore_planner_task);
task_lifecycle!(planner_trash_task, trash_planner_task);

#[tauri::command]
pub(crate) fn planner_migration_preview(
    state: State<AppState>,
) -> CmdResult<MarkdownImportPreview> {
    state.get()?.preview_markdown_planner_import()
}

#[tauri::command]
pub(crate) fn planner_import_markdown(
    app: AppHandle,
    state: State<AppState>,
    preview: MarkdownImportPreview,
    selected_fingerprints: Vec<String>,
    allow_duplicates: bool,
    timezone: String,
) -> CmdResult<MarkdownImportResult> {
    let workspace = state.get()?;
    let result = workspace.import_markdown_tasks_to_planner(
        &preview,
        &selected_fingerprints,
        allow_duplicates,
        &timezone,
    )?;
    changed(&app, &workspace, result.imported_task_ids.clone())?;
    Ok(result)
}
