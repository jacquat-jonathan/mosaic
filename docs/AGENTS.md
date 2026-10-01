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
- **Deleting is safe but visible:** files go to the macOS Trash.
- **Renaming updates links** in every other note automatically (use `rename`, not delete + create).
- **Duplicate with `copy`** (any file, including images); it never overwrites an existing file.
- **Bookmarks** are the human's shortlist in the app's sidebar (`list_bookmarks`, `add_bookmark`,
  `remove_bookmark`). Bookmark something only when asked or when it is clearly the place to look
  next (e.g. a report you just wrote). They follow renames.
- Keep files human-readable: short paragraphs, headings, lists. Don't reformat content you didn't change.

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
- Tasks: `- [ ] todo`, `- [x] done`.
- Math: `$inline$` and `$$` blocks (KaTeX).
- Diagrams and charts inside notes, as fenced code blocks:
  - ` ```mermaid ` — flowcharts, sequence, class, ER, state, Gantt, mindmaps…
  - ` ```dot ` — Graphviz graphs.
  - ` ```vega-lite ` — a Vega-Lite JSON spec; `"data": {"url": "data.csv"}` loads a vault file
    (relative to the note). Remote URLs are not loaded.
  - ` ```math ` — display math.

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

## Charts (`.vl.json`)

A Vega-Lite spec, e.g.

```json
{ "data": { "url": "sales.csv" }, "mark": "bar",
  "encoding": { "x": { "field": "month", "type": "ordinal", "sort": null }, "y": { "field": "amount", "type": "quantitative" } } }
```

## Search syntax

Words must all match (prefix match); `"exact phrase"`; filters `tag:project` (includes nested tags)
and `path:Projects` (folder).
