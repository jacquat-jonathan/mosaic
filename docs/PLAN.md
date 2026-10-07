# Mosaic — implementation plan

Roadmap source of truth: the Mosaic vault's `Ideation/Next steps.md`; shipped work and decisions are in
`Ideation/Done.md`, with individual milestone notes alongside them. This file is the repository's ordered,
checkable implementation record through M27. Current release: **0.16.0** (`v0.16.0`, 2026-10-08).

## Fixed decisions

- Product **Mosaic**, bundle id `dev.jona.mosaic`, binary `mosaic` (`mosaic mcp` = stdio MCP server), core crate `mosaic-core`. Repo folder is `mosaic`.
- Tauri 2 · Rust (stable) · React 19 + TypeScript + Vite · pnpm · CodeMirror 6.
- Index: SQLite FTS5 via `rusqlite` (bundled), in `~/Library/Caches/mosaic/<vault-hash>/index.db`, WAL mode. Never write inside the vault except user content.
- Ad-hoc signing only. macOS 12+. Universal2 at release.
- Offline: CSP `default-src 'self'`, no telemetry, every renderer bundled. No automatic updater: the only network access is `git fetch`/`git pull` of the source checkout when the user clicks Check for updates / Update in Settings (decided 2026-10-01).

## Repo layout

```
Cargo.toml                 workspace
crates/mosaic-core/        vault, parse, index, watch, api
crates/mosaic-cli/         bin "mosaic": subcommands + `mcp`
src-tauri/                 Tauri app: commands + events over mosaic-core
ui/                        React app (Vite)
  src/ipc/                 typed wrappers around Tauri invoke/listen
  src/state/               workspace store (tabs, panes, buffers)
  src/editor/              CodeMirror live preview + widgets
  src/viewers/             one component per file kind
  src/views/               destinations, tree, search, planning, workflows, settings
fixtures/vault/            Obsidian-style test vault (with .obsidian/)
docs/                      PLAN.md, AI guide (AGENTS.md), MCP setup
scripts/                   gen-vault (5k files), install.sh
```

## The core contract: `mosaic_core::api`

The app, CLI and MCP share this core rather than reimplementing vault behavior. The table captures the
foundational file operations; later milestones added copy/import, tasks and days, queries, history/undo,
bookmarks, agents, review proposals and rendering. Paths are always vault-relative, `/`-separated and
validated (no `..`, no absolute paths, symlinks must resolve inside the root, `.obsidian/` hidden).

| Op | Input | Output |
|---|---|---|
| `list` | `dir?`, `recursive?` | entries `{path, kind, size, mtime}` |
| `read` | `path` | `{path, content, hash}` (text) or `{path, kind, size}` (binary) |
| `search` | `query`, `limit?` | hits `{path, title, snippet, score}` |
| `create` | `path`, `content?` | `{path, hash}`; error if exists |
| `write` | `path`, `content`, `expected_hash?` | `{hash}`; `Conflict` if hash mismatch |
| `append` | `path`, `content` | `{hash}` |
| `patch` | `path`, `find`, `replace`, `expected_hash?` | `{hash}`; error if `find` not found exactly once |
| `rename` | `from`, `to`, `update_links=true` | `{changed: [paths]}` |
| `delete` | `path` | moved to macOS Trash |
| `backlinks` | `path` | `[{path, line, context}]` |
| `tags` | — | `[{tag, count}]` |
| `outline` | `path` | frontmatter + headings + links (cheap AI overview) |

Errors: `NotFound`, `AlreadyExists`, `Conflict{current_hash}`, `InvalidPath`, `NotText`, `Invalid`, `Denied`, `Io`.

## Milestones

### M0 — Skeleton (ac-1 partial)
- [x] Cargo workspace with `mosaic-core`, `mosaic-cli`, `src-tauri`
- [x] Vite + React + TS app in `ui/`, wired as Tauri frontend
- [x] `tauri.conf.json`: identifier, CSP, macOS min 12, ad-hoc signing (`signingIdentity: "-"`)
- [x] `pnpm dev` opens a window; `pnpm tauri build --debug` produces `Mosaic.app`
- [x] `scripts/check.sh`: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `pnpm lint`, `pnpm test`
- [x] `.gitignore`, minimal README

