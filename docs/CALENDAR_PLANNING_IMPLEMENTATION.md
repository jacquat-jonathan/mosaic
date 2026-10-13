# Calendar planning — implementation plan

Product decisions live in the Mosaic vault note `Ideation/Calendar planning.md`. This document is the
repository-facing handoff: current code, target architecture, migration, ordered delivery and acceptance
criteria. If this document and the vault note disagree, stop and reconcile them before coding.

## Delivery and branch policy

- `main` is the release branch; do not develop ordinary changes there.
- `dev` is the long-lived integration branch for unreleased batches.
- Start each batch from an updated `dev` on `codex/<topic>`, test and commit there, then merge it into
  `dev`. The person decides when branches are pushed or pull requests are opened.
- Several complete batches may accumulate on `dev`. Merge `dev` into `main` only when an update is
  explicitly requested and the combined release gate passes.
- Create or push a release tag only after the release merge is ready and explicitly requested.

## Fixed scope

- Plan has two primary destinations: Board and Calendar.
- Planner tasks are independent per-vault objects, not Markdown checkboxes.
- The planner is single-person. There are no accounts, assignments, collaboration permissions,
  invitations or responses.
- Epics are colored swimlanes. Tasks and subtasks inherit their epic color.
- Tasks support due dates, estimates and multiple scheduled work sessions.
- Calendar supports local timed/all-day events and simple recurrence.
- External calendars support automatically refreshed read-only iCalendar overlays and one-time `.ics`
  import. There is no two-way synchronization.
- Existing Markdown tasks stay unchanged and continue to work in notes, queries, CLI and MCP. Import
  into the planner is explicit and does not create ongoing synchronization.

## Current implementation to replace or retain

| Area | Current code | Direction |
| --- | --- | --- |
| Markdown task parsing | `crates/mosaic-core/src/parse.rs`, `index.rs`, `query.rs` | Retain for note tasks and migration scanning |
| Markdown workflow | `crates/mosaic-core/src/task_board.rs`, `api.rs::set_task_workflow` | Retain as legacy note behavior; do not reuse as planner storage |
| Daily-note calendar | `crates/mosaic-core/src/days.rs` | Retain for CLI/MCP compatibility; new UI uses planner APIs |
| Task board UI | `ui/src/views/TaskBoard.tsx`, `taskBoardModel.ts` | Replace data source and layout; preserve useful accessibility patterns |
| Calendar UI | `ui/src/views/CalendarView.tsx`, `calendar.ts` | Replace task-based model with events, sessions and due markers |
| Plan navigation | `AreaSidebar.tsx`, `SpecialView.tsx`, `specialTabs.ts`, `commands.ts` | Reduce primary Plan destinations to Board and Calendar |
| IPC | `ui/src/ipc/api.ts`, `types.ts`, `mock.ts`; `src-tauri/src/lib.rs` | Add typed planner operations and change events |
| Core orchestration | `crates/mosaic-core/src/api.rs::Workspace` | Own the planner store and expose business operations |
| File history | `crates/mosaic-core/src/history.rs` | Keep for files; planner gets a separate domain activity log |
| Per-vault settings | `preferences.rs`, app `settings.json` | Keep display/configuration choices outside planner content |
| Vault watching/index | `vault.rs`, `watch.rs`, `index.rs` | Hidden planner internals remain excluded from notes and search |

## Target architecture

### Per-vault planner store

Store planner content in `<vault>/.mosaic/planner.sqlite3`.

- `.mosaic/` is app-owned user data inside the vault, hidden from the file tree, search index, note
  links and generic vault/agent file operations.
- The database travels when the vault folder is copied. External connection secrets and overlay caches
  do not.
- Use `rusqlite`, schema migrations, foreign keys, full synchronous transactions and rollback-journal
  mode. Avoid WAL for this store so an idle copied vault has one authoritative database file.
- Run an integrity check when opening. Before every schema migration, create
  `.mosaic/planner-backup.sqlite3` using SQLite's backup API and keep the last valid backup.
- Every mutation is one transaction that updates the object, appends activity rows and increments a
  monotonic store revision. Mutating APIs take the expected object revision and return `Conflict` when
  stale.
- Use stable UUIDs generated in the core. Display order uses explicit sortable position values; never
  derive identity or order from titles.
- The generic `Vault` path API continues to reject hidden paths. A dedicated `PlannerStore` resolves
  only the fixed database location below the already-canonical vault root.

Suggested tables:

- `planner_meta(schema_version, revision, created_at, updated_at)`
- `epics(id, title, description, color, state, position, revision, created_at, updated_at, archived_at)`
- `tasks(id, epic_id, parent_id, title, description, status, due_date, estimate_minutes, position,
  revision, created_at, updated_at, completed_at, archived_at, trashed_at)`
- `work_sessions(id, task_id, start_utc, end_utc, timezone, state, revision, created_at, updated_at)`
- `events(id, series_id, title, description, location, meeting_url, participants_json, epic_id,
  color, all_day, start_value, end_value, timezone, recurrence_rule, revision, created_at, updated_at,
  archived_at, trashed_at)`
- `event_exceptions(series_id, occurrence_key, action, replacement_event_id)`
- `note_links(owner_kind, owner_id, path, heading, block_id)`
- `activity(id, entity_kind, entity_id, occurred_at, action, summary, before_json, after_json)`
- `legacy_imports(source_path, block_id, source_fingerprint, imported_task_id, imported_at)`
- `event_imports(source_kind, source_uid, recurrence_id, imported_event_id, imported_at)`

All instants are stored in UTC plus an IANA time-zone identifier. All-day dates stay ISO calendar dates
without UTC conversion. Recurring events retain their originating time zone so a 09:00 occurrence stays
at 09:00 across daylight-saving transitions.

### Core modules

Add a focused planner module rather than extending Markdown task parsing:

```
crates/mosaic-core/src/planner/
  mod.rs          public models and PlannerStore facade
  schema.rs       migrations and integrity/recovery
  epics.rs        epic ordering and lifecycle
  tasks.rs        task/subtask invariants and completion behavior
  calendar.rs     sessions, local events, range expansion and overlaps
  recurrence.rs   supported recurrence subset and exceptions
  migration.rs    Markdown scan, preview and import
  ical.rs         iCalendar parsing, normalization and export
```

`Workspace` owns a `Mutex<PlannerStore>` opened beside the vault. Business rules live in core methods;
Tauri and the UI only transport typed requests and render results.

### Core API surface

Keep operations narrow and explicit. Exact Rust names may change, but the behavior should cover:

- Planner summary and revision.
- List/create/update/archive/restore/trash epics.
- List/create/update/move/complete/reopen/archive/restore/trash tasks.
- Add/promote/reorder subtasks with cycle prevention.
- List/create/move/resize/cancel work sessions.
- Calendar range query returning expanded local occurrences, work sessions, due markers and locally
  cached overlay occurrences.
- List/create/update/archive/trash local events and edit/delete one recurring occurrence or its series.
- Activity timeline per object.
- Markdown migration scan, preview and atomic import.
- iCalendar preview/import/export.

Emit a planner-changed event carrying the store revision and affected IDs after a committed mutation.
Views reload only the relevant range or entities and ignore events from a vault that is no longer open.

### Tauri and UI structure

Add thin commands in `src-tauri/src/lib.rs` and typed wrappers in `ui/src/ipc/api.ts`. Mirror every type
and operation in `ui/src/ipc/mock.ts` so Board, Calendar and migration can be exercised in a browser.

Suggested UI components:

```
ui/src/views/planner/
  BoardView.tsx
  BoardSwimlane.tsx
  TaskCard.tsx
  TaskEditor.tsx
  CalendarView.tsx
  MonthView.tsx
  WeekView.tsx
  DayView.tsx
  UnscheduledTray.tsx
  EventEditor.tsx
  MigrationWizard.tsx
  plannerModel.ts
  recurrence.ts
```

Keep date expansion and domain validation in Rust. TypeScript helpers should be presentation-only.

## Interaction specification

### Board

- The toolbar contains New task, New epic, search and filters.
- Rows are epics; columns are New, Blocked, In progress, In QA and Done. Unassigned is a permanent
  final row.
- An epic row is collapsible and uses its color as an accent, not as the only identifier.
- Dragging a card horizontally changes status. Dragging it vertically changes epic and order. Every
  drag action has an equivalent menu and keyboard action.
- A parent card shows subtask progress and expands in place. Subtasks retain their own status and can
  be scheduled independently. Promotion turns a subtask into a top-level task after confirmation.
- Selecting a card opens a task editor in the contextual right panel. Edits save explicitly; stale
  revisions show a conflict and reload option.
- Completing a parent with incomplete subtasks prompts before proceeding.

### Calendar

