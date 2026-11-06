use super::*;
use crate::Workspace;
use std::fs;
use std::time::{Duration, Instant};

fn in_memory() -> PlannerStore {
    PlannerStore::in_memory().unwrap()
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
    assert_eq!(
        store
            .activity("task", &parent.id)
            .unwrap()
            .last()
            .unwrap()
            .summary,
        "Moved task \"Ship\" from New to In progress"
    );

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
    assert_eq!(range.unscheduled_tasks.len(), 1);
    assert_eq!(range.unscheduled_tasks[0].id, task.id);
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
fn ical_text_unescape_handles_backslash_before_n_and_round_trips() {
    // `\\new\\table` is the escaped form of `\new\table`: the `\\` must collapse to a single
    // backslash instead of the second backslash combining with `n` into a newline.
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:path@example.test\r\nDTSTART;VALUE=DATE:20261014\r\nDTEND;VALUE=DATE:20261015\r\nSUMMARY:Path C:\\\\new\\\\table\\, a\\; b\r\nDESCRIPTION:Line\\none\\NTwo\\\\n\\\\\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut store = in_memory();
    let preview = store
        .preview_ical_import("file:path.ics", content, "UTC")
        .unwrap();
    let candidate = &preview.candidates[0];
    assert_eq!(candidate.title, "Path C:\\new\\table, a; b");
    assert_eq!(candidate.event.description, "Line\none\nTwo\\n\\");

    let selected = vec![candidate.key.clone()];
    store.import_ical(&preview, &selected, false).unwrap();
    let exported = store.export_ical().unwrap();
    let roundtrip = PlannerStore::in_memory()
        .unwrap()
        .preview_ical_import("roundtrip", &exported, "UTC")
        .unwrap();
    assert_eq!(roundtrip.candidates[0].title, candidate.title);
    assert_eq!(
        roundtrip.candidates[0].event.description,
        candidate.event.description
    );
}

#[test]
fn ical_overlay_accepts_week_start_rules() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:weekly@example.test\r\nDTSTART;TZID=Europe/Zurich:20260325T090000\r\nDTEND;TZID=Europe/Zurich:20260325T100000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;WKST=SU\r\nSUMMARY:Fortnightly sync\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    let overlay = overlay_occurrences(
        content,
        "subscription",
        "Team",
        None,
        "2026-03-25",
        "2026-04-12",
        "Europe/Zurich",
    )
    .unwrap();

    assert_eq!(overlay.len(), 1);
    assert_eq!(overlay[0].occurrence_key, "2026-04-05");
}

#[test]
fn ical_month_days_import_export_and_overlay_keep_wall_clock_and_exclusions() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:monthly@example.test\r\nDTSTART;TZID=Europe/Zurich:20260131T090000\r\nDTEND;TZID=Europe/Zurich:20260131T100000\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1\r\nEXDATE;TZID=Europe/Zurich:20260228T090000\r\nSUMMARY:Month end\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let overlay = overlay_occurrences(
        content,
        "subscription",
        "Team",
        None,
        "2026-01-01",
        "2026-04-30",
        "Europe/Zurich",
    )
    .unwrap();
    assert_eq!(
        overlay
            .iter()
            .map(|item| item.occurrence_key.as_str())
            .collect::<Vec<_>>(),
        vec!["2026-01-31", "2026-03-31", "2026-04-30"]
    );
    assert_eq!(overlay[0].start_value, "2026-01-31T08:00:00.000Z");
    assert_eq!(overlay[1].start_value, "2026-03-31T07:00:00.000Z");
    let mut store = in_memory();
    let preview = store
        .preview_ical_import("monthly", content, "Europe/Zurich")
        .unwrap();
    store
        .import_ical(&preview, &[preview.candidates[0].key.clone()], false)
        .unwrap();
    let range = store.calendar_range("2026-03-01", "2026-04-30").unwrap();
    assert_eq!(range.events.len(), 2);
    let exported = store.export_ical().unwrap();
    assert!(exported.contains("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1"));
    assert_eq!(
        overlay_occurrences(
            &exported,
            "roundtrip",
            "Team",
            None,
            "2026-03-01",
            "2026-04-30",
            "Europe/Zurich"
        )
        .unwrap()
        .len(),
        2
    );
}

