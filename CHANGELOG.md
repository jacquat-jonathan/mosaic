# Changelog

What changed in each version of Mosaic. Settings › About & updates shows the sections newer than the installed app, so write each line for someone using the app. New work goes under **Unreleased**; `scripts/release.sh <version>` turns that section into a release.

## Unreleased

## 0.12.0 — 2026-10-06

- **Tessera scheduled agents**: add `schedule: daily 08:00`, `weekdays 08:00`, `fri 17:00`, `every 2h` or `every 30m` to an agent. It runs while Mosaic is open and catches up once after a missed run. The new Runs tab has Run now, pause controls, results, changed files, failures and proposals. A scheduled agent writes directly only inside its `may-change` folders; other changes wait in AI activity for review.

## 0.11.1 — 2026-10-06

- Chat: Claude now knows which note you have open, and a change you ask for without naming a note goes to that note (it edited another one before); if it means to change a different note, it says which first.
- Agents in Claude Code are `/mosaic:<name>` (shown with "(MCP)"); the docs said `/mcp__mosaic__<name>`, which Claude Code doesn't accept.

## 0.11.0 — 2026-10-06

- **Chat with Claude** (the chat icon in the left bar, ⇧⌘L, or the Chat tab of the right panel): ask about your notes or have Claude change them. It runs Claude Code in the vault with only Mosaic's tools for changes, so every change is in AI activity with Undo, and in folders you review it waits for you. The open note is attached (remove it, or attach more with the clip); answers link to notes; each step shows as a short line ("Edited Projects/Site"). Start an agent from the buttons of an empty chat or with `/name`. New chat, Stop, Save as note (in `Agents/Chats/`), and the cost so far. Needs Claude Code installed and logged in.
- **Agents in the vault**: a note in `Agents/` (or a Claude Code skill folder `Agents/Name/SKILL.md`) defines an agent: its properties give a `description` (and `schedule` and `may-change` for later), its body the instructions. Claude recognizes them as agents: each is an MCP prompt (in Claude Code, `/mosaic:<name>`), Mosaic mirrors them into the vault's `.claude/skills/` (never touching skills it didn't make), the vault guide explains them, and agents get `list_agents`; also `mosaic agents [--sync]`.

## 0.10.1 — 2026-10-05

- **Add a property** (⌘; or the command palette): opens the properties panel's "Add property" form, also on a note that has no properties yet.
- Numbered sublists: a nested item still written "3." (left by pressing Enter, then indenting) showed as 2.3 instead of 2.1.

## 0.10.0 — 2026-10-04

- **Calendar** (the calendar icon in the left bar, or "Open calendar" in the command palette): each day's tasks, from its daily note and from tasks anywhere with a `📅 2026-10-04` date. The week view lists every task, with subtasks and their progress (2/3), and you tick them right there; the month view shows each day's open and done counts and first tasks. Click a day to open its note (or create it). Dated tasks still open after their day show as overdue.
- **Carry-over**: when you open today's daily note, the unfinished tasks of your last daily note move into it, each with its unfinished subtasks; the old note keeps them as `- [>]` (moved), and finished subtasks stay there. Agents can do the same (`carry_over`) and see the calendar (`tasks_by_day`); also `mosaic days` and `mosaic carry-over`.
- **Tables you edit in place**: click a cell and type. Tab, ⇧Tab and Enter move between cells (past the last row adds one); right-click for inserting or deleting rows and columns and aligning a column; the + buttons beside and under a table add a column or a row. The Markdown is written back with aligned columns.
- **Note width**: Settings › Editor › Note width is now Narrow, Medium, Wide or Full (it was an on/off "readable line width").
- **Numbered sublists** show as 2.1, 2.2, 2.2.1 (the Markdown stays `1.` indented, as Obsidian expects).
- **Icon bar on the left**: Files, Search, Bookmarks, Tags and AI activity are always one click away, even with the sidebar hidden; clicking the open panel's icon hides the sidebar.
- **Splitting is easier to find**: a split button in each pane's tab bar, and you can drop a tab on the right or bottom edge of a pane to open it there.
- Errors in ```query blocks (and a few other places, like saving a pasted image) showed "[object Object]" instead of the message.

## 0.9.1 — 2026-10-03

- **Task queries**: `task:open` lists checkbox tasks across notes instead of notes, e.g. `task:open folder:Daily` or `task:open due<=today sort:due` (a task's own `📅 2026-10-05`, else its note's `due`). Subtasks stay nested under their task, and in a ```query block you tick tasks right in the table. Also `task:done`, `moved` (`[>]`), `cancelled` (`[-]`) and `all`, from the CLI and for agents too.
- Review: when you changed a file after an agent proposed a change to it, the review window says so in a clear banner and can show what you changed since. The agent now sees "undone" when you undo a change you accepted, and `overwrote` when you accepted it over your own edits.
- Folder rules for agents fail closed: a rule this version doesn't understand (written by a newer Mosaic) is enforced as read-only, and settings it doesn't know are kept when it saves. Before, an older Mosaic dropped every folder rule in that case.
- Settings › AI › Add a folder…: the folder picker opens in front of Settings, not behind it.
- Queries: comparing a date or number with a word that is neither (a typo like `due<=tomorow`) now matches nothing instead of every note.
- Settings › AI: the folder rules section is called "Folder rules for agents", and a folder you add starts as "Review changes".