- Toolbar: Today, previous/next, Month/Week/Day, visible-calendar chooser, New event and Refresh.
- Week is the default planning view. It has an all-day row and a scrollable time grid.
- The unscheduled tray sits beside Week/Day and collapses in compact layouts. It filters by epic and
  search. Dragging a task to the grid creates a one-hour work session; dragging to the all-day row
  creates an all-day session.
- Month shows all-day items, due markers, first timed items and a workload indicator; selecting a day
  opens Day view rather than a daily note.
- Empty-grid click creates an event; dragging an empty time range creates an event with that duration.
- Sessions can be moved and resized. Moving one session never moves the task's other sessions.
- Overlaps are allowed and rendered side by side. Mosaic may warn about a conflict but never refuses it.
- Due dates appear as deadline markers, not work sessions.
- Read-only overlay events display a lock/source indicator and cannot open editable controls.
- Local events can inherit an epic color or use their own. Work sessions always inherit the task's epic
  color. Status/read-only/completion also use text, icons or patterns.

### Completion and session semantics

- A work session is planned or cancelled; the passage of time does not complete it or its task.
- Completing a task with future sessions offers: cancel the future sessions (default) or keep them.
- Cancelled sessions leave the active calendar but remain in activity history. Past sessions remain
  visible in history and optional historical calendar display.
- Reopening a task does not recreate cancelled sessions.

### Local recurrence

- Initial rules: daily, weekdays, weekly and monthly, with interval and optional end date.
- Use the RFC 5545 recurrence representation internally, constrained to the supported UI subset.
- Editing or deleting a generated occurrence asks: This occurrence or Entire series.
- “This and following” and arbitrary advanced recurrence rules are deferred.

## Existing Markdown task transition

The update itself performs no migration.

1. If the planner is empty and visible Markdown tasks exist, Board and Calendar show onboarding with
   Start empty, Preview import and Later.
2. The wizard scans through the existing index and groups candidates by note. Open tasks are selected
   by default; done, moved and cancelled tasks are optional.
3. Preview shows the exact epic (initially Unassigned), hierarchy, status, due date, planned session and
   source link that will be created. Nothing is written yet.
4. Confirm performs one database transaction. A failure imports nothing.
5. Original Markdown is never edited. Imported planner objects link to the source note/block.
6. `legacy_imports` prevents the same source block/fingerprint from being imported twice. The person can
   explicitly duplicate an item after a warning.

Mapping:

- Unchecked checkbox -> New task.
- Mosaic workflow annotation -> matching planner status.
- Checked checkbox -> Done when selected for import.
- Nested checkbox -> subtask hierarchy.
- `📅 YYYY-MM-DD` -> due date.
- Task in a recognized dated daily note -> all-day work session on that date.
- Moved/cancelled -> excluded by default; optional archived import.
- Each timeline starts with Imported from Markdown. Earlier history is not invented.

After migration, Markdown checkboxes and planner tasks are independent. Legacy `task:` queries,
`tasks_by_day`, `carry_over`, CLI and MCP behavior remain supported and clearly described as note-task
features. The new Plan UI never silently mixes them with planner objects.

## External calendar boundary

### Initial sources

- One-time import: a local `.ics` file selected through the native file dialog, or selected occurrences
  from an already configured overlay.
- Read-only overlay: an explicitly configured `https://` or `webcal://` iCalendar subscription URL.
- Google/Outlook OAuth and direct Apple Calendar/EventKit integration are deferred. Their private
  iCalendar subscription URLs work when the provider offers them.

### Local connection state

- Store subscription URLs and credentials in the macOS Keychain, keyed by a generated connection ID.
- Store non-secret per-vault connection metadata—connection ID, name, color, visibility and refresh
  interval—in app `settings.json`, not in the vault.
- Cache normalized external occurrences under the existing per-vault cache directory. The cache is
  disposable and never copied with the vault.

### Fetch and refresh

- Fetch in Rust, not the webview. Only user-configured HTTPS subscriptions are allowed; normalize
  `webcal://` to HTTPS.
- Initial limits: 15-second timeout, five redirects, 10 MB response cap and a descriptive parser error.
- Use ETag and Last-Modified validators. Refresh on vault open, every five minutes while open, when the
  app regains focus after inactivity, and on manual Refresh.
- Keep the last successful cache on failure and show last-success time plus a non-blocking warning.
- External updates and deletions replace the normalized overlay cache. Mosaic never sends requests that
  modify the source.

## Milestones

Each milestone is a reviewable batch merged into `dev` only after its own checks pass.

### M34 — Store, domain and migration preview