#[test]
fn ical_overlay_replaces_recurring_exceptions_and_hides_cancellations() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:series@example.test\r\nSEQUENCE:1\r\nDTSTART;TZID=Europe/Zurich:20260325T090000\r\nDTEND;TZID=Europe/Zurich:20260325T100000\r\nRRULE:FREQ=DAILY;UNTIL=20260328\r\nEXDATE;TZID=Europe/Zurich:20260328T090000\r\nSUMMARY:Daily sync\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series@example.test\r\nSEQUENCE:1\r\nRECURRENCE-ID;TZID=Europe/Zurich:20260326T090000\r\nDTSTART;TZID=Europe/Zurich:20260326T100000\r\nDTEND;TZID=Europe/Zurich:20260326T110000\r\nSUMMARY:Old sync time\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series@example.test\r\nSEQUENCE:2\r\nRECURRENCE-ID;TZID=Europe/Zurich:20260326T090000\r\nDTSTART;TZID=Europe/Zurich:20260326T110000\r\nDTEND;TZID=Europe/Zurich:20260326T120000\r\nSUMMARY:Updated sync time\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series@example.test\r\nSEQUENCE:2\r\nRECURRENCE-ID;TZID=Europe/Zurich:20260327T090000\r\nDTSTART;TZID=Europe/Zurich:20260327T090000\r\nDTEND;TZID=Europe/Zurich:20260327T100000\r\nSTATUS:CONFIRMED\r\nSUMMARY:Canceled: Daily sync\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    let overlay = overlay_occurrences(
        content,
        "subscription",
        "Team",
        None,
        "2026-03-25",
        "2026-03-28",
        "Europe/Zurich",
    )
    .unwrap();

    assert_eq!(overlay.len(), 2);
    assert_eq!(overlay[0].occurrence_key, "2026-03-25");
    assert_eq!(overlay[1].occurrence_key, "2026-03-26");
    assert_eq!(overlay[1].title, "Updated sync time");
    assert_eq!(overlay[1].start_value, "2026-03-26T10:00:00.000Z");
}

#[test]
fn ical_preview_keeps_latest_revision_and_omits_cancelled_events() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:updated@example.test\r\nSEQUENCE:1\r\nDTSTAMP:20260320T080000Z\r\nDTSTART;TZID=Europe/Zurich:20260325T090000\r\nDTEND;TZID=Europe/Zurich:20260325T100000\r\nSUMMARY:Initial meeting\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:updated@example.test\r\nSEQUENCE:2\r\nDTSTAMP:20260321T080000Z\r\nDTSTART;TZID=Europe/Zurich:20260325T110000\r\nDTEND;TZID=Europe/Zurich:20260325T120000\r\nSUMMARY:Updated meeting\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:cancelled@example.test\r\nSEQUENCE:3\r\nDTSTART;TZID=Europe/Zurich:20260325T130000\r\nDTEND;TZID=Europe/Zurich:20260325T140000\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    let preview = in_memory()
        .preview_ical_import("revision-test", content, "Europe/Zurich")
        .unwrap();

    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].title, "Updated meeting");
    assert_eq!(
        preview.candidates[0].start_value,
        "2026-03-25T10:00:00.000Z"
    );
}

