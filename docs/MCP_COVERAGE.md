# MCP coverage

Goal: everything a person can do or set in Mosaic can also be done through MCP (`mosaic mcp`), so an
AI can work with the whole app, including the planner and the calendar. A short list of actions stays
the person's own (see [Exclusions](#exclusions)).

This file is the contract. Its [inventory](#inventory) maps every Tauri command to an MCP tool, a
planned slice, or an exclusion, and is the one list the guard test reads
(`tauri_commands_are_covered_by_mcp` in `crates/mosaic-cli/tests/mcp.rs`). Adding a Tauri command
without a row here, or naming a tool that does not exist, fails the test.

## Conventions

These follow the existing ~45 tools in `crates/mosaic-cli/src/mcp.rs`.

**Names.** The tool name is the Rust fn name: `snake_case`, verb first, then the object
(`list_files`, `create_planner_task`). Verbs in use:

| Verb | Meaning | Examples |
|---|---|---|
| `list_` | Several items, optionally filtered | `list_files`, `list_planner_tasks`, `list_bookmarks` |
| `get_` | One item, or one computed answer | `get_planner_task`, `get_backlinks`, `get_vault_preferences` |
| `create_` / `add_` | New item; never overwrites (`add_` for entries in an existing list) | `create_note`, `create_planner_task`, `add_bookmark` |
| `update_` / `edit_` / `patch_` / `append_to_` | Change an existing item | `update_planner_task`, `edit_file`, `patch_file` |
| `move_`, `complete_`, `reopen_`, `archive_`, `restore_`, `trash_`, `remove_` | One lifecycle step each | `move_planner_task`, `archive_planner_task` |
| `set_` | Replace a setting or a flag | `set_vault_preferences`, `set_template_config` (planned: `set_task`) |

Objects the app owns in its planner database carry a `planner_` infix (`list_planner_epics`), which
keeps them apart from Markdown tools: `tasks_by_day` and `carry_over` work on Markdown checkboxes,
`*_planner_task` on Board tasks. Calendar tools follow the same pattern (`list_planner_events`,
`create_planner_event`). Older names that break these rules (`rename`, `delete_file` moving to the
Trash, `restore_version`) stay as they are; renaming a tool breaks every agent that uses it.

**Granularity.** One tool per user-level action, matching a core function, not one per UI button and
never a generic "call any command" tool. A tool does one lifecycle step (`archive_` and `trash_` are
separate, as in the app) so its description can say exactly what changes and the person can read the
agent's history. Reads that the UI combines (list plus details) may be one tool when the result stays
small; otherwise add a `get_` beside the `list_`.

**Arguments.** Input structs derive `Deserialize` + `JsonSchema`; field doc comments are the schema
descriptions. Paths are vault-relative strings. Planner ids are UUID strings. Proposal and version ids
are integers. Dates are `YYYY-MM-DD`, times RFC 3339. Writes take the concurrency token from the read
that preceded them: `expected_hash` for files, `expected_revision` for planner objects and for
settings (a string: the hash of the stored setting, returned as `revision` by its `get_`), so an
agent never overwrites a newer human edit.

**Results.** Pretty JSON in one text block (`ok()`); errors are `{code, message}` with `isError`
(`err()`). Writes that become proposals say so in the result (`REVIEW_NOTE`). Images are image blocks
(`render`). A tool returns data; it never writes outside the vault. Where the app writes a file the
person chose in a save dialog (`*_export_file`), the MCP tool returns the content instead.

**Placement.** The logic lives in `mosaic-core`; the Tauri command and the MCP tool are both thin
wrappers over it. `mosaic-cli` must not depend on `src-tauri`, so a feature whose logic is still in
`src-tauri` moves into core before it gets MCP tools. Calendar subscriptions (M4a,
`mosaic_core::calendar_subscriptions`) and the Tessera control (M7a, `mosaic_core::tessera`) already
moved.

## Writes and `--may-change`

No tool *needs* `--may-change`. It is not a permission an agent requests; it is a hidden, repeatable
flag Mosaic passes to scheduled agents (`mosaic --may-change Daily --may-change Reviews mcp`) that
**narrows** where they may write directly. Every MCP request runs as `Source::Agent`, and core decides
per write:

| Class | Tools | Without `--may-change` | With `--may-change` |
|---|---|---|---|
| Read | `list_*`, `get_*` (including `get_tessera_status`), `preview_ical_import`, `export_ical`, `export_planner`, `read_file`, `read_version`, `outline`, `search`, `query`, `tasks_by_day`, `render`, `render_template`, `file_history`, `planner_task_history`, `vault_guide` | Allowed, minus hidden folders | Same |
| Vault file write | `create_file`, `create_note`, `edit_file`, `patch_file`, `append_to_file`, `rename`, `move_files`, `copy_file`, `delete_file`, `create_folder`, `import_file`, `restore_version`, `carry_over`, `set_task`, `set_task_workflow`, `link_mention`, `fix_links`, `undo_change` | Direct, unless the folder is read-only (refused) or in review (becomes a proposal) | Direct only inside the listed paths; elsewhere a proposal |
| Derived index | `rebuild_index` | Direct | Direct (no scope) |
| App-state write, scope `planner:` | `*_planner_task`, `*_planner_event`, `*_planner_event_occurrence`, `*_planner_work_session`, `*_planner_epic`, `import_ical` | Direct | **Refused** (`denied`) unless `planner:` is listed; then direct |
| App-state write, scope `bookmarks:` | `add_bookmark`, `remove_bookmark` | Direct | **Refused** unless `bookmarks:` is listed; then direct |
| App-state write, scope `subscriptions:` | `add_calendar_subscription`, `update_calendar_subscription`, `remove_calendar_subscription`, `refresh_calendar_subscriptions` | Direct | **Refused** unless `subscriptions:` is listed; then direct |
| App-state write, scope `settings:` | `set_vault_preferences`, `set_template_config` | Direct | **Refused** unless `settings:` is listed; then direct |
| App-state write, scope `agents:` | `pause_agents`, `resume_agents`, `pause_agent`, `resume_agent`, `run_agent` | Direct | **Refused** unless `agents:` is listed; then direct. Never given to a scheduled workflow (see M7b) |
| Own proposals | `withdraw_proposal` | Any visible pending proposal | Only proposals this server session made or updated |

**Derived index.** `rebuild_index` writes only the search index, a cache rebuilt from the vault's
files, not notes and not data the person owns. The server already writes the same index whenever an
index-backed tool syncs it, so a rebuild needs no scope and is allowed under `--may-change`. It rebuilds
in batches and keeps the last consistent index while it runs, so the app's searches never see it empty.
It re-reads every file, so it is slow in a large vault, but it changes nothing the person sees.

**Undo and link repair are writes.** `undo_change` restores, deletes or renames through the same
core calls as `restore_version`, `delete_file` and `rename`, so an agent's undo outside its allowlist
or in a reviewed folder becomes a proposal (`review` in the result). When the person accepts it, the
original change is not marked `undone`; it is a separate change. `fix_links` run by an agent writes
each note through the normal path too (the app's own Fix links writes directly, as a rename does):
`proposed_links_in` lists the notes waiting for review, and the move stays unfinished until they are
accepted and `fix_links` runs again. Running it again updates the same proposals. Notes hidden from
agents are reported without their names.

**Known gap (not M6).** An agent's `rename` refuses when a note whose links it would rewrite is under
a folder rule, but it does not check `--may-change` for those notes: a restricted agent renaming a file
inside its folders rewrites links in notes outside them directly. A follow-up can reuse `fix_links`'s
guarded rewrite.

**Scopes.** An allowlist entry ending in `:` names app data instead of a folder: `planner:` (the
whole planner database: Board tasks and epics, calendar events, work sessions, iCal imports),
`bookmarks:`, `subscriptions:` (calendar subscriptions: their metadata, Keychain URLs and cached
feeds; a refresh counts, since it rewrites the cache and each feed's status), `settings:` (the
vault's preferences, folder colors included, and template defaults in settings.json; never the
folder rules for agents, which no tool changes) and `agents:` (Tessera control: pauses and run requests). Scopes are case-insensitive; an unknown one grants nothing (the CLI warns on stderr).
App data can't be proposed for review, so under an allowlist the safe default is to refuse, not to
write. The refusal's message names the scope and tells the agent not to retry and to tell the person
instead. Scheduled agents always run with an allowlist (an agent with no `may-change` gets a marker
that allows no folders), so they never change app data unless the person opts in: the workflow
form's "Can change Board and calendar" switch writes `planner:` into the agent's `may-change`
(`- "planner:"`; an unquoted `- planner:` is read the same way). There is no switch for
`subscriptions:`: the person writes it into the agent's `may-change` by hand (the form keeps it).
See [M4](#slices) for why. Nor is there one for
`settings:`: changing vault settings is something a person asks for in a conversation (an
interactive client has no allowlist), not a job for a schedule. A person who wants a workflow to do
it writes `- "settings:"` in its `may-change`; the front matter, the workflow form (which keeps
scopes it has no switch for) and the app's pass-through to `--may-change` all carry it.

**Where it is enforced.** In core, so the CLI and every MCP tool get it without extra code:
`Workspace::with_change_allowlist` parses the scopes, `Context::check_app_write(AppScope::…)` refuses,
calendar subscription writes go through `CalendarSubscriptions::for_workspace` (which checks
`AppScope::Subscriptions` before the Keychain, the network or any file), and every `PlannerService` write goes through `write_store()`, which refuses before touching the
database (the test `every_planner_write_goes_through_write_store` fails if a new planner write uses
`store()`). The MCP server keeps its `--may-change` list and applies it to every workspace it opens
(at startup, on the lazy first open, and on each follow-mode switch); a front end that opens a vault
for an agent must do the same.

**Rule for new slices.**

- A tool that writes vault files goes through the same core path (`in_review`), so folder rules,
  review and the allowlist apply without extra code.
- A tool that writes app state calls a core function that is guarded: planner writes go through
  `write_store()`; any other store calls `check_app_write` with its scope before changing anything.
  App data with no scope yet gets a new `AppScope` (one per store, e.g. `settings:` for M5) and a row
  in the table above. Never let an app-state write through under an allowlist without a scope.
- Its description says it is applied directly, never reviewed, and refused without its scope.
- Its tests cover the refusal under `--may-change` (see
  `app_state_writes_need_their_scope_under_may_change`).

## Exclusions

**Hard exclusions.** These stay out of MCP whatever later slices do; the guard test checks them.

- `accept_proposal`, `reject_proposal`: an agent would be approving its own work. Core already refuses
  them for agents (`person_only`). Agents see outcomes with `list_proposals` and may withdraw their
  own with `withdraw_proposal`.
- `set_agent_rules`: an agent would be changing its own folder permissions. Agents read them with
  `get_agent_rules`, which leaves out rules on or inside hidden folders (it only counts them) so
  their names don't leak.
- `tessera_set_max_chain_depth`: the limit on agents triggering agents is a permission too; an agent
  could raise its own runaway limit.

**Other exclusions**, by reason:

- *The MCP server is bound to one vault* (`--vault`, or the app's current vault): opening, creating,
  forgetting or switching vaults is the person's choice.
- *Writes outside the vault*: `planner_export_file`, `planner_ical_export_file` (the data is planned
  as returned content); `install_cli`.
- *Not undoable*: `planner_restore_backup` replaces the whole planner database.
- *The person's review screen*: `proposal_content`, `proposal_base`.
- *App or window plumbing*: printing, opening in another app, host paths, asset URLs, HTML preview,
  updates, the CLI installer, setting up and testing AI clients (Connections).
- *Chat*: the in-app chat is itself an AI client; an agent talking to it over MCP has no use.
- *Agent skill mirror*: `mirror_agents` rewrites the `.claude/skills` an agent is loaded with; the app
  runs it.
- *Test harness*: `native_smoke::*`, only in the `native-smoke` build.

## Slices

In this order (the numbering is the roadmap's, not the order). Each slice adds its tools, moves the
rows below from `planned` to the tool names, adds tests, and updates the README list.

1. **M2 Calendar (done).** Events (list, create, update, archive, restore, trash), recurring
   occurrences (cancel, replace), work sessions (list, create, update, cancel), the calendar range,
   and iCal (preview, import, export as text).
2. **M3 Planner rest (done).** Summary, activity feed, epic writes (create, update, archive, restore,
   trash), and export (backup content as returned JSON/CSV, paged).
3. **M5 Settings (done).** `set_vault_preferences`, `get_template_config`, `set_template_config`,
   `list_template_starters` and `get_agent_rules` (read only), under the `settings:` scope. Core:
   `Workspace::revised_vault_preferences`, `change_vault_preferences`, `revised_template_config`,
   `change_template_config` and `agent_rules_view`; the app keeps its own `set_vault_preferences` and
   `set_template_config`, which refuse every other source.
   - **Preferences agents can't set** (`preferences::AGENT_PREFERENCES` lists those they can):
     `agents_folder`, because scheduled agents and their `may-change` are read from it, so an agent
     that moved it to a folder it may write could grant itself permissions; `allow_html_scripts` and
     `allow_html_internet`, the HTML preview sandbox's security; `version` and `legacy_migrated`,
     bookkeeping; and keys a newer Mosaic wrote.
   - **Folder colors** are merged per folder (`null` removes one), so an agent never needs, or
     erases, colors of folders hidden from it; reads leave those out.
   - **Path preferences** (the daily, new-note and attachment folders, daily template, startup
     note, agents folder) that name a path hidden from the agent read as blank and are listed in
     the result's `hidden`, so hidden folders' names don't leak.
   - **Template rules** for folders or templates hidden from the agent are left out of
     `get_template_config` (`hidden` lists `rules`) and kept by `set_template_config`, which then
     refuses to move the templates folder (those rules' templates live there). When the templates
     folder itself is hidden, both are refused.
   - Paths an agent names that are hidden from it read as `not_found`, like a read.
4. **M6 Links, index and tasks.** Index health and rebuild, Markdown task ticking and workflow state,
   aliases, unlinked mentions and linking them, link repair after interrupted renames, reading an old
   version, AI activity, and `undo_change` (an agent's undo goes through review like any write).
5. **M4 Calendar subscriptions.** M4a moved the subscription logic into core
   (`mosaic_core::calendar_subscriptions`: storage in settings, feed URLs behind a `SecretStore`,
   downloads behind a `FeedFetcher`); the Tauri commands are thin wrappers.
   - **M4b (done)** adds the tools: `list_calendar_subscriptions`, `add_calendar_subscription`,
     `update_calendar_subscription`, `remove_calendar_subscription`,
     `refresh_calendar_subscriptions`, `get_calendar_overlay`.
   - **Same state as the app.** Metadata is in the app's `settings.json`; feeds are cached in
     `calendar_subscriptions::app_cache_dir()` (`calendar-cache` in Application Support's
     `dev.jona.mosaic`, which is Tauri's app data directory for the bundle id); URLs are the same
     Keychain items (service `com.mosaic.calendar-subscription`). Both processes reach the Keychain
     through `/usr/bin/security`, so each reads the other's items. Every operation re-reads the
     settings and writes them under the cross-process `settings.lock`; a refresh commits only if the
     subscription's revision is unchanged. The app's calendar shows MCP changes when it next reloads
     (focus, or every 5 minutes); there is no push to the UI.
   - **No URL comes out.** `SubscriptionView` and `OverlayRange` have no URL field; core's errors
     never quote it. `update_calendar_subscription` is a partial update (`CalendarSubscriptions::patch`),
     merged under one settings lock.
   - **Decision: agents may pass a feed URL.** Adding a feed means the agent sends one. It only
     goes to the `SecretStore` (Keychain) and to the `FeedFetcher`, with the app's rules: HTTPS or
     webcal only, an HTTPS-only client, 15 s timeout, 10 MB cap. The link is in the agent's context
     anyway (the person gave it); the tool descriptions say to add one only when asked.
   - **Decision: no scheduled-agent switch for `subscriptions:`.** Unattended feed management means
     Keychain writes and downloads from agent-chosen URLs, and the app already refreshes feeds on its
     own while open, so a scheduled run gains little. A person who wants it writes `subscriptions:`
     into the agent's `may-change`; the workflow form keeps unknown scopes when it saves.
   - **macOS only.** The tools use core's `Keychain`, so elsewhere they fail exactly as the app does
     (`calendar subscriptions currently require macOS Keychain`); listing and the overlay still
     work.
6. **M7 Tessera.** Status, run an agent, test an event, pause all or one. An MCP-started run must
   count as a chained run, so the chain-depth limit applies to it.
   - **M7a (done)** moved the control into core, in `mosaic_core::tessera`. The scheduler still runs
     inside the app, so another process works through the vault's state folder, under its
     cross-process lock:
     - `stored_status` and `scheduler_active` read the status;
     - `pause_all` and `pause_agent` write the pauses straight to `tessera-state.json`;
     - `request_run` appends to `tessera-requests.json`.

     The app polls every 2 s (`POLL`). It takes the requests into its event queue as
     `RunCause::Requested`, where they wait while paused and are checked against the chain-depth limit
     again. A request not taken within 10 minutes (the app was closed or on another vault) is
     recorded as skipped, not run. It also starts what a resume from another process lets run.
   - **Chain rule.** A requested run continues the chain of the workflow run that asked for it, one
     step deeper. The app passes that run's id to its `mosaic mcp` server in `MOSAIC_TESSERA_RUN`
     (`parent_run_from_env`). Without it, the requested run starts a chain at depth 1. `request_run`
     refuses a run past the limit, and refuses an unknown parent run. There is no core setter for
     the limit.
   - **M7b (done)** added `get_tessera_status`, `pause_agents`, `resume_agents`, `pause_agent`,
     `resume_agent` and `run_agent`.
     - `run_agent` takes `parent_run` only from `MOSAIC_TESSERA_RUN` (a value that isn't a run id is
       refused), never from an argument, so an agent can't reset its own depth. Past the limit it is
       refused with the depth and the maximum.
     - The writes are guarded in core by `AppScope::Agents` (`agents:`): `pause_all`, `pause_agent`
       and `request_run` call `check_app_write` first.
     - **Scheduled agents never control Tessera.** No workflow needs it: chaining already works
       through `on` events (a run creates the note another workflow watches for), under the same
       limit, and pausing or resuming the person's workflows is the worst outcome of a run misled by
       the content it reads. So there is no form switch, and the app drops `agents:` from a
       workflow's `may-change` even when its front matter names it (`tessera::workflow_may_change`).
       The refusal tells the agent to ask the person, not to add the scope. `agents:` is for a client
       the person restricts by hand; unrestricted clients the person drives use the tools directly.
       `MOSAIC_TESSERA_RUN` and the chain rule stay as defence in depth.
     - `tessera_test_event` is not a tool: it is not a dry run. The app matches a note against the
       workflow's `created in` events and starts a run at once, outside the queue, the pauses and the
       chain-depth limit (a new chain at depth 0). Core has only the matcher, and putting the test
       through `request_run` would change what it does. An agent gets the real effect, under the
       limit, by creating the matching note, or with `run_agent`.

## Inventory

Every Tauri command, from `collect_commands!` and `generate_handler!` in `src-tauri/src/lib.rs`. The
MCP column is one of: the tool(s) that cover it, `planned (M<n>)`, or `excluded (<reason>)`. Planned
names in Notes are proposals for the slice, not commitments.

<!-- inventory:start -->
| Tauri command | MCP | Notes |
|---|---|---|
| `open_vault` | excluded (vault scope: the server is bound to one vault) | |
| `index_health` | `get_index_health` | this server's own index state, plus whether the app's watcher keeps it current |
| `rebuild_index` | `rebuild_index` | synchronous in MCP (no watcher); see [Writes](#writes-and---may-change) |
| `query_notes` | `query` | |
| `set_task` | `set_task` | tick a Markdown checkbox by line |
| `set_task_workflow` | `set_task_workflow` | no UI caller yet; takes the `task.workflow` of a `query` row |
| `days` | `tasks_by_day` | |
| `carry_over` | `carry_over` | |
| `planner_summary` | `get_planner_summary` | |
| `planner_activity` | `list_planner_activity` | also the planner-wide feed, newest first and paged; one task's whole history is `planner_task_history` |
| `planner_epics` | `list_planner_epics` | |
| `planner_tasks` | `list_planner_tasks`, `get_planner_task` | |
| `planner_create_epic` | `create_planner_epic` | color defaults to the app's |
| `planner_update_epic` | `update_planner_epic` | fields left out keep their value |
| `planner_archive_epic` | `archive_planner_epic` | |
| `planner_restore_epic` | `restore_planner_epic` | |
| `planner_trash_epic` | `trash_planner_epic` | |
| `planner_create_task` | `create_planner_task` | |
| `planner_update_task` | `update_planner_task` | |
| `planner_move_task` | `move_planner_task` | |
| `planner_complete_task` | `complete_planner_task` | |
| `planner_reopen_task` | `reopen_planner_task` | |
| `planner_archive_task` | `archive_planner_task` | |
| `planner_restore_task` | `restore_planner_task` | |
| `planner_trash_task` | `trash_planner_task` | |
| `planner_work_sessions` | `list_planner_work_sessions` |  |
| `planner_create_work_session` | `create_planner_work_session` |  |
| `planner_update_work_session` | `update_planner_work_session` |  |
| `planner_cancel_work_session` | `cancel_planner_work_session` |  |
| `planner_calendar_range` | `get_planner_calendar` | events expanded, work sessions, due Board tasks; adds `series_revision` |
| `planner_events` | `list_planner_events` |  |
| `planner_create_event` | `create_planner_event` |  |
| `planner_update_event` | `update_planner_event` | fields left out keep their value |
| `planner_archive_event` | `archive_planner_event` |  |
| `planner_restore_event` | `restore_planner_event` |  |
| `planner_trash_event` | `trash_planner_event` |  |
| `planner_cancel_event_occurrence` | `cancel_planner_event_occurrence` |  |
| `planner_replace_event_occurrence` | `replace_planner_event_occurrence` |  |
| `planner_ical_preview` | `preview_ical_import` |  |
| `planner_ical_import` | `import_ical` | takes the `.ics` text and re-runs the preview; source `ics-file`, as in the app |
| `planner_ical_export` | `export_ical` | returns the text |
| `planner_ical_export_file` | excluded (writes a host file chosen in a save dialog; `export_ical` returns the content) | |
| `planner_export` | `export_planner` | returns the JSON or CSV content, in pages with a cursor when large |
| `planner_export_file` | excluded (writes a host file chosen in a save dialog; `export_planner` returns the content) | |
| `planner_restore_backup` | excluded (replaces the whole planner database; not undoable) | |
| `calendar_subscriptions` | `list_calendar_subscriptions` | no URL in any output |
| `add_calendar_subscription` | `add_calendar_subscription` | scope `subscriptions:` |
| `update_calendar_subscription` | `update_calendar_subscription` | partial update; scope `subscriptions:` |
| `remove_calendar_subscription` | `remove_calendar_subscription` | scope `subscriptions:` |
| `refresh_calendar_subscriptions` | `refresh_calendar_subscriptions` | scope `subscriptions:` |
| `calendar_overlay_range` | `get_calendar_overlay` | |
| `agents` | `list_agents` | |
| `mirror_agents` | excluded (rewrites the `.claude/skills` agents are loaded with; the app runs it) | |
| `chat_check` | excluded (in-app chat is itself an AI client) | |
| `chat_send` | excluded (in-app chat is itself an AI client) | |
| `chat_stop` | excluded (in-app chat is itself an AI client) | |
| `tessera_status` | `get_tessera_status` | core: `tessera::stored_status`, `scheduler_active` |
| `tessera_run` | `run_agent` | core: `tessera::request_run`; queued, counts as a chained run |
| `tessera_test_event` | excluded (starts a run outside the queue, pauses and chain limit; agents create the matching note or use `run_agent`) | see M7b |
| `tessera_pause_all` | `pause_agents`, `resume_agents` | core: `tessera::pause_all` |
| `tessera_pause_agent` | `pause_agent`, `resume_agent` | core: `tessera::pause_agent` |
| `tessera_set_max_chain_depth` | excluded (hard: the agent chain limit is a permission) | |
| `proposals` | `list_proposals` | an agent sees its own proposals |
| `proposal_content` | excluded (the person's review diff) | |
| `proposal_base` | excluded (the person's review diff) | |
| `accept_proposal` | excluded (hard: an agent would approve its own work) | |
| `reject_proposal` | excluded (hard: an agent would judge proposals) | |
| `create_vault` | excluded (vault scope: the server is bound to one vault) | |
| `recent_vaults` | excluded (vault scope: the server is bound to one vault) | |
| `forget_vault` | excluded (vault scope: the server is bound to one vault) | |
| `get_bookmarks` | `list_bookmarks` | |
| `set_bookmarks` | `add_bookmark`, `remove_bookmark` | no reorder tool yet |
| `copy_path` | `copy_file` | |
| `current_vault` | excluded (vault scope: the server is bound to one vault) | |
| `last_vault` | excluded (vault scope: the server is bound to one vault) | |
| `list_dir` | `list_files` | |
| `read_file` | `read_file` | |
| `create_file` | `create_file` | |
| `template_config` | `get_template_config` | |
| `vault_preferences` | `get_vault_preferences` | |
| `set_vault_preferences` | `set_vault_preferences` | |
| `set_template_config` | `set_template_config` | |
| `list_templates` | `list_templates` | |
| `render_template` | `render_template` | |
| `create_note` | `create_note` | |
| `template_starters` | `list_template_starters` | |
| `write_file` | `edit_file`, `patch_file`, `append_to_file` | |
| `make_dir` | `create_folder` | |
| `rename_path` | `rename`, `move_files` | |
| `delete_path` | `delete_file` | |
| `file_history` | `file_history` | |
| `unlinked_mentions` | `list_unlinked_mentions` | |
| `print_window` | excluded (window: printing) | |
| `link_mention` | `link_mention` | |
| `get_agent_rules` | `get_agent_rules` | read only; rules in hidden folders are only counted |
| `set_agent_rules` | excluded (hard: an agent would change its own permissions) | |
| `version_content` | `read_version` | |
| `restore_version` | `restore_version` | |
| `ai_activity` | `list_ai_activity` | |
| `undo_change` | `undo_change` | through review, like any vault write |
| `absolute_path` | excluded (host paths; MCP uses vault-relative paths) | |
| `asset_path` | excluded (UI asset URLs) | |
| `open_in_default_app` | excluded (opens an app on the person's desktop) | |
| `drag_out_attach` | excluded (window: native drag of tree items out to Finder) | |
| `drag_out_detach` | excluded (window: native drag of tree items out to Finder) | |
| `drag_out_end` | excluded (window: native drag of tree items out to Finder) | |
| `unfinished_renames` | `list_unfinished_renames` | |
| `fix_links` | `fix_links` | each note through the normal write path for agents |
| `html_preview_document` | excluded (UI rendering; agents use `render`) | |
| `search` | `search` | |
| `backlinks` | `get_backlinks` | |
| `tags` | `list_tags` | |
| `aliases` | `list_aliases` | |
| `outline` | `outline` | |
| `cli_info` | excluded (CLI installer) | |
| `install_cli` | excluded (CLI installer; writes outside the vault) | |
| `ai_setup_status` | excluded (AI client setup: reads Claude's own config files) | |
| `write_claude_desktop_config` | excluded (AI client setup; writes outside the vault) | |
| `test_mcp_connection` | excluded (AI client setup: starts this MCP server to check it) | |
| `update_status` | excluded (app updates) | |
| `check_updates` | excluded (app updates) | |
| `start_update` | excluded (app updates) | |
| `cancel_update` | excluded (app updates) | |
| `finish_update` | excluded (app updates) | |
| `import_file` | `import_file` | raw route in the app |
| `smoke_context` | excluded (native-smoke test harness) | |
| `smoke_external` | excluded (native-smoke test harness) | |
| `smoke_report` | excluded (native-smoke test harness) | |
<!-- inventory:end -->

MCP tools with no Tauri command of their own (the guard test checks that every tool is named in this
file):

<!-- mcp-only:start -->
- `vault_guide`: the agent guide (`docs/AGENTS.md`).
- `planner_task_history`: one task's activity; the app reads it through `planner_activity`.
- `withdraw_proposal`: an agent takes back its own proposal.
- `render`: a PNG of a canvas or SVG, so an agent can check what it drew.
<!-- mcp-only:end -->

## Open questions

- **Themes.** Color themes and other app-wide appearance settings live only in the UI's
  `localStorage` (`mosaic:settings`). No Tauri command or core code sees them, so MCP cannot reach
  them. Covering them means moving them into app settings first. Undecided whether that is worth it.
- **Bookmark order.** `set_bookmarks` can reorder; MCP can only add and remove.
