# Working with a Mosaic vault (guide for AI agents)

A Mosaic vault is a plain folder of files, compatible with Obsidian. Humans read and edit it in the
Mosaic app; you read and edit it through the `mosaic` MCP tools or the `mosaic` CLI. Everything you
write shows up in the app within a second.

## Ground rules

- **Paths are vault-relative** and use `/` (`Projects/Plan.md`). Never absolute, never `..`.
  Hidden folders (`.obsidian/`, `.git/`) are not part of the vault.
- **Read before you change.** `outline` gives a cheap overview (title, headings, links, backlinks);
  `read` returns the full content and its `hash`.
- **Edit surgically.** Prefer `patch` (replace one exact, unique snippet) or `append` over rewriting
  a whole file. Pass the `hash` you read as `expected_hash` so you never overwrite a human's newer
  edits — on a `conflict` error, read again and redo your change.
- **Structured files are checked on write.** A `.canvas`, `.excalidraw`, `.vl.json` or `.json` that
  doesn't parse (or a canvas card missing `id`, `type`, `x`/`y`/`width`/`height` or its `text`/`file`/
  `url`, or an edge pointing to a missing node) is refused with an `invalid` error saying what's wrong;
  nothing is written. Fix the content and try again.
- **Every change is kept.** Mosaic stores a version of each file you change (and shows the human what
  you did, under your client's name, with an Undo). If you overwrite something by mistake, find the
  earlier version with `file_history` and put it back with `restore_version`.
- **Some folders may be off limits.** The person can make folders read-only for you (changes fail with
  `denied`) or hide them (they don't appear anywhere and read as `not_found`). Don't try to work around it;
  tell them if you need access.
- **Some folders are reviewed.** There, your create, edit, patch, append, restore, delete, task, link and undo calls succeed
  but don't change the file: the result has a `review` id (a proposal) and a note saying so. The person
  sees the change as a diff in the app and accepts or rejects it. Until then, your reads of that file show
  your proposal and your next edits build on it, so a multi-step change is reviewed as one. File renames
  and binary additions become proposals too; folder moves are still refused. `list_proposals` shows what's pending and the person's
  decisions (a rejection may carry a reason: read it and adapt; `undone` means they accepted it, then
  undid it, so the file no longer has your change); `withdraw_proposal` takes one back. Tell
  the person what you proposed and why, since they decide.
- **Files in the configured agents folder (default `Agents/`) are agents, not documents.** A note `Agents/Name.md` or a skill folder
  `Agents/Name/SKILL.md` defines an agent the person made: its frontmatter has `name`, `description`
  and, for Mosaic, `schedule`, `on` (for example `created in Daily/`), `model`, `may-change`
  (folders it may write without review, plus `planner:` if its scheduled runs may change Board
  tasks and calendar items, and `subscriptions:` for calendar subscriptions), and `web: true` (its workflow runs may search and fetch
  the web; off by default); the body is its instructions. `on` can be one event or a
  list and may coexist with `schedule`; automatic workflows run only while Mosaic is open. When the
  person points you at one, or names an agent, **act
  as that agent**: follow its instructions for this task. `list_agents` lists them; each is also an MCP
  prompt (in Claude Code: `/mosaic:<name>`), and Mosaic mirrors them into the vault's
  `.claude/skills/`, so Claude Code started in the vault has them as skills. Edit an agent in `Agents/`,
  never its mirror.
- **Vault preferences are shared with CLI/MCP.** Read `get_vault_preferences` (CLI: `mosaic preferences`).
  When the person asks, change them with `set_vault_preferences` (pass only the keys to change and
  the `revision` you read; folder colors use the presets red, orange, green, blue, purple). Template
  defaults work the same way with `get_template_config` and `set_template_config`;
  `list_template_starters` shows the starter templates. The agents folder, HTML preview permissions
  and the folder rules (`get_agent_rules`, read only) stay the person's. A workflow limited to
  certain folders may change these settings only with `settings:` in its `may-change`. Settings may change the agents folder, daily-note
  folder and file-name format without moving files. Discover agents with `list_agents`, not a
  hard-coded `Agents/` listing. Daily formats are `YYYY-MM-DD`, `DD-MM-YYYY` or `YYYYMMDD`; legacy
  ISO daily names remain recognized, while due dates and date placeholders always use ISO. Two
  notes representing the same date are an error to repair, never a reason to overwrite either.
- **Find notes by their properties with `query`** rather than reading many files: see "Queries" below.
- **Planner data is app-owned.** Board tasks, epics, work sessions and local events are separate from
  Markdown checkboxes and live under `.mosaic/`. CLI/MCP `task:` queries, `tasks_by_day` and
  `carry_over` operate only on Markdown tasks. Use the `*_planner_task` tools for Board tasks and
  the `*_planner_epic` tools for their epics; never inspect or edit `.mosaic/planner.sqlite3` directly,
  and do not imply that changing a checkbox changes an independent planner item.
- **Several files at once:** `move_files` moves a list into one folder in a single call; `import_file`
  adds an image or other binary file from base64 (never overwrites).
- **Deleting is safe but visible:** files go to the macOS Trash.
- **Renaming updates links** in every other note automatically (use `rename`, not delete + create).
- **Duplicate with `copy`** (any file, including images); it never overwrites an existing file.
- **Bookmarks** are the human's shortlist in the app's sidebar (`list_bookmarks`, `add_bookmark`,
  `remove_bookmark`). Bookmark something only when asked or when it is clearly the place to look
  next (e.g. a report you just wrote). They follow renames.
- Keep files human-readable: short paragraphs, headings, lists. Don't reformat content you didn't change.

## Note templates

Templates are Markdown files in the vault's configured Templates folder. Folder defaults are
managed by the person in Settings, inherited by subfolders, and shared with the CLI/MCP.
For a new meeting/project note or AI report, call `list_templates` with its destination `path`
to discover the default, then `render_template` to get its structure and filled title/date values.
Honor a template or Blank choice specified by the person. Agent instructions determine how to
investigate; the template determines the report's structure. Fill its sections and save the
completed report with `create_file`; don't prepend another template to completed content.
For an unfilled scaffold, `create_note` uses the folder default unless `template` or `blank` is
specified. Reuse preview `context.timestamp` and `template_hash` as `expected_template_hash`
to refuse changed source templates. Hidden/read-only/review rules and scheduled `may-change`
still apply. Unknown placeholders are preserved; supported ones are `{{title}}`, `{{date}}`,
`{{time}}` and `{{weekday}}`. Existing raw create operations preserve supplied content.

## File types

| Kind | Extension | Notes |
|---|---|---|
| Note | `.md` | Markdown + Obsidian syntax (below). The default for text. |
| Canvas | `.canvas` | JSON Canvas board of cards and arrows (below). |
| Drawing | `.excalidraw` | Excalidraw JSON; prefer a canvas or a Mermaid/Graphviz diagram when you generate visuals. |
| Chart | `.vl.json` | A Vega-Lite spec. |
| Graph | `.dot` | Graphviz DOT source. |
| Data | `.csv`, `.json`, `.yaml` | Shown as tables / highlighted source. |
| Web page | `.html` | Sandboxed preview. Scripts and internet are off by default; the person can set vault defaults or override a page for the current session. |
| Other | images, `.pdf`, code | Images/PDFs can be embedded in notes. |

## Markdown notes

- Frontmatter (optional) at the very top:
  ```yaml
  ---
  tags: [project, mosaic]
  aliases: [Other name]
  status: draft
  ---
  ```
  Keep keys you don't understand exactly as they are.
- Links: `[[Note name]]`, `[[Folder/Note]]` when the name is ambiguous, `[[Note#Heading]]`,
  `[[Note^block-id]]`, `[[Note|shown text]]`. Link targets are case-insensitive; `.md` is omitted.
- Embeds: `![[image.png]]`, `![[image.png|300]]` (width), `![[Other note]]`, `![[file.pdf]]`.
- Tags: `#tag`, nested `#area/work`.
- Block ids: end a line with ` ^my-id` to make it linkable.
- Tasks: `- [ ] todo`, `- [x] done`. These are Markdown tasks used by note queries, daily-note tools
  and legacy task views; the independent Plan Board does not synchronize them. Other workflow states
  are portable comments on the task line:
  `- [ ] Review <!-- mosaic:state=blocked -->` (also `in-progress` and `in-qa`). Keep the
  comment before a trailing `^block-id`. Queries expose `workflow`, e.g.
  `task:open workflow=blocked show:workflow,due`. Calendar and query task labels omit the comment.
  Changing a card's state keeps its parent/nesting; completing a parent doesn't complete its subtasks.
- Math: `$inline$` and `$$` blocks (KaTeX).
- Diagrams and charts inside notes, as fenced code blocks:
  - ` ```mermaid ` — flowcharts, sequence, class, ER, state, Gantt, mindmaps…
  - ` ```dot ` — Graphviz graphs.
  - ` ```vega-lite ` — a Vega-Lite JSON spec; `"data": {"url": "data.csv"}` loads a vault file
    (relative to the note). Remote URLs are not loaded.
  - ` ```math ` — display math.
  - ` ```query ` — a live table of the notes matching a query (see "Queries"), e.g. a project dashboard:
    ` tag:project status!=done sort:due show:status,due `.

## Canvases (JSON Canvas 1.0)

```json
{
	"nodes": [
		{ "id": "a1", "type": "text", "x": 0, "y": 0, "width": 260, "height": 120, "text": "# Idea\nMarkdown with [[links]]", "color": "4" },
		{ "id": "b2", "type": "file", "x": 360, "y": 0, "width": 300, "height": 220, "file": "Projects/Plan.md" },
		{ "id": "c3", "type": "link", "x": 0, "y": 200, "width": 260, "height": 70, "url": "https://example.com" },
		{ "id": "g1", "type": "group", "x": -40, "y": -60, "width": 760, "height": 360, "label": "Phase 1" }
	],
	"edges": [
		{ "id": "e1", "fromNode": "a1", "fromSide": "right", "toNode": "b2", "toSide": "left", "label": "details" }
	]
}
```

- `id`s are unique strings (16 hex chars is conventional). Coordinates are pixels; y grows downward.
- Sides: `top|right|bottom|left`. Ends: `toEnd` defaults to `"arrow"`, `fromEnd` to `"none"`.
- Colours: `"1"` red, `"2"` orange, `"3"` yellow, `"4"` green, `"5"` cyan, `"6"` purple, or `"#rrggbb"`.
- A group contains the cards whose boxes lie inside it; there is no parent field.
- Lay cards out on a grid (e.g. 300 px apart) so humans can read the board without rearranging it.

### Diagrams (shapes and connection styles)

A canvas is also Mosaic's diagram tool. Any `text` card can be drawn as a shape; its `text` is the
label (Markdown, links work). Optional fields, all checked on write:

| Field | On | Values |
|---|---|---|
| `shape` | text card | Basic: `rectangle`, `rounded`, `pill` (start/end, state), `ellipse` (use case), `diamond` (decision), `cylinder` (database), `cloud`, `note`, `actor` (person; label under the figure). Flowchart: `parallelogram` (input/output), `hexagon`, `document`, `process`. UML structure: `class`, `package`, `component`, `node` (deployment), `artifact`, `port`. UML behaviour: `initial`, `final`, `bar` (fork/join), `lifeline`, `activation`, `timing`, `frame` (sd, alt, loop…; drawn behind other cards) |
| `border` | shaped card | `solid` (default), `dashed`, `dotted`, `none` |
| `line` | edge | `solid` (default), `dashed`, `dotted` |
| `toEnd`, `fromEnd` | edge | `none`, `arrow`, `triangle` (hollow: inheritance), `open` (dependency), `diamond` (composition), `diamond-open` (aggregation), `circle`. Defaults: `toEnd` `arrow`, `fromEnd` `none` |
| `fromLabel`, `toLabel` | edge | Short text near each end, e.g. multiplicities `1` and `1..*` |
| `icon` | text card | A network / cloud icon above the label: `server`, `database`, `cloud`, `laptop`, `smartphone`, `monitor`, `router`, `network`, `wifi`, `globe`, `shield`, `lock`, `key`, `user`, `users`, `building`, `mail`, `message`, `bell`, `credit-card`, `cpu`, `hard-drive`, `container`, `box`, `file`, `workflow` |
| `fromOffset`, `toOffset` | edge | Where along `fromSide` / `toSide` it attaches, 0–1 (middle when absent). Sequence messages use them to leave a lifeline at a given height |
| `thickness` | edge | Line width in pixels (2 when absent) |
| `route` | edge | `curved` (default), `straight`, `orthogonal` (right angles, around the other cards) |

```json
{ "id": "db", "type": "text", "text": "Orders", "shape": "cylinder", "color": "5", "x": 400, "y": 0, "width": 150, "height": 130 },
{ "id": "e2", "fromNode": "svc", "toNode": "db", "label": "writes", "line": "dashed" },
{ "id": "e3", "fromNode": "order", "toNode": "line", "fromEnd": "diamond", "toEnd": "none", "fromLabel": "1", "toLabel": "1..*" }
```

Special shapes:

- **`class`**: separate the compartments with lines of `---`: name (and «stereotype») first, then
  attributes, then operations. Example text: `"«interface»\n**Payable**\n---\n+ pay()"`.
- **`lifeline`**: the text is the participant's name (shown in its head box). Messages are edges
  between lifelines with `fromSide`/`toSide` `right`/`left` and the same `fromOffset`/`toOffset`
  (0.1 near the top, 0.9 near the bottom), so they run level. Returns: `"line": "dashed", "toEnd": "open"`.
- **`frame`**: the first line is its tag, e.g. `"**alt** [card declined]"`; place it around the cards it
  frames.
- **`timing`**: one card holds the whole timing diagram. Each line `Lane: State@time State@time…`
  is a lane drawn as a step line (one level per state); `time: 0..20 s` sets the axis range and unit;
  any other line is the title. Example text: `"**Door**\nDoor: Closed@0 Open@5 Closed@12\ntime: 0..20 s"`.
  Use `_` for spaces in a state name (`Not_ready@3`).
- `initial`, `final`, `bar`, `port` and `activation` are symbols without a label.

Shape labels keep every line break. Mosaic ships a template for each of the 14 UML diagram types (New
diagram… in the app); they're plain canvases you can read for examples.

**Check what you drew:** after writing or changing a canvas, call `render` with its path. You get a PNG
of the diagram; look for overlapping cards, labels that don't fit and arrows pointing the wrong way,
fix the canvas, and render again.

Good sizes: about 180×100 for boxes, 180×130 for a diamond, 150×130 for a cylinder, 100×140 for an
actor. Leave 80–120 px between shapes so arrowheads and labels have room.

## Charts (`.vl.json`)

A Vega-Lite spec, e.g.

```json
{ "data": { "url": "sales.csv" }, "mark": "bar",
  "encoding": { "x": { "field": "month", "type": "ordinal", "sort": null }, "y": { "field": "amount", "type": "quantitative" } } }
```

## Search syntax

Words must all match (prefix match); `"exact phrase"`; filters `tag:project` (includes nested tags)
and `path:Projects` (folder).

## Queries

`query` (CLI: `mosaic query …`) finds notes by structure instead of words. Terms are combined with AND;
uppercase `OR` separates alternative groups (`tag:work status=active OR tag:idea priority>2`):

| Term | Meaning |
|---|---|
| `tag:project`, `tag:a\|b` | Has the tag (nested tags count: `tag:area` matches `#area/work`) |
| `folder:Projects` | Anywhere under the folder |
| `kind:markdown`, `kind:canvas` | File kind |
| `links-to:Note` / `linked-from:Note` | Links to that note / is linked from it |
| `has:due` | The frontmatter field is set |
| `status=active`, `status!=done`, `priority>2`, `due<=today+7`, `title~draft` | Compare a field (`~` = contains). Fields: frontmatter keys plus `title`, `name`, `path`, `folder`, `tags`, `modified` |
| `-tag:done`, `-has:due`, `-folder:Archive` | Negate a filter |
| `sort:due`, `sort:-modified` | Order (`-` = descending; notes without the field go last) |
| `limit:20`, `show:status,owner` | How many (default 100) and which columns to show |
| other words | Full-text search, as in `search` |

Values: `a|b` matches either; list fields (`tags: [a, b]`, `owners: […]`) match if any item does; dates as
`2026-10-02`, `today`, `today-7`, compared by day; numbers as numbers; other text ignoring case. Quote
values with spaces: `status="in progress"`. The result lists each note's path, title, modified time, tags
and full frontmatter, plus `columns` (the fields worth showing) and `total` (matches before `limit`).
The person can save a query in Bookmarks; agents can do the same with `add_bookmark` and a
`query:<query>` value.

**Days.** `tasks_by_day` (CLI: `mosaic days [from] [to]`) gives the person's calendar: for each day, its
daily note (any note named after its date, like `Daily/2026-10-04.md`) with that note's tasks, plus tasks in
other notes due that day (`📅 2026-10-04`), and `overdue` dated tasks. `carry_over` (CLI: `mosaic carry-over
[day]`) does what the app does when the person opens today's note: the open tasks of the last daily note
move into the day's note with their open subtasks, and the old note keeps them as `- [>] task`.

**Tasks.** `task:open` (or `done`, `moved` for `[>]`, `cancelled` for `[-]`, `all`; `task:open|moved` for
several) lists checkbox tasks (`- [ ] text`, subtasks indented under them) instead of notes. Each row then
has a `task`: `line`, `status`, `mark`, `text`, `depth` and `parent` (the line of the task it's nested
under), `due`. Every filter applies per task: first the task's own `text`, `status`, `due` (a
`📅 2026-10-05` on its line, else the note's `due`) and `line`, then its note's fields. `tag:` matches
#tags in the task or the note's frontmatter tags; plain words must appear in the task's text. Examples:
`task:open folder:Daily`, `task:open due<=today sort:due`, `task:open tag:project show:status`. To tick a
task, call `set_task` with the row's `path`, `task.line` and `task.text` and `done: true` (or false to
untick it); it is refused with `conflict` when the line changed since you queried.

**Workflow states.** Each task row also has `task.workflow`: `new`, `blocked`, `in-progress`, `in-qa` or
`done`. Mosaic keeps the state on the task's line as `<!-- mosaic:state=in-progress -->`; `done` is the
ticked checkbox. Move a task with `set_task_workflow`: pass `path`, `task.line`, `task.text` (as
returned, annotation included) and `task.workflow` as `expected_state`, plus the new `state`. Don't
write the annotation by hand.

## Links, aliases and moves

- `list_aliases` lists every frontmatter alias and the note it names; `[[Alias]]` opens that note.
- `list_unlinked_mentions` finds notes that name a note (its title or an alias) in plain text without
  linking to it. `link_mention` turns one into `[[Note]]` (or `[[Note|words]]`) on that line.
- `rename` and `move_files` rewrite links to follow a move. If some notes couldn't be updated (or Mosaic
  stopped half-way), the move shows up in `list_unfinished_renames`; `fix_links` finishes it. Notes it
  can't change are in `failed_links_in`; notes in folders the person reviews are in
  `proposed_links_in`, and the move stays unfinished until the person accepts them and you run
  `fix_links` again. A workflow limited by `may-change` that renames or moves a note gets the same
  result: links in notes outside its folders are proposed, not changed, and listed in
  `proposed_links_in`; the move itself happens.

