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
- **Some folders are reviewed.** There, your create, edit, patch, append, restore and delete calls succeed
  but don't change the file: the result has a `review` id (a proposal) and a note saying so. The person
  sees the change as a diff in the app and accepts or rejects it. Until then, your reads of that file show
  your proposal and your next edits build on it, so a multi-step change is reviewed as one. File renames
  and binary additions become proposals too; folder moves are still refused. `list_proposals` shows what's pending and the person's
  decisions (a rejection may carry a reason: read it and adapt; `undone` means they accepted it, then
  undid it, so the file no longer has your change); `withdraw_proposal` takes one back. Tell
  the person what you proposed and why, since they decide.
- **Files in the configured agents folder (default `Agents/`) are agents, not documents.** A note `Agents/Name.md` or a skill folder
  `Agents/Name/SKILL.md` defines an agent the person made: its frontmatter has `name`, `description`
  and, for Mosaic, `schedule`, `on` (for example `created in Daily/`), `model`, and `may-change`
  (folders it may write without review); the body is its instructions. `on` can be one event or a
  list and may coexist with `schedule`; automatic workflows run only while Mosaic is open. When the
  person points you at one, or names an agent, **act
  as that agent**: follow its instructions for this task. `list_agents` lists them; each is also an MCP
  prompt (in Claude Code: `/mosaic:<name>`), and Mosaic mirrors them into the vault's
  `.claude/skills/`, so Claude Code started in the vault has them as skills. Edit an agent in `Agents/`,
  never its mirror.
- **Vault preferences are shared with CLI/MCP.** Read `get_vault_preferences` (CLI: `mosaic preferences`). Settings may change the agents folder, daily-note
  folder and file-name format without moving files. Discover agents with `list_agents`, not a
  hard-coded `Agents/` listing. Daily formats are `YYYY-MM-DD`, `DD-MM-YYYY` or `YYYYMMDD`; legacy
  ISO daily names remain recognized, while due dates and date placeholders always use ISO. Two
  notes representing the same date are an error to repair, never a reason to overwrite either.
- **Find notes by their properties with `query`** rather than reading many files: see "Queries" below.
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
| Web page | `.html` | Shown in a sandbox with scripts and network disabled. |
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
- Tasks: `- [ ] todo`, `- [x] done`. The task board uses New by default and Done for a checked
  box. Other workflow states are portable comments on the task line:
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
task, `patch_file` its line (`- [ ]` → `- [x]`).