### M1 — Core vault + file tree (ac-1, ac-2)
- [x] `vault::Vault::open(root)`, path validation, `.obsidian/` + dotfiles excluded from listings
- [x] Atomic write (temp + rename, same dir), sha256 content hash
- [x] Delete via `trash` crate; rename/move; mkdir
- [x] Non-UTF-8 detection → `NotText`
- [x] Fixture vault + unit tests (traversal, symlink escape, trash, atomicity)
- [x] Tauri commands; open-vault dialog; remember last vault
- [x] Tree view: expand/collapse, create file/folder, inline rename, drag-move, delete (context menu)

### M2 — Markdown live preview (ac-3)
- [x] CodeMirror 6 with markdown language, hide syntax on inactive lines (headings, emphasis, links, lists, code, quotes)
- [x] Frontmatter initially rendered as a properties widget; superseded in 0.13.1 by right-context-only Properties with **Edit as YAML** for source editing
- [x] Wikilinks `[[a|b]]`, `[[a#h]]`, `[[a^id]]` rendered and clickable (Cmd-click opens); unresolved styled distinctly
- [x] Embeds `![[note]]`, `![[img.png]]`, `![[x.pdf]]`
- [x] Tags `#tag` / nested `#a/b`
- [x] KaTeX inline `$…$` + block `$$…$$`; Mermaid fenced blocks
- [x] Autosave (debounced) with base hash → `write(expected_hash)`

### M3 — Index, search, backlinks (ac-6)
- [x] `parse`: frontmatter (aliases, tags), wikilinks/embeds/md links (skip code), tags, headings, block ids
- [x] Obsidian link resolution: case-insensitive, shortest unique path, aliases
- [x] SQLite schema: `files`, `links`, `tags`, `fts(content)`; incremental by mtime+size
- [x] Search panel (Cmd-Shift-F) with snippets; quick switcher (Cmd-O)
- [x] Backlinks panel; link-aware rename (multi-file undo deferred)
- [x] `scripts/bench.sh`: 5,000 notes, search ≈ 4 ms, full index ≈ 0.3 s

### M4 — Layout + live refresh (ac-7, ac-9)
- [x] Tabs, split right/down, drag tabs between panes; persisted per vault in the app's webview storage (never in the vault)
- [x] `watch`: notify + debouncer (~100 ms), ignore `.obsidian/`, own-write suppression by hash, updates index
- [x] Emit `vault://changed` events; clean buffer reloads, dirty buffer → conflict prompt (reload / keep mine / compare)
- [x] Delete of open file closes tab (prompt if dirty); offline banner if root vanishes
- [x] Test: external write visible < 1 s

### M5 — Other file types (ac-4)
- [x] Viewer registry by extension
- [x] HTML: sandboxed iframe (no scripts, CSP no network) + source tab
- [x] Images; PDF via pdfjs-dist (worker bundled)
- [x] CSV: papaparse + own editable grid (own delimiter detection), byte-identical round-trip when untouched
- [x] JSON/YAML/code/text: CodeMirror language packs; >5 MB → read-only

### M6 — Visuals (ac-5)
- [x] JSON Canvas: @xyflow/react; text/file/link/group nodes, edges, colors; save preserves unknown fields
- [x] Excalidraw `.excalidraw` editor (assets bundled, no CDN fonts)
- [x] Vega-Lite: fenced `vega-lite` blocks + `.vl.json`, data from relative CSV/JSON
- [x] Graphviz: fenced `dot` blocks + `.dot` via @viz-js/viz
- [x] Parse errors inline, never overwrite on error
- [x] "New note / canvas / drawing / chart" commands

