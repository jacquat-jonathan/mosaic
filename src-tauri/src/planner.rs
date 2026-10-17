use crate::{AppState, CmdResult};
use mosaic_core::Error;
use mosaic_core::Workspace;
use mosaic_core::planner::{
    ActivityEntry, CalendarRange, CreateEpic, CreateEvent, CreateTask, CreateWorkSession, Epic,
    FutureSessionPolicy, IcalImportPreview, IcalImportResult, MarkdownImportPreview,
    MarkdownImportResult, MoveTask, PlannerEvent, PlannerStore, PlannerSummary, PlannerTask,
    UpdateEpic, UpdateEvent, UpdateTask, UpdateWorkSession, WorkSession,
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
            revision: workspace.planner.summary()?.revision,
            affected_ids,
        },
    )
    .ok();
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_summary(state: State<AppState>) -> CmdResult<PlannerSummary> {
    state.get()?.planner.summary()
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_activity(
    state: State<AppState>,
    entity_kind: String,
    entity_id: String,
) -> CmdResult<Vec<ActivityEntry>> {
    state.get()?.planner.activity(&entity_kind, &entity_id)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_epics(
    state: State<AppState>,
    include_archived: bool,
    include_trashed: bool,
) -> CmdResult<Vec<Epic>> {
    state
        .get()?
        .planner
        .epics(include_archived, include_trashed)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_tasks(
    state: State<AppState>,
    include_archived: bool,
    include_trashed: bool,
) -> CmdResult<Vec<PlannerTask>> {
    state
        .get()?
        .planner
        .tasks(include_archived, include_trashed)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_create_epic(
    app: AppHandle,
    state: State<AppState>,
    input: CreateEpic,
) -> CmdResult<Epic> {
    let workspace = state.get()?;
    let epic = workspace.planner.create_epic(input)?;
    changed(&app, &workspace, vec![epic.id.clone()])?;
    Ok(epic)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_update_epic(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: UpdateEpic,
) -> CmdResult<Epic> {
    let workspace = state.get()?;
    let epic = workspace.planner.update_epic(&id, input)?;
    changed(&app, &workspace, vec![epic.id.clone()])?;
    Ok(epic)
}

macro_rules! epic_lifecycle {
    ($name:ident, $method:ident) => {
        #[tauri::command(async)]
        #[specta::specta]
        pub(crate) fn $name(
            app: AppHandle,
            state: State<AppState>,
            id: String,
            expected_revision: i64,
        ) -> CmdResult<Epic> {
            let workspace = state.get()?;
            let epic = workspace.planner.$method(&id, expected_revision)?;
            changed(&app, &workspace, vec![epic.id.clone()])?;
            Ok(epic)
        }
    };
}

epic_lifecycle!(planner_archive_epic, archive_epic);
epic_lifecycle!(planner_restore_epic, restore_epic);
epic_lifecycle!(planner_trash_epic, trash_epic);

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_create_task(
    app: AppHandle,
    state: State<AppState>,
    input: CreateTask,
) -> CmdResult<PlannerTask> {
    let workspace = state.get()?;
    let task = workspace.planner.create_task(input)?;
    changed(&app, &workspace, vec![task.id.clone()])?;
    Ok(task)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_update_task(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: UpdateTask,
) -> CmdResult<PlannerTask> {
    let workspace = state.get()?;
    let task = workspace.planner.update_task(&id, input)?;
    changed(&app, &workspace, vec![task.id.clone()])?;
    Ok(task)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_move_task(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: MoveTask,
) -> CmdResult<PlannerTask> {
    let workspace = state.get()?;
    let task = workspace.planner.move_task(&id, input)?;
    changed(&app, &workspace, vec![task.id.clone()])?;
    Ok(task)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_complete_task(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    expected_revision: i64,
    allow_incomplete_subtasks: bool,
    future_sessions: FutureSessionPolicy,
) -> CmdResult<PlannerTask> {
    let workspace = state.get()?;
    let task = workspace.planner.complete_task(
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
        #[tauri::command(async)]
        #[specta::specta]
        pub(crate) fn $name(
            app: AppHandle,
            state: State<AppState>,
            id: String,
            expected_revision: i64,
        ) -> CmdResult<PlannerTask> {
            let workspace = state.get()?;
            let task = workspace.planner.$method(&id, expected_revision)?;
            changed(&app, &workspace, vec![task.id.clone()])?;
            Ok(task)
        }
    };
}

task_lifecycle!(planner_reopen_task, reopen_task);
task_lifecycle!(planner_archive_task, archive_task);
task_lifecycle!(planner_restore_task, restore_task);
task_lifecycle!(planner_trash_task, trash_task);

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_work_sessions(
    state: State<AppState>,
    task_id: Option<String>,
    include_cancelled: bool,
) -> CmdResult<Vec<WorkSession>> {
    state
        .get()?
        .planner
        .work_sessions(task_id.as_deref(), include_cancelled)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_create_work_session(
    app: AppHandle,
    state: State<AppState>,
    input: CreateWorkSession,
) -> CmdResult<WorkSession> {
    let workspace = state.get()?;
    let session = workspace.planner.create_work_session(input)?;
    changed(
        &app,
        &workspace,
        vec![session.id.clone(), session.task_id.clone()],
    )?;
    Ok(session)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_update_work_session(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: UpdateWorkSession,
) -> CmdResult<WorkSession> {
    let workspace = state.get()?;
    let session = workspace.planner.update_work_session(&id, input)?;
    changed(
        &app,
        &workspace,
        vec![session.id.clone(), session.task_id.clone()],
    )?;
    Ok(session)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_cancel_work_session(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    expected_revision: i64,
) -> CmdResult<WorkSession> {
    let workspace = state.get()?;
    let session = workspace
        .planner
        .cancel_work_session(&id, expected_revision)?;
    changed(
        &app,
        &workspace,
        vec![session.id.clone(), session.task_id.clone()],
    )?;
    Ok(session)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_calendar_range(
    state: State<AppState>,
    from: String,
    to: String,
) -> CmdResult<CalendarRange> {
    state.get()?.planner.calendar_range(&from, &to)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_events(
    state: State<AppState>,
    include_archived: bool,
    include_trashed: bool,
) -> CmdResult<Vec<PlannerEvent>> {
    state
        .get()?
        .planner
        .events(include_archived, include_trashed)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_create_event(
    app: AppHandle,
    state: State<AppState>,
    input: CreateEvent,
) -> CmdResult<PlannerEvent> {
    let workspace = state.get()?;
    let event = workspace.planner.create_event(input)?;
    changed(&app, &workspace, vec![event.id.clone()])?;
    Ok(event)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_update_event(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: UpdateEvent,
) -> CmdResult<PlannerEvent> {
    let workspace = state.get()?;
    let event = workspace.planner.update_event(&id, input)?;
    changed(&app, &workspace, vec![event.id.clone()])?;
    Ok(event)
}

macro_rules! event_lifecycle {
    ($name:ident, $method:ident) => {
        #[tauri::command(async)]
        #[specta::specta]
        pub(crate) fn $name(
            app: AppHandle,
            state: State<AppState>,
            id: String,
            expected_revision: i64,
        ) -> CmdResult<PlannerEvent> {
            let workspace = state.get()?;
            let event = workspace.planner.$method(&id, expected_revision)?;
            changed(&app, &workspace, vec![event.id.clone()])?;
            Ok(event)
        }
    };
}

event_lifecycle!(planner_archive_event, archive_event);
event_lifecycle!(planner_restore_event, restore_event);
event_lifecycle!(planner_trash_event, trash_event);

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_cancel_event_occurrence(
    app: AppHandle,
    state: State<AppState>,
    series_id: String,
    expected_revision: i64,
    occurrence_key: String,
) -> CmdResult<PlannerEvent> {
    let workspace = state.get()?;
    let event = workspace.planner.cancel_event_occurrence(
        &series_id,
        expected_revision,
        &occurrence_key,
    )?;
    changed(&app, &workspace, vec![series_id])?;
    Ok(event)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_replace_event_occurrence(
    app: AppHandle,
    state: State<AppState>,
    series_id: String,
    expected_revision: i64,
    occurrence_key: String,
    input: CreateEvent,
) -> CmdResult<PlannerEvent> {
    let workspace = state.get()?;
    let event = workspace.planner.replace_event_occurrence(
        &series_id,
        expected_revision,
        &occurrence_key,
        input,
    )?;
    changed(&app, &workspace, vec![series_id, event.id.clone()])?;
    Ok(event)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_migration_preview(
    state: State<AppState>,
) -> CmdResult<MarkdownImportPreview> {
    state.get()?.preview_markdown_planner_import()
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_import_markdown(
    app: AppHandle,
    state: State<AppState>,
    preview: MarkdownImportPreview,
    selected_fingerprints: Vec<String>,
    allow_duplicates: bool,
    timezone: String,
) -> CmdResult<MarkdownImportResult> {
    let workspace = state.get()?;
    let result = workspace.planner.import_markdown_tasks(
        &preview,
        &selected_fingerprints,
        allow_duplicates,
        &timezone,
    )?;
    let mut affected = result.imported_epic_ids.clone();
    affected.extend(result.imported_task_ids.clone());
    changed(&app, &workspace, affected)?;
    Ok(result)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_ical_preview(
    state: State<AppState>,
    source_kind: String,
    content: String,
    fallback_timezone: String,
) -> CmdResult<IcalImportPreview> {
    state
        .get()?
        .planner
        .preview_ical_import(&source_kind, &content, &fallback_timezone)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_ical_import(
    app: AppHandle,
    state: State<AppState>,
    preview: IcalImportPreview,
    selected_keys: Vec<String>,
    allow_duplicates: bool,
) -> CmdResult<IcalImportResult> {
    let workspace = state.get()?;
    let result = workspace
        .planner
        .import_ical(&preview, &selected_keys, allow_duplicates)?;
    changed(&app, &workspace, result.imported_event_ids.clone())?;
    Ok(result)
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_ical_export(state: State<AppState>) -> CmdResult<String> {
    state.get()?.planner.export_ical()
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_ical_export_file(state: State<AppState>, path: String) -> CmdResult<String> {
    let content = state.get()?.planner.export_ical()?;
    let destination = std::path::PathBuf::from(&path);
    if destination.extension().and_then(|value| value.to_str()) != Some("ics") {
        return Err(Error::Invalid(
            "calendar export must use an .ics file".into(),
        ));
    }
    std::fs::write(&destination, content).map_err(|source| Error::Io {
        path: destination.display().to_string(),
        source,
    })?;
    Ok(destination.display().to_string())
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_export(state: State<AppState>, format: String) -> CmdResult<String> {
    match format.as_str() {
        "json" => state.get()?.planner.export_json(),
        "csv" => state.get()?.planner.export_csv(),
        _ => Err(Error::Invalid("planner export must be JSON or CSV".into())),
    }
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_export_file(
    state: State<AppState>,
    format: String,
    path: String,
) -> CmdResult<String> {
    let (extension, content) = match format.as_str() {
        "json" => ("json", state.get()?.planner.export_json()?),
        "csv" => ("csv", state.get()?.planner.export_csv()?),
        _ => return Err(Error::Invalid("planner export must be JSON or CSV".into())),
    };
    let destination = std::path::PathBuf::from(&path);
    if destination.extension().and_then(|value| value.to_str()) != Some(extension) {
        return Err(Error::Invalid(format!(
            "planner {format} export must use a .{extension} file"
        )));
    }
    std::fs::write(&destination, content).map_err(|source| Error::Io {
        path: destination.display().to_string(),
        source,
    })?;
    Ok(destination.display().to_string())
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn planner_restore_backup(path: String) -> CmdResult<String> {
    PlannerStore::restore_last_backup(std::path::Path::new(&path))
        .map(|restored| restored.display().to_string())
}
