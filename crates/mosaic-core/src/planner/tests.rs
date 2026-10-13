use super::*;
use crate::index::Index;
use crate::{Vault, Workspace};
use std::fs;
use std::time::{Duration, Instant};

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
            clear_due_date: false,
            estimate_minutes: None,
            clear_estimate: false,
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
fn calendar_expands_recurrence_sessions_due_dates_and_exceptions() {
    let mut store = in_memory();
    let epic = epic(&mut store, "Calendar");
    let mut task = task(&mut store, Some(epic.id.clone()), None, "Prepare launch");
    task = store
        .update_task(
            &task.id,
            UpdateTask {
                expected_revision: task.revision,
                title: None,
                description: None,
                due_date: Some("2026-03-30".into()),
                clear_due_date: false,
                estimate_minutes: Some(90),
                clear_estimate: false,
            },
        )
        .unwrap();
    let first = store
        .create_work_session(CreateWorkSession {
            task_id: task.id.clone(),
            all_day: false,
            start_value: "2026-03-30T07:00:00Z".into(),
            end_value: "2026-03-30T08:00:00Z".into(),
            timezone: "Europe/Zurich".into(),
        })
        .unwrap();
    let second = store
        .create_work_session(CreateWorkSession {
            task_id: task.id.clone(),
            all_day: false,
            start_value: "2026-03-30T07:30:00Z".into(),
            end_value: "2026-03-30T08:30:00Z".into(),
            timezone: "Europe/Zurich".into(),
        })
        .unwrap();
    let moved = store
        .update_work_session(
            &first.id,
            UpdateWorkSession {
                expected_revision: first.revision,
                all_day: false,
                start_value: "2026-03-30T09:00:00Z".into(),
                end_value: "2026-03-30T10:00:00Z".into(),
                timezone: "Europe/Zurich".into(),
            },
        )
        .unwrap();
    assert_eq!(moved.start_value, "2026-03-30T09:00:00.000Z");
    assert_eq!(
        store
            .list_work_sessions(Some(&task.id), false)
            .unwrap()
            .into_iter()
            .find(|session| session.id == second.id)
            .unwrap()
            .start_value,
        "2026-03-30T07:30:00.000Z",
        "moving one session must not move another"
    );

    let recurring = store
        .create_event(CreateEvent {
            title: "Daily sync".into(),
            description: String::new(),
            location: "Room 1".into(),
            meeting_url: None,
            participants: vec!["anna@example.com".into()],
            epic_id: Some(epic.id.clone()),
            color: None,
            all_day: false,
            start_value: "2026-03-27T08:00:00Z".into(),
            end_value: "2026-03-27T09:00:00Z".into(),
            timezone: "Europe/Zurich".into(),
            recurrence_rule: Some("FREQ=DAILY;UNTIL=20260331".into()),
        })
        .unwrap();
    let all_day = store
        .create_event(CreateEvent {
            title: "Launch day".into(),
            description: String::new(),
            location: String::new(),
            meeting_url: None,
            participants: vec![],
            epic_id: None,
            color: Some("#d15f68".into()),
            all_day: true,
            start_value: "2026-03-30".into(),
            end_value: "2026-03-31".into(),
            timezone: "Europe/Zurich".into(),
            recurrence_rule: None,
        })
        .unwrap();
    assert_eq!(all_day.start_value, "2026-03-30");

    let range = store.calendar_range("2026-03-27", "2026-03-31").unwrap();
    assert_eq!(range.work_sessions.len(), 2);
    assert_eq!(range.due_markers.len(), 1);
    assert!(range.unscheduled_tasks.is_empty());
    let recurring_occurrences: Vec<_> = range
        .events
        .iter()
        .filter(|event| event.series_id == recurring.id)
        .collect();
    assert_eq!(recurring_occurrences.len(), 5);
    assert_eq!(
        recurring_occurrences[0].start_value,
        "2026-03-27T08:00:00.000Z"
    );
    assert_eq!(
        recurring_occurrences[2].start_value,
        "2026-03-29T07:00:00.000Z"
    );

    let recurring = store
        .cancel_event_occurrence(&recurring.id, recurring.revision, "2026-03-29")
        .unwrap();
    store
        .replace_event_occurrence(
            &recurring.id,
            recurring.revision,
            "2026-03-30",
            CreateEvent {
                title: "Late sync".into(),
                description: String::new(),
                location: String::new(),
                meeting_url: None,
                participants: vec![],
                epic_id: Some(epic.id),
                color: None,
                all_day: false,
                start_value: "2026-03-30T13:00:00Z".into(),
                end_value: "2026-03-30T14:00:00Z".into(),
                timezone: "Europe/Zurich".into(),
                recurrence_rule: None,
            },
        )
        .unwrap();
    let range = store.calendar_range("2026-03-27", "2026-03-31").unwrap();
    assert!(
        !range.events.iter().any(|event| {
            event.series_id == recurring.id && event.occurrence_key == "2026-03-29"
        })
    );
    assert!(range.events.iter().any(|event| event.title == "Late sync"));
    assert_eq!(
        range
            .workload
            .iter()
            .find(|day| day.date == "2026-03-30")
            .unwrap()
            .minutes,
        120
    );
}