## 0.9.0 — 2026-10-03

- **Review agents' changes** (Settings › AI › a folder › Review changes): in that folder, an agent's edits, new files and deletions don't touch your files. They wait under AI activity (with a count on its tab); open one to see the change as a diff, then accept or reject it, optionally saying why. Accepted changes show in AI activity with Undo. Agents see your decisions (`list_proposals`) and can take a proposal back.
- **Queries**: find notes by tag, folder, frontmatter field, date or links, e.g. `tag:project status!=done due<=today+7 sort:due`. Put one in a note as a ` ```query ` block to get a live table (a project dashboard), run `mosaic query …`, or let agents use the new `query` tool.

## 0.8.0 — 2026-10-02

- **Properties editor**: a note's frontmatter shows as a form (lists as chips, checkboxes, dates, numbers, text). Add, rename or remove properties; "Edit as YAML" shows the source. Comments and formatting in the YAML are kept.
- **Custom shortcuts**: in Settings › Shortcuts, click a shortcut and press new keys; any command can have one, and a taken shortcut moves over (Settings says from which command).
- **Export a note** as a standalone HTML file (diagrams, math, images and embedded canvases included) or as PDF through the print dialog (⇧⌘P, or right-click › Export).
- `==highlights==` now show in canvas cards, previews and exports too.
- **Connections that go around cards**: right-click a connection › Path › Around cards draws it with right angles, avoiding the cards in between (also Straight). When you zoom out on a busy diagram, connection labels hide until you hover them.
- **Timing diagrams** with real lanes: the new Timing shape draws each line `Door: Closed@0 Open@5 Closed@12` as a step line over a time axis (`time: 0..20 s`). The Timing template uses it.
- **Drag shapes** from the Shape menu onto the canvas: it opens a palette of every shape and icon.
- **Copy as Mermaid** writes a `sequenceDiagram` for canvases with lifelines (alt/loop frames included) and a `classDiagram` for class boxes (members, inheritance, composition, multiplicities).
- **Open as diagram** now works on Mermaid class diagrams too, keeping Mermaid's layout.

## 0.7.0 — 2026-10-02

- **Paste images** into a note: they're saved next to it and embedded.
- **Daily notes**: ⌘⇧D (or the calendar button above the file tree) opens today's note, created from a template if you set one (Settings › Editor & files; `{{date}}`, `{{title}}`, `{{weekday}}`, `{{time}}`).
- **Unlinked mentions** under Backlinks: notes that mention this one by name or alias without linking, with a one-click **Link** that keeps your wording.
- **New canvas from selection**: select notes in the file tree, right-click, and get a canvas with them as cards.
- **Bookmark a search** with the star in the Search panel; it shows in Bookmarks and runs with one click.
- ⇧↑ / ⇧↓ extend the selection in the file tree.
- Search, backlinks and tags stay responsive while a big vault is being indexed.
- Fixed: when the app and an agent (or the `mosaic` command) opened or updated the index at the same moment, one could fail with "database is locked".
- Fixed: moving a note rewrote links that used one of its aliases (`[[Start]]` became `[[Home]]`); alias links now stay as written.
- **Folders agents can't change** (Settings › AI): make a folder read-only for agents, or hide it from them entirely. Enforced by Mosaic for the MCP server and the `mosaic` command, never for you.
- Agents can move several files at once (`move_files`, or `mosaic move … --to Folder`) and add images and other files (`import_file`, base64, up to 20 MB).
- Notes are available as MCP resources (`mosaic:///Folder/Note.md`), so AI clients can attach them as context directly.

## 0.6.0 — 2026-10-02

- Agents can **see what they drew**: the new `render` tool returns a picture of a canvas (or SVG file), so they can check and fix a diagram. Also `mosaic render <file> -o out.png`.
- **File history**: Mosaic keeps versions of every file changed by you, the command line or an AI agent (and notices changes made by other apps). Right-click a file › File history… (or ⌘P › Show file history) to compare any version with the file now and restore it.
- **AI activity** (new sidebar tab): every change agents made, newest first, with the agent's name and one-click **Undo** (an edit goes back, a created file goes to the Trash, a deleted file comes back, a move is reversed).
- Agents get `file_history` and `restore_version` tools to undo their own mistakes; the CLI gets `mosaic history`, `restore`, `activity` and `undo`.
- Fixed: a tab restored from the last session could stay on "Loading…".
- Fixed: the **Open as diagram** button on Mermaid blocks in notes didn't appear.

