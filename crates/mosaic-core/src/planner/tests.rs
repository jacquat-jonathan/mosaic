use super::*;
use crate::index::Index;
use crate::{Vault, Workspace};
use std::fs;

fn in_memory() -> PlannerStore {
    PlannerStore::in_memory().unwrap()
}

fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let index = Index::in_memory().unwrap();
    (dir, Workspace::new(vault, index))
}

fn epic(store: &mut PlannerStore, title: &str) -> Epic {
    store
        .create_epic(CreateEpic {
            title: title.into(),
            description: String::new(),
            color: "#5b8def".into(),
        })
        .unwrap()
}

fn task(
    store: &mut PlannerStore,
    epic_id: Option<String>,
    parent_id: Option<String>,
    title: &str,
) -> PlannerTask {
    store
        .create_task(CreateTask {
            epic_id,
            parent_id,
            title: title.into(),
            description: String::new(),
            status: TaskStatus::New,
            due_date: None,
            estimate_minutes: None,
        })
        .unwrap()
}

#[test]
fn domain_revisions_hierarchy_completion_and_history_are_atomic() {
    let mut store = in_memory();
    let first_epic = epic(&mut store, "Launch");
    let second_epic = epic(&mut store, "Later");
    let parent = task(&mut store, Some(first_epic.id.clone()), None, "Ship");
    let child = task(
        &mut store,
        Some(first_epic.id.clone()),
        Some(parent.id.clone()),
        "Review",
    );

    let revision_before_cycle = store.summary().unwrap().revision;
    let cycle = store.move_task(
        &parent.id,
        MoveTask {
            expected_revision: parent.revision,
            epic_id: Some(first_epic.id.clone()),
            parent_id: Some(child.id.clone()),
            status: TaskStatus::New,
            position: 1024,
        },
    );
    assert!(cycle.unwrap_err().to_string().contains("cycle"));
    assert_eq!(store.summary().unwrap().revision, revision_before_cycle);
    assert_eq!(
        store.activity("task", &parent.id).unwrap().len(),
        1,
        "a failed mutation must not append activity"
    );

    let moved = store
        .move_task(
            &parent.id,
            MoveTask {
                expected_revision: parent.revision,
                epic_id: Some(second_epic.id.clone()),
                parent_id: None,
                status: TaskStatus::InProgress,
                position: 2048,
            },
        )
        .unwrap();
    let tasks = store.list_tasks(false, false).unwrap();
    let moved_child = tasks.iter().find(|item| item.id == child.id).unwrap();
    assert_eq!(moved.epic_id, Some(second_epic.id.clone()));
    assert_eq!(moved_child.epic_id, Some(second_epic.id));
    assert!(moved_child.revision > child.revision);

    let stale = store.update_task(
        &parent.id,
        UpdateTask {
            expected_revision: parent.revision,
            title: Some("Overwrite".into()),
            description: None,
            due_date: None,
            estimate_minutes: None,
        },
    );
    assert!(matches!(stale, Err(Error::Conflict { .. })));

    let session = store
        .create_work_session(CreateWorkSession {
            task_id: parent.id.clone(),
            all_day: false,
            start_value: "2099-10-13T09:00:00+02:00".into(),
            end_value: "2099-10-13T10:00:00+02:00".into(),
            timezone: "Europe/Zurich".into(),
        })
        .unwrap();
    let incomplete = store.complete_task(
        &parent.id,
        moved.revision,
        false,
        FutureSessionPolicy::Cancel,
    );
    assert!(
        incomplete
            .unwrap_err()
            .to_string()
            .contains("incomplete subtasks")
    );
    let child = store
        .list_tasks(false, false)
        .unwrap()
        .into_iter()
        .find(|item| item.id == child.id)
        .unwrap();
    store
        .complete_task(&child.id, child.revision, false, FutureSessionPolicy::Keep)
        .unwrap();
    let parent = store
        .list_tasks(false, false)
        .unwrap()
        .into_iter()
        .find(|item| item.id == parent.id)
        .unwrap();
    let completed = store
        .complete_task(
            &parent.id,
            parent.revision,
            false,
            FutureSessionPolicy::Cancel,
        )
        .unwrap();
    assert_eq!(completed.status, TaskStatus::Done);
    assert_eq!(
        store.list_work_sessions(Some(&parent.id), true).unwrap()[0].state,
        "cancelled"
    );
    let reopened = store.reopen_task(&parent.id, completed.revision).unwrap();
    assert_eq!(reopened.status, TaskStatus::New);
    assert_eq!(
        store.list_work_sessions(Some(&parent.id), true).unwrap()[0].id,
        session.id
    );
    assert_eq!(
        store.list_work_sessions(Some(&parent.id), true).unwrap()[0].state,
        "cancelled",
        "reopening must not recreate or reactivate sessions"
    );
}