#[test]
fn ical_preview_import_export_and_overlay_deduplicate() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:focus@example.test\r\nDTSTART;TZID=Europe/Zurich:20261013T090000\r\nDTEND;TZID=Europe/Zurich:20261013T100000\r\nRRULE:FREQ=DAILY;UNTIL=20261015\r\nSUMMARY:Focus time\r\nDESCRIPTION:Deep work\\nNo notifications\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:holiday@example.test\r\nDTSTART;VALUE=DATE:20261014\r\nDTEND;VALUE=DATE:20261015\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut store = in_memory();
    let preview = store
        .preview_ical_import("file:test.ics", content, "Europe/Zurich")
        .unwrap();
    assert_eq!(preview.candidates.len(), 2);
    assert_eq!(
        preview.candidates[0].start_value,
        "2026-10-13T07:00:00.000Z"
    );
    assert!(preview.candidates[1].all_day);
    let selected = preview
        .candidates
        .iter()
        .map(|candidate| candidate.key.clone())
        .collect::<Vec<_>>();
    let imported = store.import_ical(&preview, &selected, false).unwrap();
    assert_eq!(imported.imported_event_ids.len(), 2);
    let repeated_preview = store
        .preview_ical_import("file:test.ics", content, "Europe/Zurich")
        .unwrap();
    assert_eq!(repeated_preview.duplicates, 2);
    let repeated = store
        .import_ical(&repeated_preview, &selected, false)
        .unwrap();
    assert!(repeated.imported_event_ids.is_empty());
    assert_eq!(repeated.skipped_duplicates.len(), 2);

    let exported = store.export_ical().unwrap();
    assert!(exported.contains("PRODID:-//Mosaic//Planner//EN"));
    assert!(exported.contains("RRULE:FREQ=DAILY;UNTIL=20261015"));
    assert!(exported.contains("DTSTART;VALUE=DATE:20261014"));
    let roundtrip = PlannerStore::in_memory()
        .unwrap()
        .preview_ical_import("roundtrip", &exported, "UTC")
        .unwrap();
    assert_eq!(roundtrip.candidates.len(), 2);

    let overlay = overlay_occurrences(
        content,
        "subscription",
        "Team",
        Some("#5b8def".into()),
        "2026-10-13",
        "2026-10-15",
        "Europe/Zurich",
    )
    .unwrap();
    assert_eq!(
        overlay
            .iter()
            .filter(|item| item.uid == "focus@example.test")
            .count(),
        3
    );
    assert!(overlay.iter().all(|item| item.read_only));
}

#[test]
fn ical_failures_are_atomic_and_recurring_exceptions_export_inside_events() {
    let mut store = in_memory();
    assert!(validate_ical("not a calendar", "UTC").is_err());
    let oversized = format!("BEGIN:VCALENDAR\n{}", "x".repeat(10 * 1024 * 1024));
    assert!(validate_ical(&oversized, "UTC").is_err());

    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:atomic@example.test\r\nDTSTART;VALUE=DATE:20261014\r\nDTEND;VALUE=DATE:20261015\r\nSUMMARY:Atomic import\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let preview = store.preview_ical_import("atomic", content, "UTC").unwrap();
    let revision = store.summary().unwrap().revision;
    assert!(
        store
            .import_ical(&preview, &["unknown-event".into()], false)
            .is_err()
    );
    assert_eq!(store.summary().unwrap().revision, revision);
    assert!(store.list_events(false, false).unwrap().is_empty());

    let recurring = store
        .create_event(CreateEvent {
            title: "Morning sync".into(),
            description: String::new(),
            location: String::new(),
            meeting_url: None,
            participants: vec![],
            epic_id: None,
            color: None,
            all_day: false,
            start_value: "2026-10-13T07:00:00Z".into(),
            end_value: "2026-10-13T08:00:00Z".into(),
            timezone: "Europe/Zurich".into(),
            recurrence_rule: Some("FREQ=DAILY;UNTIL=20261015".into()),
        })
        .unwrap();
    let recurring = store
        .cancel_event_occurrence(&recurring.id, recurring.revision, "2026-10-14")
        .unwrap();
    store
        .replace_event_occurrence(
            &recurring.id,
            recurring.revision,
            "2026-10-15",
            CreateEvent {
                title: "Later sync".into(),
                description: String::new(),
                location: String::new(),
                meeting_url: None,
                participants: vec![],
                epic_id: None,
                color: None,
                all_day: false,
                start_value: "2026-10-15T11:00:00Z".into(),
                end_value: "2026-10-15T12:00:00Z".into(),
                timezone: "Europe/Zurich".into(),
                recurrence_rule: None,
            },
        )
        .unwrap();
    let exported = store.export_ical().unwrap();
    assert!(exported.contains("EXDATE;TZID=Europe/Zurich:20261014T090000"));
    assert!(exported.contains("RECURRENCE-ID;TZID=Europe/Zurich:20261015T090000"));
    let base_end = exported.find("EXDATE;TZID=Europe/Zurich").unwrap();
    assert!(exported[base_end..].find("END:VEVENT").is_some());
    assert_eq!(validate_ical(&exported, "UTC").unwrap(), 2);
}

