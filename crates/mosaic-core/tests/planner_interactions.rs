//! Calendar editing and subtask ordering through the same planner service used by the app.
use mosaic_core::Workspace;
use mosaic_core::error::Error;
use mosaic_core::planner::{
    CreateEpic, CreateEvent, CreateTask, CreateWorkSession, FutureSessionPolicy, MoveTask,
    PlannerEvent, PlannerService, PlannerTask, TaskStatus, UpdateEvent, UpdateWorkSession,
};

fn task(planner: &PlannerService, title: &str, parent_id: Option<String>) -> PlannerTask {
    planner
        .create_task(CreateTask {
            epic_id: None,
            parent_id,
            title: title.into(),
            description: String::new(),
            status: TaskStatus::New,
            due_date: None,
            estimate_minutes: None,
        })
        .unwrap()
}

fn event_update(event: &PlannerEvent, start: &str, end: &str) -> UpdateEvent {
    UpdateEvent {
        expected_revision: event.revision,
        title: event.title.clone(),
        description: event.description.clone(),
        location: event.location.clone(),
        meeting_url: event.meeting_url.clone(),
        participants: event.participants.clone(),
        epic_id: event.epic_id.clone(),
        color: event.color.clone(),
        all_day: event.all_day,
        start_value: start.into(),
        end_value: end.into(),
        timezone: event.timezone.clone(),
        recurrence_rule: event.recurrence_rule.clone(),
    }
}

#[test]
fn calendar_event_edits_preserve_metadata_and_persist_across_lifecycle_changes() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path()).unwrap();
    let planner = &workspace.planner;
    let epic = planner
        .create_epic(CreateEpic {
            title: "Planning".into(),
            description: String::new(),
            color: "#6477d4".into(),
        })
        .unwrap();
    let original = planner
        .create_event(CreateEvent {
            title: "Design review".into(),
            description: "Keep the review agenda".into(),
            location: "Room 1".into(),
            meeting_url: Some("https://example.com/review".into()),
            participants: vec!["anna@example.com".into()],
            epic_id: Some(epic.id.clone()),
            color: Some("#6477d4".into()),
            all_day: false,
            start_value: "2026-11-02T09:00:00+01:00".into(),
            end_value: "2026-11-02T10:00:00+01:00".into(),
            timezone: "Europe/Zurich".into(),
            recurrence_rule: None,
        })
        .unwrap();
    let earlier = planner
        .update_event(
            &original.id,
            event_update(&original, "2026-11-02T08:30:00+01:00", &original.end_value),
        )
        .unwrap();
    assert_eq!(earlier.start_value, "2026-11-02T07:30:00.000Z");
    assert_eq!(earlier.end_value, original.end_value);
    assert!(matches!(
        planner.update_event(
            &original.id,
            event_update(&original, &original.start_value, &original.end_value)
        ),
        Err(Error::Conflict { .. })
    ));
    let extended = planner
        .update_event(
            &earlier.id,
            event_update(&earlier, &earlier.start_value, "2026-11-02T10:30:00+01:00"),
        )
        .unwrap();
    assert_eq!(extended.start_value, earlier.start_value);
    assert_eq!(extended.end_value, "2026-11-02T09:30:00.000Z");
    assert_eq!(extended.description, original.description);
    assert_eq!(extended.location, original.location);
    assert_eq!(extended.meeting_url, original.meeting_url);
    assert_eq!(extended.participants, original.participants);
    assert_eq!(extended.epic_id, original.epic_id);
    assert_eq!(extended.color, original.color);
    let revision = planner.summary().unwrap().revision;
    assert!(matches!(
        planner.update_event(
            &extended.id,
            event_update(&extended, &extended.end_value, &extended.start_value)
        ),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        planner.trash_event(&extended.id, extended.revision),
        Err(Error::Invalid(_))
    ));
    assert_eq!(planner.summary().unwrap().revision, revision);
    assert_eq!(
        planner.events(false, false).unwrap(),
        vec![extended.clone()]
    );

    let archived = planner
        .archive_event(&extended.id, extended.revision)
        .unwrap();
    assert!(
        planner
            .calendar_range("2026-11-02", "2026-11-02")
            .unwrap()
            .events
            .is_empty()
    );
    assert_eq!(planner.events(true, false).unwrap(), vec![archived.clone()]);
    let trashed = planner
        .trash_event(&archived.id, archived.revision)
        .unwrap();
    assert!(planner.events(true, false).unwrap().is_empty());
    assert_eq!(planner.events(true, true).unwrap(), vec![trashed.clone()]);
    let restored = planner
        .restore_event(&trashed.id, trashed.revision)
        .unwrap();
    assert!(restored.archived_at.is_none() && restored.trashed_at.is_none());
    assert_eq!(
        planner
            .activity("event", &original.id)
            .unwrap()
            .iter()
            .map(|entry| entry.action.as_str())
            .collect::<Vec<_>>(),
        [
            "created", "updated", "updated", "archived", "trashed", "restored"
        ]
    );
    drop(workspace);
    let reopened = Workspace::open(dir.path()).unwrap();
    assert_eq!(
        reopened.planner.events(false, false).unwrap(),
        vec![restored]
    );
    let range = reopened
        .planner
        .calendar_range("2026-11-02", "2026-11-02")
        .unwrap();
    assert_eq!(range.events.len(), 1);
    assert_eq!(range.events[0].start_value, extended.start_value);
    assert_eq!(range.events[0].end_value, extended.end_value);
}