## 0.5.0 — 2026-10-02

- Network and cloud icons for diagrams (server, database, router, user…) under Shape › Icons, or right-click a card › Icon; they're included in exports. New **C4 containers** template.
- Editing a Mermaid, Graphviz, chart or math block in a note shows a live preview under it; while the source has an error, the last good drawing stays with the error below.
- Hovering a node of a Mermaid flowchart (in a note or a card) makes its connections flow and dims the rest.
- **Present** a canvas (toolbar › ⋯): it fills the screen and steps through its groups and frames with the arrow keys, connections flowing; Esc to stop.
- `![[Diagram.canvas]]` in a note shows the diagram as a picture; click it to open the canvas.
- Export a canvas as SVG or PNG (canvas toolbar › ⋯); the file is saved next to the canvas.
- **Open as diagram**: hover a Mermaid flowchart or state diagram in a note to turn it into an editable canvas next to the note, keeping Mermaid's layout.
- **Copy as Mermaid** (canvas toolbar › ⋯) turns a diagram back into a Mermaid flowchart to paste into a note.
- UML stencils in the Shape menu (now grouped: Basic, Flowchart, UML structure, UML behaviour): class boxes with compartments (separate them with `---` lines), package, component, node, artifact, port, initial and final states, fork/join bar, lifeline, activation bar and frame.
- A template for each of the 14 UML diagram types under New diagram…, each noting the 4+1 view it serves.
- More connection points along each side (and all along a lifeline), thicker or thinner connections, and **Layout** to arrange cards top to bottom or left to right along their connections.
- AI agents now work on the vault open in Mosaic and follow when you switch vaults, so their files always land where you're looking. **If you connected Claude Code before, run `claude mcp remove mosaic`, then the command in Settings › AI** (it no longer pins a vault). An agent tied to a vault with `--vault` is warned when Mosaic shows another one.

## 0.4.0 — 2026-10-02

- Diagram shapes on canvases: rectangle, rounded, pill, ellipse, diamond, parallelogram, hexagon, cylinder, document, predefined process, cloud, note and actor, from the new **Shape** button. Right-click a card to change its shape, border or colour.
- Connection styles: dashed or dotted lines, UML arrowheads at either end (hollow triangle, open arrow, filled and hollow diamond, circle), labels near each end (like `1..*`) and Reverse direction, from a connection's right-click menu.
- Dragging a card snaps its edges and centre to other cards nearby, with a guide line.
- Hovering a card makes its connections flow in their direction and dims the rest (still, without motion, when macOS "Reduce motion" is on).
- **New diagram…** replaces New canvas: start blank or from a template (flowchart, 4+1 architecture views, C4 system context). Find it in the New menu, the file tree's right-click menu and the command palette.

## 0.3.0 — 2026-10-01

- Search finds the text in Excalidraw drawings without the JSON around it.
- Backlinks from a canvas show the card's text (or "File card"), and every link from a canvas is listed, not just the first.
- A chart's data file (e.g. `code-size.csv`) lists the chart as a backlink.
- Images in Markdown syntax (`![](image.png)`) look next to the note first, like the rest of Mosaic.
- Canvas cards render Mermaid, Graphviz and Vega-Lite blocks and math (`$…$`, `$$…$$`), like notes do. So do note previews in file cards.
- AI agents get a clear error when they write a broken canvas, drawing, chart or JSON file, and nothing is written.

## 0.2.0 — 2026-10-01

- The window can be moved again by dragging the sidebar header, the tab bar or the welcome screen.
- Mosaic now has real version numbers: About shows the version and its commit, and "Check for updates" lists the new versions with what changed in each.
- A running update can be cancelled; the installed app stays as it was.

## 0.1.0 — 2026-10-01

- Vault and file tree: open any folder of Markdown notes (Obsidian-compatible), create, rename, move and delete files, with link-aware renames.
- Markdown live preview with wikilinks, embeds, tags, tasks, math, Mermaid, Graphviz and Vega-Lite.
- Full-text search, backlinks and an outline panel, backed by a local index.
- Split panes, tabs, live refresh when files change on disk, and a layout that's remembered.
- Viewers for HTML, PDF, CSV, JSON, images and code; canvases, Excalidraw drawings, charts and graphs.
- The `mosaic` command and an MCP server so AI agents can read and write the vault.
- UI foundations: resizable sidebars, tree drag and drop and multi-selection, vault switcher, bookmarks, command palette (⌘P).
- Settings (⌘,) with appearance, editor, vault, AI, shortcuts, and in-app updates from the source checkout.
- Dropping files from Finder imports them into the vault; spellcheck in the editor.