#[test]
fn outlook_windows_timezones_are_normalized_to_iana() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:outlook@example.test\r\nDTSTART;TZID=W. Europe Standard Time:20261019T090000\r\nDTEND;TZID=\"W. Europe Standard Time\":20261019T100000\r\nSUMMARY:Outlook event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut store = in_memory();
    let preview = store
        .preview_ical_import("outlook", content, "UTC")
        .unwrap();

    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].timezone, "Europe/Berlin");
    assert_eq!(
        preview.candidates[0].start_value,
        "2026-10-19T07:00:00.000Z"
    );
    assert_eq!(preview.candidates[0].end_value, "2026-10-19T08:00:00.000Z");

    let selected = vec![preview.candidates[0].key.clone()];
    store.import_ical(&preview, &selected, false).unwrap();
    let exported = store.export_ical().unwrap();
    assert!(exported.contains("DTSTART;TZID=Europe/Berlin:20261019T090000"));
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
fn a_closed_vault_copy_keeps_planner_content_and_history() {
    let source = tempfile::tempdir().unwrap();
    let source_workspace = Workspace::open(source.path()).unwrap();
    let epic = source_workspace
        .planner
        .create_epic(CreateEpic {
            title: "Portable".into(),
            description: "Travels with the vault".into(),
            color: "cyan".into(),
        })
        .unwrap();
    source_workspace
        .planner
        .create_task(CreateTask {
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
    assert_eq!(copied.planner.summary().unwrap().tasks, 1);
    assert_eq!(copied.planner.epics(false, false).unwrap()[0].id, epic.id);
    let task = copied.planner.tasks(false, false).unwrap().pop().unwrap();
    assert_eq!(copied.planner.activity("task", &task.id).unwrap().len(), 1);
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
    // Notes still open; the planner reports the damage when it's first needed (the app asks at
    // once, to offer the restore).
    let notes = Workspace::open(dir.path()).unwrap();
    assert!(notes.files.list("", true).is_ok());
    let damaged = notes.planner.open().unwrap_err().to_string();
    // The store's own message comes through, so the app can tell when to offer the restore.
    let cause = PlannerStore::open(dir.path()).err().unwrap().to_string();
    assert!(damaged.contains(&cause), "{damaged}");
    assert!(notes.planner.summary().is_err());
    drop(notes);
    let corrupt = PlannerStore::restore_last_backup(dir.path()).unwrap();
    assert!(corrupt.is_file());
    let restored = PlannerStore::open(dir.path()).unwrap();
    assert_eq!(restored.summary().unwrap().epics, 1);
}

#[test]
fn opening_a_pre_planner_vault_and_board_never_changes_markdown() {
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
    assert!(workspace.planner.summary().unwrap().is_empty);
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

#[test]
fn ical_import_keeps_exdates_and_links_recurrence_id_overrides_to_the_series() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
        BEGIN:VEVENT\r\nUID:s1\r\nDTSTART:20260401T090000Z\r\nDTEND:20260401T100000Z\r\n\
        SUMMARY:Daily\r\nRRULE:FREQ=DAILY\r\nEXDATE:20260402T090000Z\r\nEND:VEVENT\r\n\
        BEGIN:VEVENT\r\nUID:s1\r\nRECURRENCE-ID:20260403T090000Z\r\nDTSTART:20260403T110000Z\r\n\
        DTEND:20260403T120000Z\r\nSUMMARY:Moved\r\nEND:VEVENT\r\n\
        BEGIN:VEVENT\r\nUID:s1\r\nRECURRENCE-ID:20260404T090000Z\r\nDTSTART:20260404T090000Z\r\n\
        DTEND:20260404T100000Z\r\nSUMMARY:Dropped\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut store = in_memory();
    let preview = store.preview_ical_import("file", content, "UTC").unwrap();
    let keys = preview
        .candidates
        .iter()
        .map(|candidate| candidate.key.clone())
        .collect::<Vec<_>>();
    store.import_ical(&preview, &keys, false).unwrap();

    let range = store.calendar_range("2026-04-01", "2026-04-05").unwrap();
    let mut seen = range
        .events
        .iter()
        .map(|item| {
            (
                item.start_value[..10].to_string(),
                item.title.clone(),
                item.start_value[11..16].to_string(),
            )
        })
        .collect::<Vec<_>>();
    seen.sort();
    let expected = [
        ("2026-04-01", "Daily", "09:00"),
        ("2026-04-03", "Moved", "11:00"),
        ("2026-04-05", "Daily", "09:00"),
    ]
    .map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string()));
    assert_eq!(seen, expected);
}