#[test]
fn work_session_resizing_checks_revisions_and_cannot_reactivate_cancelled_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path()).unwrap();
    let planner = &workspace.planner;
    let parent = task(planner, "Implementation", None);
    let session = planner
        .create_work_session(CreateWorkSession {
            task_id: parent.id.clone(),
            all_day: false,
            start_value: "2026-11-02T09:00:00Z".into(),
            end_value: "2026-11-02T10:00:00Z".into(),
            timezone: "UTC".into(),
        })
        .unwrap();
    let input = UpdateWorkSession {
        expected_revision: session.revision,
        all_day: false,
        start_value: "2026-11-02T08:30:00Z".into(),
        end_value: "2026-11-02T10:15:00Z".into(),
        timezone: "UTC".into(),
    };
    let resized = planner
        .update_work_session(&session.id, input.clone())
        .unwrap();
    assert_eq!(resized.task_id, parent.id);
    assert_eq!(resized.start_value, "2026-11-02T08:30:00.000Z");
    assert_eq!(resized.end_value, "2026-11-02T10:15:00.000Z");
    assert!(matches!(
        planner.update_work_session(&session.id, input.clone()),
        Err(Error::Conflict { .. })
    ));
    let range = planner.calendar_range("2026-11-02", "2026-11-02").unwrap();
    assert_eq!(range.work_sessions[0].session, resized);
    assert_eq!(range.workload[0].minutes, 105);
    let cancelled = planner
        .cancel_work_session(&session.id, resized.revision)
        .unwrap();
    let revision = planner.summary().unwrap().revision;
    assert!(matches!(
        planner.update_work_session(
            &session.id,
            UpdateWorkSession {
                expected_revision: cancelled.revision,
                ..input
            }
        ),
        Err(Error::Invalid(_))
    ));
    assert_eq!(planner.summary().unwrap().revision, revision);
    assert!(
        planner
            .work_sessions(Some(&parent.id), false)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        planner.work_sessions(Some(&parent.id), true).unwrap(),
        vec![cancelled]
    );
    assert!(
        planner
            .calendar_range("2026-11-02", "2026-11-02")
            .unwrap()
            .work_sessions
            .is_empty()
    );
}

#[test]
fn reordering_completed_subtasks_keeps_their_children_and_parent_selection_identity() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path()).unwrap();
    let planner = &workspace.planner;
    let parent = task(planner, "Release", None);
    let first = task(planner, "First", Some(parent.id.clone()));
    let second = task(planner, "Second", Some(parent.id.clone()));
    let nested = task(planner, "Nested", Some(first.id.clone()));
    let completed = planner
        .complete_task(&first.id, first.revision, true, FutureSessionPolicy::Keep)
        .unwrap();
    let moved = planner
        .move_task(
            &completed.id,
            MoveTask {
                expected_revision: completed.revision,
                epic_id: completed.epic_id.clone(),
                parent_id: completed.parent_id.clone(),
                status: completed.status,
                position: second.position + 1024,
            },
        )
        .unwrap();
    assert_eq!(moved.status, TaskStatus::Done);
    assert_eq!(moved.completed_at, completed.completed_at);
    let tasks = planner.tasks(false, false).unwrap();
    assert_eq!(
        tasks.iter().find(|item| item.id == parent.id).unwrap(),
        &parent
    );
    let unchanged_child = tasks.iter().find(|item| item.id == nested.id).unwrap();
    assert_eq!(
        unchanged_child.parent_id.as_deref(),
        Some(first.id.as_str())
    );
    assert_eq!(unchanged_child.status, TaskStatus::New);
    let mut siblings = tasks
        .iter()
        .filter(|item| item.parent_id.as_deref() == Some(parent.id.as_str()))
        .collect::<Vec<_>>();
    siblings.sort_by_key(|item| item.position);
    assert_eq!(
        siblings
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        [second.id.as_str(), first.id.as_str()]
    );
    assert_eq!(
        planner
            .activity("task", &first.id)
            .unwrap()
            .last()
            .unwrap()
            .summary,
        "Reordered task"
    );
    let revision = planner.summary().unwrap().revision;
    assert!(matches!(
        planner.move_task(
            &moved.id,
            MoveTask {
                expected_revision: moved.revision,
                epic_id: moved.epic_id.clone(),
                parent_id: moved.parent_id.clone(),
                status: TaskStatus::New,
                position: moved.position,
            }
        ),
        Err(Error::Invalid(_))
    ));
    assert_eq!(planner.summary().unwrap().revision, revision);
}