#[test]
fn markdown_import_previews_maps_and_deduplicates_without_editing_notes() {
    let (dir, workspace) = workspace();
    workspace.mkdir("Daily").unwrap();
    workspace
        .create(
            "Daily/2026-10-13.md",
            "# Tuesday\n\n- [ ] Parent 📅 2026-10-16 ^parent\n    - [ ] Review <!-- mosaic:state=in-qa --> ^review\n- [x] Finished ^done\n- [>] Deferred ^moved\n",
        )
        .unwrap();
    let note = dir.path().join("Daily/2026-10-13.md");
    let before = fs::read(&note).unwrap();

    let preview = workspace.preview_markdown_planner_import().unwrap();
    assert_eq!(preview.candidates, 4);
    assert_eq!(preview.selected_by_default, 2);
    let candidates: Vec<_> = preview
        .groups
        .iter()
        .flat_map(|group| &group.tasks)
        .collect();
    assert_eq!(candidates[0].title, "Parent");
    assert_eq!(candidates[0].due_date.as_deref(), Some("2026-10-16"));
    assert_eq!(candidates[1].status, TaskStatus::InQa);
    assert_eq!(
        candidates[1].parent_fingerprint,
        Some(candidates[0].fingerprint.clone())
    );
    assert!(candidates[3].archived);

    let selected: Vec<String> = candidates
        .iter()
        .map(|candidate| candidate.fingerprint.clone())
        .collect();
    let imported = workspace
        .import_markdown_tasks_to_planner(&preview, &selected, false, "Europe/Zurich")
        .unwrap();
    assert_eq!(imported.imported_task_ids.len(), 4);
    assert_eq!(workspace.planner_summary().unwrap().tasks, 4);
    assert_eq!(
        workspace.planner_work_sessions(None, true).unwrap().len(),
        4
    );
    assert_eq!(fs::read(&note).unwrap(), before);

    let revision = workspace.planner_summary().unwrap().revision;
    let repeated = workspace
        .import_markdown_tasks_to_planner(&preview, &selected, false, "Europe/Zurich")
        .unwrap();
    assert!(repeated.imported_task_ids.is_empty());
    assert_eq!(repeated.skipped_duplicates.len(), 4);
    assert_eq!(workspace.planner_summary().unwrap().revision, revision);
    assert_eq!(fs::read(&note).unwrap(), before);

    let failed = workspace.import_markdown_tasks_to_planner(
        &preview,
        &["not-a-preview-fingerprint".into()],
        false,
        "Europe/Zurich",
    );
    assert!(failed.is_err());
    assert_eq!(workspace.planner_summary().unwrap().revision, revision);
}

#[test]
fn a_closed_vault_copy_keeps_planner_content_and_history() {
    let source = tempfile::tempdir().unwrap();
    let source_workspace = Workspace::open(source.path()).unwrap();
    let epic = source_workspace
        .create_planner_epic(CreateEpic {
            title: "Portable".into(),
            description: "Travels with the vault".into(),
            color: "cyan".into(),
        })
        .unwrap();
    source_workspace
        .create_planner_task(CreateTask {
            epic_id: Some(epic.id.clone()),
            parent_id: None,
            title: "Copy me".into(),
            description: String::new(),
            status: TaskStatus::New,
            due_date: None,
            estimate_minutes: Some(30),
        })
        .unwrap();
    drop(source_workspace);

    let destination = tempfile::tempdir().unwrap();
    fs::create_dir(destination.path().join(".mosaic")).unwrap();
    fs::copy(
        source.path().join(".mosaic/planner.sqlite3"),
        destination.path().join(".mosaic/planner.sqlite3"),
    )
    .unwrap();
    let copied = Workspace::open(destination.path()).unwrap();
    assert_eq!(copied.planner_summary().unwrap().tasks, 1);
    assert_eq!(copied.planner_epics(false, false).unwrap()[0].id, epic.id);
    let task = copied.planner_tasks(false, false).unwrap().pop().unwrap();
    assert_eq!(copied.planner_activity("task", &task.id).unwrap().len(), 1);
}

#[test]
fn recovery_from_the_last_valid_backup_is_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = PlannerStore::open(dir.path()).unwrap();
    epic(&mut store, "Recover me");
    drop(store);
    let hidden = dir.path().join(".mosaic");
    let database = hidden.join("planner.sqlite3");
    fs::copy(&database, hidden.join("planner-backup.sqlite3")).unwrap();
    fs::write(&database, b"not a sqlite database").unwrap();

    assert!(PlannerStore::open(dir.path()).is_err());
    let corrupt = PlannerStore::restore_last_backup(dir.path()).unwrap();
    assert!(corrupt.is_file());
    let restored = PlannerStore::open(dir.path()).unwrap();
    assert_eq!(restored.summary().unwrap().epics, 1);
}