#[test]
fn ical_import_keeps_an_override_standalone_when_its_series_does_not_recur_there() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
        BEGIN:VEVENT\r\nUID:s2\r\nDTSTART:20260401T090000Z\r\nDTEND:20260401T100000Z\r\n\
        SUMMARY:Short\r\nRRULE:FREQ=DAILY;COUNT=2\r\nEND:VEVENT\r\n\
        BEGIN:VEVENT\r\nUID:s2\r\nRECURRENCE-ID:20260410T090000Z\r\nDTSTART:20260410T110000Z\r\n\
        DTEND:20260410T120000Z\r\nSUMMARY:Stale\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut store = in_memory();
    let preview = store.preview_ical_import("file", content, "UTC").unwrap();
    let keys = preview
        .candidates
        .iter()
        .map(|candidate| candidate.key.clone())
        .collect::<Vec<_>>();
    store.import_ical(&preview, &keys, false).unwrap();

    let range = store.calendar_range("2026-04-10", "2026-04-10").unwrap();
    let titles = range
        .events
        .iter()
        .map(|item| item.title.as_str())
        .collect::<Vec<_>>();
    assert_eq!(titles, ["Stale"]);
}

fn import_all(store: &mut PlannerStore, content: &str) {
    let preview = store.preview_ical_import("file", content, "UTC").unwrap();
    let keys = preview
        .candidates
        .iter()
        .map(|candidate| candidate.key.clone())
        .collect::<Vec<_>>();
    store.import_ical(&preview, &keys, false).unwrap();
}

#[test]
fn ical_import_resolves_utc_exdate_and_recurrence_id_in_the_series_timezone() {
    // 17:00 Los Angeles on 2026-04-03 is 2026-04-04T00:00Z: the UTC date is a day later.
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
        BEGIN:VEVENT\r\nUID:tz\r\nDTSTART;TZID=America/Los_Angeles:20260401T170000\r\n\
        DTEND;TZID=America/Los_Angeles:20260401T180000\r\nSUMMARY:Daily\r\nRRULE:FREQ=DAILY\r\n\
        EXDATE:20260402T000000Z\r\nEND:VEVENT\r\n\
        BEGIN:VEVENT\r\nUID:tz\r\nRECURRENCE-ID:20260404T000000Z\r\nDTSTART:20260404T020000Z\r\n\
        DTEND:20260404T030000Z\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut store = in_memory();
    import_all(&mut store, content);
    let range = store.calendar_range("2026-04-01", "2026-04-05").unwrap();
    let mut titles = range
        .events
        .iter()
        .map(|item| (item.occurrence_key.clone(), item.title.clone()))
        .collect::<Vec<_>>();
    titles.sort();
    // The UTC EXDATE removes 04-01 (Los Angeles), the UTC override replaces 04-03; neither
    // may land on the next UTC day.
    let daily = titles
        .iter()
        .filter(|(_, title)| title == "Daily")
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        daily,
        ["2026-04-02", "2026-04-04", "2026-04-05"],
        "{titles:?}"
    );
    assert_eq!(
        titles.iter().filter(|(_, title)| title == "Moved").count(),
        1,
        "{titles:?}"
    );
}

#[test]
fn ical_import_keeps_an_override_standalone_when_a_multi_day_series_only_touches_its_date() {
    // Weekly Mon-Wed all-day series: Tuesday is inside an occurrence but is not a key.
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
        BEGIN:VEVENT\r\nUID:md\r\nDTSTART;VALUE=DATE:20260406\r\nDTEND;VALUE=DATE:20260409\r\n\
        SUMMARY:Retreat\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n\
        BEGIN:VEVENT\r\nUID:md\r\nRECURRENCE-ID;VALUE=DATE:20260407\r\nDTSTART;VALUE=DATE:20260407\r\n\
        DTEND;VALUE=DATE:20260408\r\nSUMMARY:Stray\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut store = in_memory();
    import_all(&mut store, content);
    let range = store.calendar_range("2026-04-07", "2026-04-07").unwrap();
    assert!(range.events.iter().any(|item| item.title == "Stray"));
}