### M7 — CLI + MCP (ac-8)
- [x] `mosaic` CLI (clap): every api op, `--vault` / `MOSAIC_VAULT` / last vault, `--json`
- [x] `mosaic mcp`: rmcp stdio server, one tool per api op with JSON schemas
- [x] `docs/AGENTS.md`: vault conventions, JSON Canvas cheat-sheet, Mermaid/Vega/DOT usage
- [x] `vault_guide` tool + server instructions expose the AI guide
- [x] Integration tests: scripted MCP client + CLI against fixture vault
- [x] "Connect AI" dialog: install CLI (symlink to ~/.local/bin) + Claude Code / Desktop config

### M8 — Hardening + release (ac-1, ac-10)
- [x] Offline audit (no HTTP client crates; release app + its WebKit networking process open zero sockets), perf pass (live preview ~2 ms/keystroke on 7.5k lines)
- [x] Universal2 release build, `scripts/install.sh` → /Applications
- [x] README: prerequisites, build/install, Gatekeeper first launch, MCP setup for Claude Code + Desktop

### M9 — UI foundations
Completed details are consolidated in the Mosaic vault note `Ideation/Done.md`.
- [x] Resizable left bar and right panel (remembered); toggles moved to the main area's top corners
- [x] Tree drag and drop works in the app (`dragDropEnabled: false`), multi-item moves, open folder on hover
- [x] Vault switcher: recent vaults, open, create (`Vault::create_new`), remove from list, reveal in Finder
- [x] Bookmarks (per vault, in `settings.json`), with a sidebar tab
- [x] Command palette (⌘P) on a single command registry that also drives shortcuts
- [x] Tree multi-selection and a richer right-click menu (duplicate via `Workspace::copy`, move to…, copy link/path)

### M10 — Settings and in-app updates
Completed details are consolidated in the Mosaic vault note `Ideation/Done.md`.
- [x] Settings panel (⌘,): Appearance (theme, note size, line width), Editor & files, Vault, AI (was the Connect AI dialog), Shortcuts, About & updates
- [x] Theme override: `data-theme` on `<html>`, native window theme, one `isDark()` for renderers
- [x] Updates by pull and rebuild: `src-tauri/src/update.rs`, `scripts/install.sh --build-only`, build commit and source folder baked in by `build.rs`
- [x] New build swapped in by a detached helper after the app quits, then reopened

### M11 — Ready to share
Done 2026-10-01, released as 0.2.0. Details in the Mosaic vault note `Ideation/Done.md`.
- [x] Movable window: grant `core:window:allow-start-dragging`; tab-bar buttons don't swallow drags
- [x] Semantic versions (workspace `Cargo.toml` + `tauri.conf.json`), a git tag per release, `CHANGELOG.md`; About shows "0.2.0 (commit)", "Check for updates" lists versions
- [x] Cancel a running update build
- [x] Real-app checks for UI foundations and settings/updates, including a full Check → Update → Restart cycle
- [x] Publish 0.2.0 (`scripts/release.sh 0.2.0`, `git push --follow-tags`)
- [x] README section for coworkers: install, update from the app, connect an agent, Gatekeeper

### M12 — Trust (search, links, validation)
Done 2026-10-01. Details in the vault note `Ideation/Done.md`.
- [x] Index Excalidraw by the text of its text elements, not raw JSON
- [x] Canvas backlinks carry context (card text or "file card")
- [x] `.vl.json` `data.url` indexed as an embed
- [x] Validate `.canvas`, `.excalidraw`, `.vl.json`, `.json` in `Vault::write`/`create`; return `invalid` with the parse error
- [x] Link-resolution cases in one shared JSON fixture read by both Rust and Vitest tests

### M13 — Diagram tool
Done 2026-10-02, released as 0.5.0. Details in the vault note `Ideation/Done.md`; format in `crates/mosaic-core/src/diagram_format.json` and `docs/AGENTS.md`.
- [x] Step 1: diagrams rendered inside canvas cards; `New › Diagram` with templates
- [x] Step 2: 25 shapes, connection styles (UML arrowheads, end labels, thickness), connection points, auto-layout, alignment guides, hover flow
- [x] Step 3: UML stencils, a template for each of the 14 types, lifelines/frames for sequences, 4+1 and C4 templates, network/cloud icons
- [x] Step 4: Mermaid block ↔ canvas, canvases embedded in notes, SVG/PNG export, presentation mode; live preview of diagram blocks in notes
- [x] MCP follows the vault open in the app unless `--vault` pins one