#[test]
fn planner_json_and_csv_exports_include_history_and_lifecycle_state() {
    let mut store = in_memory();
    let epic = epic(&mut store, "Export, launch");
    let task = task(&mut store, Some(epic.id.clone()), None, "Review \"copy\"");
    let task = store.archive_task(&task.id, task.revision).unwrap();
    store.trash_task(&task.id, task.revision).unwrap();

    let json = store.export_json().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["format_version"], 1);
    assert_eq!(parsed["tasks"][0]["title"], "Review \"copy\"");
    assert!(parsed["tasks"][0]["trashed_at"].is_string());
    assert!(parsed["activity"].as_array().unwrap().len() >= 4);
    assert!(!json.contains("calendar_subscriptions"));

    let csv = store.export_csv().unwrap();
    assert!(csv.starts_with("entity_type,id,parent_id"));
    assert!(csv.contains("\"Export, launch\""));
    assert!(csv.contains("\"Review \"\"copy\"\"\""));
    assert!(csv.contains("\"task\""));
}

#[test]
fn archived_parents_and_epics_hide_their_active_descendants_from_active_planning() {
    let mut store = in_memory();
    let epic = epic(&mut store, "Archived plan");
    let parent = task(&mut store, Some(epic.id.clone()), None, "Parent");
    let child = task(
        &mut store,
        Some(epic.id.clone()),
        Some(parent.id.clone()),
        "Child",
    );

    let parent = store.archive_task(&parent.id, parent.revision).unwrap();
    assert!(
        store
            .list_tasks(false, false)
            .unwrap()
            .iter()
            .all(|task| task.id != child.id)
    );
    assert!(
        store
            .calendar_range("2026-10-13", "2026-10-14")
            .unwrap()
            .unscheduled_tasks
            .is_empty()
    );

    store.restore_task(&parent.id, parent.revision).unwrap();
    store.archive_epic(&epic.id, epic.revision).unwrap();
    assert!(store.list_tasks(false, false).unwrap().is_empty());
    assert_eq!(store.list_tasks(true, false).unwrap().len(), 2);
}