#[test]
fn ical_import_links_an_override_to_a_stored_series_in_the_series_timezone() {
    let master = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
        BEGIN:VEVENT\r\nUID:db\r\nDTSTART;TZID=America/Los_Angeles:20260401T170000\r\n\
        DTEND;TZID=America/Los_Angeles:20260401T180000\r\nSUMMARY:Daily\r\nRRULE:FREQ=DAILY\r\n\
        END:VEVENT\r\nEND:VCALENDAR\r\n";
    // Only the changed occurrence: 20260404T000000Z is 17:00 on 04-03 in Los Angeles.
    let update = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
        BEGIN:VEVENT\r\nUID:db\r\nRECURRENCE-ID:20260404T000000Z\r\nDTSTART:20260404T020000Z\r\n\
        DTEND:20260404T030000Z\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut store = in_memory();
    import_all(&mut store, master);
    import_all(&mut store, update);
    let range = store.calendar_range("2026-04-02", "2026-04-05").unwrap();
    let daily = range
        .events
        .iter()
        .filter(|item| item.title == "Daily")
        .map(|item| item.occurrence_key.as_str())
        .collect::<Vec<_>>();
    assert!(!daily.contains(&"2026-04-03"), "{daily:?}");
    assert!(daily.contains(&"2026-04-04"), "{daily:?}");
    assert_eq!(
        range
            .events
            .iter()
            .filter(|item| item.title == "Moved")
            .count(),
        1
    );
}

fn export_with_event(
    title: &str,
    description: &str,
    url: Option<&str>,
    participants: &[&str],
) -> String {
    let mut store = in_memory();
    store
        .create_event(CreateEvent {
            title: title.into(),
            description: description.into(),
            location: String::new(),
            meeting_url: url.map(str::to_string),
            participants: participants.iter().map(|p| p.to_string()).collect(),
            epic_id: None,
            color: None,
            all_day: false,
            start_value: "2026-10-13T07:00:00.000Z".into(),
            end_value: "2026-10-13T08:00:00.000Z".into(),
            timezone: "Europe/Zurich".into(),
            recurrence_rule: None,
        })
        .unwrap();
    store.export_ical().unwrap()
}

/// RFC 5545 unfolding: remove each CRLF that is followed by exactly one space or tab.
fn rfc_unfold(content: &str) -> String {
    content.replace("\r\n ", "").replace("\r\n\t", "")
}

fn assert_folded(exported: &str) {
    assert!(exported.ends_with("\r\n"));
    for line in exported.split("\r\n") {
        assert!(line.len() <= 75, "line over 75 octets: {line:?}");
        assert!(
            !line.contains('\r') && !line.contains('\n'),
            "bare CR/LF: {line:?}"
        );
    }
}

#[test]
fn ical_export_folds_long_ascii_lines_and_unfolds_losslessly() {
    let title = "word ".repeat(40).trim().to_string();
    let exported = export_with_event(&title, "", None, &[]);
    assert_folded(&exported);
    assert!(exported.contains("\r\n "));
    assert!(rfc_unfold(&exported).contains(&format!("SUMMARY:{title}\r\n")));
}

#[test]
fn ical_export_never_splits_multibyte_characters_when_folding() {
    for ch in ['é', '日', '😀'] {
        for pad in 0..4 {
            let title = format!("{}{}", "a".repeat(pad), ch.to_string().repeat(60));
            let exported = export_with_event(&title, "", None, &[]);
            assert_folded(&exported);
            assert!(rfc_unfold(&exported).contains(&format!("SUMMARY:{title}\r\n")));
        }
    }
}

#[test]
fn ical_export_normalises_carriage_returns_in_text() {
    let exported = export_with_event("Title", "one\r\ntwo\rthree\nfour", None, &[]);
    assert_folded(&exported);
    assert!(exported.contains("DESCRIPTION:one\\ntwo\\nthree\\nfour\r\n"));
}