### M14 — Safety for agent writes
Done 2026-10-02. Details in the vault note `Ideation/Done.md`.
- [x] File history (`history.rs`): versions with who and what, restore; app, CLI and MCP
- [x] AI activity log with undo (sidebar tab; CLI `activity` / `undo`)
- [x] Render tool for agents (`render.rs`, MCP `render`, `mosaic render`), drawing data shared with the editor

### M15 — Agent gaps, robustness, quick wins
Done 2026-10-02, released as 0.7.0. Details in the vault note `Ideation/Done.md`.
- [x] Folder permissions for agents (read-only / hidden), `move_files`, `import_file`, MCP resources
- [x] Read-only index connection for queries; safe concurrent indexing (bench scenario); CLI-process and updater tests; ⇧-arrow tree selection
- [x] Paste images, daily notes, unlinked mentions, canvas from selection, saved searches

### M16 — Editing comfort, diagram follow-ups
Done 2026-10-02, released as 0.8.0. Details in the vault note `Ideation/Done.md`.
- [x] Properties editor, custom shortcuts, note export (HTML, PDF via print)
- [x] Connections routed around cards (`route.ts` / `route.rs`), crowded labels on hover
- [x] Timing shape with state lanes (`timing.ts` / `timing.rs`), shape palette with drag and drop
- [x] Copy as Mermaid for sequence and class diagrams; Open as diagram for class diagrams

