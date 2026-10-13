# Planner and calendar release acceptance

This is the M34–M38 release matrix for the independent planner introduced after Mosaic 0.18.1.
Automated rows are release-blocking. Manual rows must be repeated on a universal macOS build before
publishing; a browser mock is useful evidence, but does not replace native file dialogs or Keychain.

## Compatibility and recovery

| Scenario | Expected result | Evidence |
|---|---|---|
| Open a representative 0.18.1 vault | The vault opens, the planner is empty, and a Markdown-task migration preview is available | `opening_a_pre_planner_vault_and_previewing_migration_never_changes_markdown` |
| Preview or decline Markdown migration | Every Markdown file remains byte-for-byte unchanged | Core migration and upgrade tests |
| Import the same preview twice | The second import reports duplicates and creates nothing | `markdown_import_previews_maps_and_deduplicates_without_editing_notes` |
| Open a corrupt planner database | Opening fails; no database is silently replaced | `recovery_from_the_last_valid_backup_is_explicit` |
| Confirm planner recovery | The last valid backup becomes active, the damaged database is retained as `planner-corrupt-<timestamp>.sqlite3`, and Markdown is untouched | Core recovery test plus native confirmation flow |
| Copy a closed vault | Planner objects and activity history travel with the copy | `a_closed_vault_copy_keeps_planner_content_and_history` |
| CLI/MCP note-task workflows | `query task:…`, `days` and `carry-over` retain their pre-planner behavior | Full Rust regression suite |

## Performance budgets

Budgets are deliberately broad enough for a supported Intel Mac in a debug test run and strict enough
to catch accidental quadratic queries.

| Workload | Budget | Test |
|---|---:|---|
| Group 10,000 board tasks into 100 epic swimlanes | under 1 second | `ui/src/views/planner/plannerModel.test.ts` |
| Load a 31-day range containing 10,000 due/unscheduled tasks and 1,000 local events | under 5 seconds | `ten_thousand_tasks_and_a_busy_month_load_within_the_acceptance_budget` |

## Accessibility and interaction

- Board cards are keyboard-focusable; Enter or Space opens the task editor. Native selects expose
  status, epic and lifecycle filters with labels.
- Month cells use grid/gridcell semantics and Enter or Space selects a date. Event and overlay items
  are buttons rather than nested interactive content.
- Read-only subscription occurrences have a visible source/lock treatment and remain keyboard
  reachable. Copying one creates a new local event; it never changes the source feed.
- Archive and Trash are named views with explicit restore controls. Historical editors disable normal
  mutation fields while keeping history and restore actions available.
- Status is never conveyed only by epic color: labels, lifecycle text, task state and event source are
  present in text.
- Dialogs have accessible names, labelled close buttons and in-app confirmations for destructive or
  recovery actions.

## Release commands

Run from the repository root:

```sh
scripts/check.sh
pnpm --dir ui build
scripts/install.sh --universal
```

Then verify Board, Calendar, `.ics` open/save dialogs, Keychain subscription persistence, manual and
automatic refresh, offline cache fallback, drag/drop/resize, archive/Trash/restore, JSON/CSV export,
planner recovery and a closed-vault Finder copy in the installed universal app.

## Verification record — 2026-10-13

- Rust formatting and strict workspace clippy passed.
- The workspace suite passed with 101 core tests plus all app, CLI, MCP and preference tests after
  excluding the two existing GUI-sandbox cases: Finder Trash automation and filesystem watcher events.
- All 40 UI test files passed (165 tests), including the 10,000-task grouping budget; TypeScript lint
  and the production Vite build passed.
- Browser-mock acceptance covered task history, Archive → Trash → restore, disabled historical edit
  fields, Board JSON/CSV controls, local-event archive, and keyboard-visible read-only overlays.
- `scripts/install.sh --universal --build-only` produced an ad-hoc-signed 104.79 MiB `Mosaic.app`.
  Both the app and bundled CLI were verified as arm64+x86_64 Mach-O universal binaries, and strict
  deep signature verification passed.