#[test]
fn ical_export_cannot_inject_lines_through_url_or_attendee() {
    let exported = export_with_event(
        "Title",
        "",
        Some("https://example.test/\r\nATTENDEE:mailto:evil@example.test"),
        &[
            "a@example.test\r\nDESCRIPTION:injected",
            "b@example.test\nX-EVIL:1",
        ],
    );
    assert_folded(&exported);
    let unfolded = rfc_unfold(&exported);
    for line in unfolded.split("\r\n") {
        assert!(
            !line.starts_with("DESCRIPTION:") && !line.starts_with("X-EVIL"),
            "injected line: {line:?}"
        );
    }
    assert!(
        unfolded.contains("\r\nURL:https://example.test/ATTENDEE:mailto:evil@example.test\r\n")
    );
    assert_eq!(unfolded.matches("\r\nATTENDEE:").count(), 2);
}

#[test]
fn ical_export_roundtrips_folded_text_through_import() {
    let title = "Quarterly planning,review;alignment "
        .repeat(4)
        .trim()
        .to_string()
        + "é日😀end";
    let description = "x".repeat(200) + "\nsecond line";
    let exported = export_with_event(&title, &description, None, &[]);
    assert_folded(&exported);
    let preview = in_memory()
        .preview_ical_import("roundtrip", &exported, "UTC")
        .unwrap();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].title, title);
    assert_eq!(preview.candidates[0].event.description, description);
}

#[test]
fn ical_export_never_folds_before_whitespace_and_roundtrips_through_import() {
    // "SUMMARY:" is 8 octets, so 67 chars fill the first line exactly before the space.
    for gap in ["  ", " ", "\t"] {
        let title = format!("{}{gap}b{gap}{}", "a".repeat(67), "c".repeat(70));
        let exported = export_with_event(&title, "", None, &[]);
        assert_folded(&exported);
        assert!(!exported.contains("\r\n  ") && !exported.contains("\r\n \t"));
        assert!(rfc_unfold(&exported).contains(&format!("SUMMARY:{title}\r\n")));
        let preview = in_memory()
            .preview_ical_import("roundtrip", &exported, "UTC")
            .unwrap();
        assert_eq!(preview.candidates[0].title, title.trim());
    }
}

#[test]
fn nested_valarm_properties_do_not_override_event_properties() {
    let content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:alarm@example.com\r\nDTSTART:20261013T090000Z\r\nSUMMARY:S\r\nDESCRIPTION:Real description\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nSUMMARY:Alarm summary\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let store = in_memory();
    let preview = store
        .preview_ical_import("file:alarm.ics", content, "UTC")
        .unwrap();
    assert_eq!(preview.candidates[0].event.title, "S");
    assert_eq!(preview.candidates[0].event.description, "Real description");
}

#[test]
fn validate_ical_accepts_feeds_with_and_without_a_utf8_bom() {
    let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:bom\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T100000Z\r\nSUMMARY:Working event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    assert_eq!(validate_ical(ics, "UTC").unwrap(), 1);
    assert_eq!(validate_ical(&format!("\u{feff}{ics}"), "UTC").unwrap(), 1);
}

#[test]
fn one_unsupported_recurrence_never_rejects_the_whole_feed() {
    let event = |uid: &str, rule: &str| {
        format!(
            "BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T100000Z\r\nSUMMARY:{uid}\r\n{rule}END:VEVENT\r\n"
        )
    };
    let wrap =
        |events: String| format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{events}END:VCALENDAR\r\n");
    // YEARLY and COUNT are supported now.
    for rule in ["RRULE:FREQ=YEARLY\r\n", "RRULE:FREQ=WEEKLY;COUNT=3\r\n"] {
        assert_eq!(
            validate_ical(&wrap(event("a", rule)), "UTC").unwrap(),
            1,
            "{rule}"
        );
    }
    // A rule that is still unsupported is skipped; the other events survive.
    let feed = wrap(
        event("good", "")
            + &event("bad", "RRULE:FREQ=DAILY;BYSETPOS=1\r\n")
            + &event("yearly", "RRULE:FREQ=YEARLY\r\n"),
    );
    assert_eq!(validate_ical(&feed, "UTC").unwrap(), 2);
    let store = in_memory();
    let preview = store.preview_ical_import("feed", &feed, "UTC").unwrap();
    let mut uids = preview
        .candidates
        .iter()
        .map(|c| c.source_uid.as_str())
        .collect::<Vec<_>>();
    uids.sort();
    assert_eq!(uids, vec!["good", "yearly"]);
    let occurrences =
        overlay_occurrences(&feed, "s", "S", None, "2026-11-03", "2026-11-03", "UTC").unwrap();
    assert_eq!(occurrences.len(), 2);
}