### M17 — Agent review mode, queries
Done 2026-10-02, released as 0.9.0. Details in the vault note `Ideation/Done.md`.
- [x] Review mode: folder rule "review", proposals in `history.db` (`review.rs`), inbox with diff / accept / reject in the app, `list_proposals` / `withdraw_proposal`
- [x] Queries: frontmatter in the index, query language (`query.rs`), MCP `query`, `mosaic query`, ```query blocks

### M18 — UI comfort
Done 2026-10-04. From the vault note `Ideation/Ideas.md` (UI).
- [x] Note width setting (narrow / medium / wide / full)
- [x] Numbered sublists shown as 2.1, 2.2 (display only)
- [x] Fixed icon bar on the left (sidebar panels, settings)
- [x] Easier splitting: split button in the tab bar, drag a tab to the side
- [x] Table editing in place: cells, Tab / Enter, add or remove rows and columns

### M19 — Calendar view and carry-over
Done 2026-10-04. Decisions are recorded in `Ideation/Done.md`; remaining calendar ideas are in `Ideation/Next steps.md`.
- [x] Core: tasks per day (daily note tasks plus `📅` tasks), carry-over (move, leave `[>]`, unfinished subtasks only)
- [x] Calendar view: month (counts, first tasks) and week (every task, tickable)
- [x] CLI and MCP: tasks by day; carry-over for agents

### M20 — Agents in the vault
Done 2026-10-05. From the archived vault note `Ideation/Archive/Agentic.md`.
- [x] Core: agents from `Agents/` (`Name.md` or `Name/SKILL.md`): name, description, schedule, may-change, instructions
- [x] MCP: every agent as a prompt; `list_agents`; vault guide; CLI `mosaic agents`
- [x] Mirror agents into the vault's `.claude/skills/<name>/SKILL.md`

### M21 — Chat
Done 2026-10-06.
- [x] Tauri: run Claude Code headless in the vault (stream-json), continue the session, stop
- [x] Chat workspace view (moved from the original right panel in M24): messages, Markdown answers, tool calls as linked lines, open note attached, agent picker and `/name`
- [x] Missing or logged-out Claude Code explained

### M22 — Tessera (scheduled agents)
Done 2026-10-06.
- [x] Schedules while the app is open (`daily`, `weekdays`, weekdays, intervals), one missed run at start
- [x] Runs panel: run log, changes and proposals, Run now, pause one or all
- [x] `may-change` enforced per scheduled process; writes elsewhere become proposals

### M23 — Workflow polish
Done 2026-10-06, released as 0.12.1.
- [x] Query tables sort by clicking a column header; the query block keeps the selected sort
- [x] Chat can attach selected note text and choose the Claude model
- [x] The caret stays stable when it crosses live-preview element boundaries
- [x] Review and rethink the overall UI now that more features share the sidebars, tab bars and editor actions (M24)

### M24 — UI architecture cleanup
Released 2026-10-07 as 0.13.0, with the tested post-release polish in 0.13.1. Details are in the archived vault note `Ideation/Archive/M24 UI architecture cleanup.md`; completed work is in `Ideation/Done.md`.
- [x] Shared macOS title strip; Notes, Find, Plan and AI rail with independent destination/sidebar state
- [x] Mixed workspace tabs and split panes for notes, search, calendar, chats, workflows, runs, activity, connections and settings
- [x] Persisted layouts with migration; contextual note/chat/workflow/run/calendar panels and action menus
- [x] Automatically saved per-vault chats, grouping, titles, rename/delete, drafts, context, models and sessions
- [x] Workflow cards, guided agent/trigger/folder creation, source-preserving edits and detailed run/proposal associations
- [x] Today, Calendar, Tasks and saved task views; compact layouts, keyboard focus and accessible status labels
- [x] Manual native dragging/geometry, visual matrix, zoom, reduced-motion, screen-reader and keyboard-focus acceptance checks
- [x] 0.13.1 polish: delete workflows safely; right-context-only Properties; stable Up/Down navigation; calendar double-click; spellcheck without automatic correction/capitalization; one Search focus indicator
- [x] Full `scripts/check.sh`, production UI and native builds, 105 Rust tests and 133 UI tests; installed 0.13.1 native macOS smoke test passed

### M25 — Tables, queries and review follow-ups
Released 2026-10-07 as 0.14.0.
- [x] Render inline Markdown formatting inside editable table cells while preserving Markdown source on edit
- [x] Query `OR` groups and saved structured queries in Bookmarks
- [x] Review text changes hunk by hunk; propose and accept file renames and binary additions
- [x] Request native attention when a new proposal arrives while Mosaic is in the background

### M26 — Event-triggered workflows
Released 2026-10-07 as 0.15.0.
- [x] `on: created in Folder/` in agent frontmatter, one event or a list alongside `schedule:`; recursive Markdown creation from the app, imports, copies and external tools while Mosaic is open
- [x] Debounced per-workflow queues, duplicate coalescing, visible overflow, one active run per workflow and a test trigger against an existing note
- [x] Agent-to-agent chains with IDs, configurable maximum depth (default 3), repeated workflow/event/path suppression and a hard run ceiling
- [x] Existing `may-change` and folder rules govern events; event cause, note and chain appear in run details
- [x] Per-workflow model choice for manual, scheduled and event runs; transient failures retry at most twice before requiring attention
- [x] Guided event setup, combined schedule/event display, pause controls, failure attention and daily-note-summary acceptance case

### M27 — Editing helpers and visual task board
Released 2026-10-08 as 0.16.0. Implemented in the roadmap's order.
- [x] Sanitized Markdown formatting in Settings' release notes, with external links opened on click
- [x] Searchable `/` insertion menu for common blocks; arrow navigation and Enter/Tab to insert; excludes code, frontmatter and read-only notes
- [x] Resizable table columns, pointer and keyboard controls, reset widths and per-vault/note/table app-storage persistence; Markdown stays unchanged on resize
- [x] Plan task board with five states, draggable cards and state menus, parent groups and subtask progress, text/folder filters, loading/error/overflow states
- [x] Portable workflow comments, checkbox completion, query `workflow` fields and filters, clean task labels, history and conflict-aware writes

## Working rules
- `scripts/check.sh` green before each milestone commit.
- Core logic gets Rust tests; UI logic gets Vitest; don't test third-party renderers beyond a smoke test.
- Keep the Tauri layer thin: no business logic outside `mosaic-core`.