- Add planner database, migrations, integrity/recovery and core models.
- Implement epics, tasks, subtasks, status, due dates, estimates, sessions, activity and lifecycle.
- Implement Markdown scan/preview/import with duplicate protection and no source-file edits.
- Add Rust tests for schema upgrade, transaction rollback, stale revisions, hierarchy cycles, copy/open,
  migration mapping and duplicate import.

Acceptance:

- Copying a closed test vault preserves all planner content and history.
- A failed mutation or migration leaves no partial objects or activity rows.
- Importing the same preview twice creates no duplicates.
- Existing Markdown files are byte-for-byte unchanged.

### M35 — Board and transition UI

- Replace the current task-board data source with planner APIs.
- Implement epic swimlanes, Unassigned, five columns, nested subtasks, colors, filters and task editor.
- Add onboarding and migration wizard.
- Reduce Plan navigation to Board and Calendar while retaining legacy note-task commands outside the
  primary Plan navigation.

Acceptance:

- Pointer, menu and keyboard operations produce the same status/epic/order changes.
- Parent completion warns when subtasks remain open.
- Compact layouts do not hide core controls or introduce horizontal page overflow beyond the board.
- Browser mock and native smoke tests cover create, edit, move, complete, archive, restore and import.

### M36 — Local calendar

- Replace the current daily-note calendar UI with planner range APIs.
- Implement Month/Week/Day, all-day row, unscheduled tray, due markers and overlapping layout.
- Implement multiple sessions, drag/create/move/resize, estimates and workload display.
- Implement local timed/all-day events, recurrence, exceptions and event editor.

Acceptance:

- One task can display and independently move multiple sessions.
- Due-only and unscheduled tasks appear in the correct surfaces.
- DST tests keep recurring wall-clock time stable and all-day dates unchanged.
- Overlapping events render side by side and remain keyboard reachable.
- Task completion applies the selected future-session behavior and records it in history.

### M37 — Import, export and read-only overlays

- Implement `.ics` preview/import/export with UID/recurrence duplicate detection.
- Add Keychain-backed iCalendar subscriptions, per-vault metadata and disposable cache.
- Implement automatic/manual refresh, conditional requests, offline fallback and visibility controls.

Acceptance:

- Overlay updates and deletions appear after refresh; no outbound modifying request exists.
- Offline restart shows the last successful cache and its age.
- Re-import detects duplicates and lets the person intentionally duplicate only after warning.
- Secrets do not appear in the vault, logs, exported planner data or UI error text.
- Malformed, oversized, slow and redirecting feeds fail safely without losing the prior cache.

### M38 — Recovery, compatibility and release gate

- Finish activity timeline, archive/Trash/restore, JSON/CSV planner export and calendar export.
- Add large-plan performance checks, accessibility pass and migration/upgrade acceptance matrix.
- Update README, AGENTS, CLI/MCP descriptions and user-facing changelog.
- Run `scripts/check.sh`, production UI build, universal native build and browser/native acceptance.

Acceptance:

- Existing note-task queries, days and carry-over tests remain green.
- Planner recovery from its last backup is explicit and never silently discards a healthy database.
- A representative plan with 10,000 tasks and a busy month remains responsive within agreed benchmark
  thresholds established before optimization.
- An upgrade from 0.18.1 opens without changing any Markdown tasks and offers the migration preview.

## Test matrix

- **Rust unit/integration:** schema, CRUD invariants, revisions, history, hierarchy, range expansion,
  recurrence/DST, import/export, migration and fetch/cache boundaries.
- **Tauri command tests:** thin serialization/error mapping, vault-switch isolation and planner events.
- **Vitest:** board grouping/order, calendar layout calculations, colors/non-color indicators, editor state,
  onboarding and conflict handling.
- **Browser mock:** complete Board/Calendar/import journeys and compact/light/dark states.
- **Native:** drag/drop/resize, file dialog, Keychain, background refresh, offline cache and vault copying.
- **Regression:** every current Markdown task, query, calendar-days, carry-over, history and permission test.

## Explicitly deferred

- Two-way calendar synchronization, OAuth providers and EventKit integration.
- Invitations, responses, accounts, assignees and collaboration.
- Custom workflow columns.
- “This and following” recurrence editing and arbitrary advanced recurrence UI.
- Automatic conversion or continuous synchronization of Markdown tasks.
- Planner mutation by CLI/MCP agents. Existing Markdown task tools remain supported; planner-agent
  permissions need a separate product decision before write tools are exposed.