#[test]
fn dst_gap_recurring_event_does_not_fail_the_calendar_range() {
    let mut store = PlannerStore::in_memory().unwrap();
    let make = |title: &str, start: &str, end: &str, rule: Option<&str>| CreateEvent {
        title: title.into(),
        description: String::new(),
        location: String::new(),
        meeting_url: None,
        participants: vec![],
        epic_id: None,
        color: None,
        all_day: false,
        start_value: start.into(),
        end_value: end.into(),
        timezone: "Europe/Zurich".into(),
        recurrence_rule: rule.map(Into::into),
    };
    store
        .create_event(make(
            "Gap",
            "2026-03-27T01:30:00.000Z",
            "2026-03-27T02:00:00.000Z",
            Some("FREQ=DAILY"),
        ))
        .unwrap();
    store
        .create_event(make(
            "Other",
            "2026-03-27T08:00:00.000Z",
            "2026-03-27T09:00:00.000Z",
            Some("FREQ=DAILY"),
        ))
        .unwrap();
    let range = store.calendar_range("2026-03-23", "2026-04-02").unwrap();
    let count = |title: &str| {
        range
            .events
            .iter()
            .filter(|event| event.title == title)
            .count()
    };
    assert_eq!(count("Gap"), 7);
    assert_eq!(count("Other"), 7);
    let gap_day = range
        .events
        .iter()
        .find(|event| event.title == "Gap" && event.start_value.starts_with("2026-03-29"))
        .unwrap();
    assert_eq!(gap_day.start_value, "2026-03-29T01:30:00.000Z");
    assert_eq!(gap_day.end_value, "2026-03-29T02:00:00.000Z");

    // A corrupt stored event is skipped; the other events are still returned.
    store
        .conn
        .execute(
            "UPDATE events SET timezone = 'Not/AZone' WHERE title = 'Gap'",
            [],
        )
        .unwrap();
    let range = store.calendar_range("2026-03-23", "2026-04-02").unwrap();
    assert_eq!(range.events.iter().filter(|e| e.title == "Gap").count(), 0);
    assert_eq!(
        range.events.iter().filter(|e| e.title == "Other").count(),
        7
    );
}