## History and undo

`file_history` lists the versions Mosaic kept of a file; `read_version` shows one without restoring it,
and `restore_version` puts it back. `list_ai_activity` is the person's AI activity log: changes made by
agents and the command line, newest first. `undo_change` reverses one of them (an edit, a new file, a
deletion or a move). Undoing is a change like any other: in a folder the person reviews, or outside the
folders you may change, it becomes a proposal. It is refused with `conflict` when the file changed
again since.

## Search index

`search`, `query`, backlinks, tags and mentions use an index of the vault. `get_index_health` says
whether it is `healthy`, `rebuilding` or `degraded`. If results look out of date, `rebuild_index`
re-reads every file (slow in a large vault); it changes no notes.

## Planner tasks

The independent Board uses planner tasks, not Markdown checkboxes. Discover them with
`list_planner_tasks`; use `list_planner_epics` to find assignment IDs and `get_planner_task` before a
change. Every result includes a `revision`. Pass that exact value as `expected_revision` when editing,
moving, completing, reopening, archiving, restoring or trashing a task. If another person or process
changed it first, Mosaic returns `conflict`; read it again and reconsider the change.

`planner_task_history` returns the full activity timeline, oldest first. Every entry has `occurred_at`
(UTC), `source` (`app` for a person, `cli`, `agent`, `external`) and `actor` (the agent's name), the
`action` and a self-contained `summary`, a `changes` list of `{field, from, to}` (a status transition
is the `status` change; `null` means unset), an optional `reason` when the entry is a consequence of
another change (for example a work session cancelled because its task was completed), the full
`before`/`after` snapshots, and `text`: the same entry as one readable line,
`time | source:actor | task <id> | action | summary | field: old -> new | reason: …`. Entries written
before Mosaic recorded the actor have no `source`/`actor` (shown as `unknown`); their `changes` are
derived from the snapshots. Use
`create_planner_task`, `update_planner_task`, `move_planner_task`, `complete_planner_task`,
`reopen_planner_task`, `archive_planner_task`, `restore_planner_task` and `trash_planner_task` for
changes. Moving requires the complete destination epic, parent and status. Completion refuses open
subtasks unless explicitly confirmed; future work sessions are cancelled by default or can explicitly
be kept.

Epics group Board tasks. `create_planner_epic` takes a title, an optional description and a CSS color
(the app's default when left out); `update_planner_epic` changes only the fields you pass, with the
epic's `expected_revision`. `archive_planner_epic`, `restore_planner_epic` and `trash_planner_epic`
are lifecycle steps like the task ones: archive before trashing, and archiving an epic leaves its
tasks as they are.

`get_planner_summary` returns the planner's `revision`, which rises with every change, and counts of
epics, tasks, work sessions and events: compare revisions to see whether anything changed since you
last looked. `list_planner_activity` is the activity feed for the whole planner, newest first, in
pages (`limit`, then `before_id` = the previous `next_before_id`); filter it with `entity_kind`
(`epic`, `task`, `event`, `work_session`) and `entity_id`. Its entries have the same fields as
`planner_task_history`, without the `before`/`after` snapshots unless you pass `include_snapshots`.
`export_planner` returns the app's backup export as `json` (everything, including all activity) or
`csv` (one row per item) in the result; it never writes a file, so save it with `create_file` if the
person wants a copy in the vault. A large export comes in pages: pass `next_cursor` back as `cursor`
until it is `null`, and join the `content` of the pages. If the planner changes in between, the cursor
is refused with `conflict`; start again.

Planner
changes made through MCP appear in the open Board and Calendar automatically. Planner changes can't
be proposed for review: a scheduled workflow restricted to some folders is refused (`denied`) unless
its `may-change` includes `planner:`. Don't retry or work around a refusal; tell the person what you
wanted to change.

## Calendar

The planner's Calendar holds events (one-off or recurring) and work sessions (time blocked for a Board
task). Start with `get_planner_calendar`: for `from`..`to` (YYYY-MM-DD, default today and the next 6
days, at most 371 days) it returns every event occurrence with recurrences expanded, the work sessions
with their task's title, the Board tasks due in the range (`due_markers`) and minutes scheduled per
day. `list_planner_events` lists the events themselves (a recurring series once) and
`list_planner_work_sessions` the sessions.

- **Times.** Timed values are RFC 3339 with an offset when you write them
  (`2026-11-20T09:00:00+01:00`) and come back in UTC (`2026-11-20T08:00:00.000Z`). All-day values
  are dates, and the end is exclusive: a one-day event on the 20th ends on the 21st. `timezone` is an
  IANA name (`Europe/Paris`); a recurrence repeats at the same local time in it.
- **Recurrence.** `recurrence_rule` is an RRULE without its prefix: `FREQ=WEEKLY;BYDAY=MO,WE`,
  `FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6`.
- **Revisions.** Changes take `expected_revision`, as for tasks. Each occurrence in
  `get_planner_calendar` carries its `series_id`, `series_revision` and `occurrence_key` (its local
  date). To change the whole series or a one-off event use `update_planner_event` with only the
  fields to change (`""` removes `meeting_url`, `epic_id`, `color` or `recurrence_rule`). To change
  one occurrence use `cancel_planner_event_occurrence` or `replace_planner_event_occurrence` (new
  start and end, plus any field that differs from the series). `archive_planner_event`,
  `trash_planner_event` (after archiving) and `restore_planner_event` work as for tasks.
- **Work sessions.** `create_planner_work_session` schedules a Board task;
  `update_planner_work_session` moves or resizes it; `cancel_planner_work_session` removes it.
- **iCalendar.** `preview_ical_import` shows what an `.ics` text would add, without changing
  anything; `import_ical` with the same text imports all of it or the keys or `source_uid`s in
  `select` (a UID brings a series with its overrides). Events imported before are skipped unless
  `allow_duplicates`. `export_ical` returns the calendar as `.ics` text; save it with `create_file`
  only if the person asks.

Calendar changes are applied directly, never reviewed, and need `planner:` like Board tasks: under a
`may-change` without it they are refused (`denied`). Tell the person instead of retrying.

## Calendar subscriptions

Subscriptions are read-only ICS feeds (a team calendar, holidays) the person subscribed to; the
calendar shows their events over the planner's own. They are not planner events: you can't edit
their events, only the subscription. `list_calendar_subscriptions` lists them (id, name, color,
visible, refresh_minutes, last_success, last_error, has_cache). `get_calendar_overlay` returns the
events of the visible ones from `from` to `to` (inclusive, `YYYY-MM-DD`, in `timezone`, default this
computer's) from the cached downloads; it never downloads, so call `refresh_calendar_subscriptions`
first if `last_success` is old (`force: true` downloads every feed now). A failed download is that
subscription's `last_error`; tell the person rather than retrying in a loop.

Change subscriptions only when the person asks. `add_calendar_subscription` takes a name and the
feed's HTTPS or `webcal://` link, and `update_calendar_subscription` changes only the fields you give
(name, color, visible, refresh_minutes, or a new url). A feed link often carries a private token: it
goes into the macOS Keychain and no tool returns it, so don't repeat it in notes or replies, and never
invent or guess one. `remove_calendar_subscription` forgets the link and the cached events; it can't be
undone without the link. These changes apply at once, never as proposals; a workflow restricted to
some folders is refused (`denied`) unless its `may-change` includes `subscriptions:`. The app shows
your changes when the calendar next reloads (on focus, or within five minutes). Subscriptions need
macOS: elsewhere adding one fails with "calendar subscriptions currently require macOS Keychain".