#[test]
fn markdown_import_previews_maps_and_deduplicates_without_editing_notes() {
    let (dir, workspace) = workspace();
    workspace.mkdir("Daily").unwrap();
    workspace
        .create(
            "Daily/2026-10-13.md",
            "# Tuesday\n\n- [ ] Parent 📅 2026-10-16 ^parent\n    - [ ] Review <!-- mosaic:state=in-qa --> ^review\n        - [ ] Detail ^detail\n- [x] Finished ^done\n- [>] Deferred ^moved\n",
        )
        .unwrap();
    let note = dir.path().join("Daily/2026-10-13.md");
    let before = fs::read(&note).unwrap();

    let preview = workspace.preview_markdown_planner_import().unwrap();
    assert_eq!(preview.candidates, 5);
    assert_eq!(preview.selected_by_default, 4);
    let candidates: Vec<_> = preview
        .groups
        .iter()
        .flat_map(|group| &group.tasks)
        .collect();
    assert_eq!(candidates[0].title, "Parent");
    assert_eq!(candidates[0].kind, MarkdownImportKind::Epic);
    assert_eq!(candidates[0].due_date.as_deref(), Some("2026-10-16"));
    assert_eq!(candidates[1].kind, MarkdownImportKind::Task);
    assert_eq!(candidates[1].status, TaskStatus::InQa);
    assert_eq!(
        candidates[1].parent_fingerprint,
        Some(candidates[0].fingerprint.clone())
    );
    assert_eq!(candidates[2].kind, MarkdownImportKind::Subtask);
    assert_eq!(
        candidates[2].parent_fingerprint,
        Some(candidates[1].fingerprint.clone())
    );
    assert!(candidates[4].archived);

    let selected: Vec<String> = candidates
        .iter()
        .map(|candidate| candidate.fingerprint.clone())
        .collect();
    let imported = workspace
        .import_markdown_tasks_to_planner(&preview, &selected, false, "Europe/Zurich")
        .unwrap();
    assert_eq!(imported.imported_epic_ids.len(), 3);
    assert_eq!(imported.imported_task_ids.len(), 2);
    assert_eq!(workspace.planner_summary().unwrap().epics, 3);
    assert_eq!(workspace.planner_summary().unwrap().tasks, 2);
    assert!(
        workspace
            .planner_work_sessions(None, true)
            .unwrap()
            .is_empty()
    );
    let epics = workspace.planner_epics(true, false).unwrap();
    let parent_epic = epics.iter().find(|epic| epic.title == "Parent").unwrap();
    let tasks = workspace.planner_tasks(true, false).unwrap();
    let review = tasks.iter().find(|task| task.title == "Review").unwrap();
    let detail = tasks.iter().find(|task| task.title == "Detail").unwrap();
    assert_eq!(review.epic_id.as_deref(), Some(parent_epic.id.as_str()));
    assert_eq!(review.parent_id, None);
    assert_eq!(detail.epic_id, review.epic_id);
    assert_eq!(detail.parent_id.as_deref(), Some(review.id.as_str()));
    assert_eq!(fs::read(&note).unwrap(), before);

    let revision = workspace.planner_summary().unwrap().revision;
    let repeated = workspace
        .import_markdown_tasks_to_planner(&preview, &selected, false, "Europe/Zurich")
        .unwrap();
    assert!(repeated.imported_task_ids.is_empty());
    assert_eq!(repeated.skipped_duplicates.len(), 5);
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

#[test]
fn opening_a_pre_planner_vault_and_previewing_migration_never_changes_markdown() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("Projects")).unwrap();
    let note = dir.path().join("Projects/Release.md");
    let daily = dir.path().join("2026-10-13.md");
    fs::write(
        &note,
        b"# Release\n\n- [ ] Ship Mosaic \xf0\x9f\x93\x85 2026-10-20\n",
    )
    .unwrap();
    fs::write(&daily, b"# Today\n\n- [x] Keep this exactly\n").unwrap();
    let before_note = fs::read(&note).unwrap();
    let before_daily = fs::read(&daily).unwrap();

    let workspace = Workspace::open(dir.path()).unwrap();
    workspace.sync(|_, _| {}).unwrap();
    let preview = workspace.preview_markdown_planner_import().unwrap();
    assert_eq!(preview.candidates, 2);
    drop(workspace);

    assert_eq!(fs::read(&note).unwrap(), before_note);
    assert_eq!(fs::read(&daily).unwrap(), before_daily);
    assert!(dir.path().join(".mosaic/planner.sqlite3").is_file());
}

#[test]
fn ten_thousand_tasks_and_a_busy_month_load_within_the_acceptance_budget() {
    let mut store = in_memory();
    let tx = store.conn.transaction().unwrap();
    for index in 0..10_000 {
        tx.execute(
            "INSERT INTO tasks(id, epic_id, parent_id, title, description, status, due_date,
                 estimate_minutes, position, revision, created_at, updated_at, completed_at,
                 archived_at, trashed_at)
             VALUES (?1, NULL, NULL, ?2, '', 'new', ?3, 30, ?4, 1, ?5, ?5, NULL, NULL, NULL)",
            rusqlite::params![
                format!("task-{index}"),
                format!("Task {index}"),
                format!("2026-10-{:02}", index % 31 + 1),
                index as i64,
                "2026-10-01T00:00:00Z"
            ],
        )
        .unwrap();
    }
    for index in 0..1_000 {
        let day = index % 31 + 1;
        let next_day = day % 31 + 1;
        tx.execute(
            "INSERT INTO events(id, series_id, title, description, location, meeting_url,
                 participants_json, epic_id, color, all_day, start_value, end_value, timezone,
                 recurrence_rule, revision, created_at, updated_at, archived_at, trashed_at)
             VALUES (?1, NULL, ?2, '', '', NULL, '[]', NULL, NULL, 1, ?3, ?4, 'UTC',
                 NULL, 1, ?5, ?5, NULL, NULL)",
            rusqlite::params![
                format!("event-{index}"),
                format!("Event {index}"),
                format!("2026-10-{day:02}"),
                if day == 31 {
                    "2026-11-01".to_string()
                } else {
                    format!("2026-10-{next_day:02}")
                },
                "2026-10-01T00:00:00Z"
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();

    let started = Instant::now();
    let range = store.calendar_range("2026-10-01", "2026-10-31").unwrap();
    let elapsed = started.elapsed();
    assert_eq!(range.unscheduled_tasks.len(), 10_000);
    assert_eq!(range.due_markers.len(), 10_000);
    assert_eq!(range.events.len(), 1_000);
    assert!(
        elapsed < Duration::from_secs(5),
        "large planner month loaded in {elapsed:?}, over the five-second acceptance budget"
    );
}