#[test]
fn activity_records_actor_field_changes_and_readable_text() {
    let mut store = in_memory();
    store
        .set_activity_context("agent", Some("claude-code"))
        .unwrap();
    let created = task(&mut store, None, None, "Write docs");
    let updated = store
        .update_task(
            &created.id,
            UpdateTask {
                expected_revision: created.revision,
                title: Some("Write the docs".into()),
                description: None,
                due_date: Some("2026-12-01".into()),
                clear_due_date: false,
                estimate_minutes: None,
                clear_estimate: false,
            },
        )
        .unwrap();
    store.set_activity_context("app", None).unwrap();
    let moved = store
        .move_task(
            &updated.id,
            MoveTask {
                expected_revision: updated.revision,
                epic_id: None,
                parent_id: None,
                status: TaskStatus::Blocked,
                position: 1024,
            },
        )
        .unwrap();

    let log = store.activity("task", &created.id).unwrap();
    assert_eq!(log.len(), 3);
    assert_eq!(log[0].source.as_deref(), Some("agent"));
    assert_eq!(log[0].actor.as_deref(), Some("claude-code"));
    assert!(
        log[0].changes.is_empty(),
        "creation carries the full snapshot instead"
    );

    let edit = &log[1];
    assert_eq!(
        edit.summary,
        "Updated task \"Write the docs\": due_date, title"
    );
    let fields: Vec<_> = edit.changes.iter().map(|c| c.field.as_str()).collect();
    assert_eq!(fields, ["due_date", "title"]);
    assert_eq!(edit.changes[1].from, Some(serde_json::json!("Write docs")));
    assert_eq!(
        edit.changes[1].to,
        Some(serde_json::json!("Write the docs"))
    );
    assert_eq!(edit.changes[0].from, None);
    assert_eq!(edit.changes[0].to, Some(serde_json::json!("2026-12-01")));

    let transition = &log[2];
    assert_eq!(transition.source.as_deref(), Some("app"));
    assert_eq!(transition.actor, None);
    let status = transition
        .changes
        .iter()
        .find(|c| c.field == "status")
        .unwrap();
    assert_eq!(status.from, Some(serde_json::json!("new")));
    assert_eq!(status.to, Some(serde_json::json!("blocked")));
    assert_eq!(moved.status, TaskStatus::Blocked);
    assert!(transition.text.contains("| app |"));
    assert!(transition.text.contains("status: \"new\" -> \"blocked\""));
    assert!(log[0].text.contains("| agent:claude-code |"));
    assert!(
        !transition
            .changes
            .iter()
            .any(|c| c.field == "revision" || c.field == "updated_at")
    );
}

#[test]
fn cascaded_session_cancellation_explains_why() {
    let mut store = in_memory();
    let parent = task(&mut store, None, None, "Plan trip");
    let session = store
        .create_work_session(CreateWorkSession {
            task_id: parent.id.clone(),
            all_day: true,
            start_value: "2999-01-01".into(),
            end_value: "2999-01-02".into(),
            timezone: "UTC".into(),
        })
        .unwrap();
    store
        .complete_task(
            &parent.id,
            parent.revision,
            false,
            FutureSessionPolicy::Cancel,
        )
        .unwrap();
    let log = store.activity("work_session", &session.id).unwrap();
    let cancelled = log.iter().find(|e| e.action == "cancelled").unwrap();
    assert!(cancelled.reason.as_deref().unwrap().contains(&parent.id));
    assert_eq!(cancelled.changes[0].field, "state");
    assert!(cancelled.text.contains("reason: task"));
    let done = store.activity("task", &parent.id).unwrap();
    assert!(done.last().unwrap().summary.contains("status New -> done"));
}

#[test]
fn legacy_activity_rows_stay_readable_with_derived_changes() {
    let mut store = in_memory();
    let t = task(&mut store, None, None, "Old");
    // A row as written by schema v2: no source, actor, reason or stored changes.
    store
        .conn
        .execute(
            "INSERT INTO activity(entity_kind, entity_id, occurred_at, action, summary, before_json, after_json)
             VALUES ('task', ?1, '2026-01-01T00:00:00.000Z', 'updated', 'Updated task',
                     '{\"title\":\"A\",\"revision\":1}', '{\"title\":\"B\",\"revision\":2}')",
            [&t.id],
        )
        .unwrap();
    let legacy = store.activity("task", &t.id).unwrap().pop().unwrap();
    assert_eq!(legacy.source, None);
    assert_eq!(legacy.changes.len(), 1);
    assert_eq!(legacy.changes[0].field, "title");
    assert!(legacy.text.contains("| unknown |"));
}

#[test]
fn workspace_source_and_actor_reach_planner_activity() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open(dir.path())
        .unwrap()
        .with_source(crate::history::Source::Agent);
    ws.set_actor("claude-code");
    let created = ws
        .planner
        .create_task(CreateTask {
            epic_id: None,
            parent_id: None,
            title: "From agent".into(),
            description: String::new(),
            status: TaskStatus::New,
            due_date: None,
            estimate_minutes: None,
        })
        .unwrap();
    let entry = ws.planner.activity("task", &created.id).unwrap().remove(0);
    assert_eq!(entry.source.as_deref(), Some("agent"));
    assert_eq!(entry.actor.as_deref(), Some("claude-code"));
}
