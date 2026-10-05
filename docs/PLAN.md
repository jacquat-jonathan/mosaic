# Mosaic — implementation plan

Source of truth: `~/Documents/Vaults/Perso/Work/_active/mobsidian/spec.html` (approved 2026-09-30).
This file turns the spec into ordered, checkable work. Tick boxes as work lands; each milestone ends with a commit.

## Fixed decisions

- Product **Mosaic**, bundle id `dev.jona.mosaic`, binary `mosaic` (`mosaic mcp` = stdio MCP server), core crate `mosaic-core`. Repo folder stays `mobsidian`.
- Tauri 2 · Rust (stable) · React 18 + TypeScript + Vite · pnpm · CodeMirror 6.
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
  src/views/               sidebar, tree, search, backlinks, prompts
fixtures/vault/            Obsidian-style test vault (with .obsidian/)
docs/                      PLAN.md, AI guide (AGENTS.md), MCP setup
scripts/                   gen-vault (5k files), install.sh
```

## The one contract: `mosaic_core::api`

All three front ends (Tauri, CLI, MCP) map 1:1 onto these. Paths are always vault-relative, `/`-separated, validated (no `..`, no absolute, symlinks must resolve inside root, `.obsidian/` hidden).

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

Errors: `NotFound`, `AlreadyExists`, `Conflict{current_hash}`, `InvalidPath`, `NotText`, `Io`.

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
- [x] Frontmatter block rendered as a properties widget; edited as text
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
Tracked in detail in the Mosaic vault note `UI Foundations.md`.
- [x] Resizable left bar and right panel (remembered); toggles moved to the main area's top corners
- [x] Tree drag and drop works in the app (`dragDropEnabled: false`), multi-item moves, open folder on hover
- [x] Vault switcher: recent vaults, open, create (`Vault::create_new`), remove from list, reveal in Finder
- [x] Bookmarks (per vault, in `settings.json`), with a sidebar tab
- [x] Command palette (⌘P) on a single command registry that also drives shortcuts
- [x] Tree multi-selection and a richer right-click menu (duplicate via `Workspace::copy`, move to…, copy link/path)

### M10 — Settings and in-app updates
Tracked in the Mosaic vault note `Settings and Updates.md`.
- [x] Settings panel (⌘,): Appearance (theme, note size, line width), Editor & files, Vault, AI (was the Connect AI dialog), Shortcuts, About & updates
- [x] Theme override: `data-theme` on `<html>`, native window theme, one `isDark()` for renderers
- [x] Updates by pull and rebuild: `src-tauri/src/update.rs`, `scripts/install.sh --build-only`, build commit and source folder baked in by `build.rs`
- [x] New build swapped in by a detached helper after the app quits, then reopened

### M11 — Ready to share
Done 2026-10-01, released as 0.2.0. Details in the Mosaic vault note `Architecture/Done.md`.
- [x] Movable window: grant `core:window:allow-start-dragging`; tab-bar buttons don't swallow drags
- [x] Semantic versions (workspace `Cargo.toml` + `tauri.conf.json`), a git tag per release, `CHANGELOG.md`; About shows "0.2.0 (commit)", "Check for updates" lists versions
- [x] Cancel a running update build
- [x] Real-app checks from `UI Foundations.md` and `Settings and Updates.md`, including a full Check → Update → Restart cycle
- [x] Publish 0.2.0 (`scripts/release.sh 0.2.0`, `git push --follow-tags`)
- [x] README section for coworkers: install, update from the app, connect an agent, Gatekeeper

### M12 — Trust (search, links, validation)
Done 2026-10-01. Details in the vault note `Architecture/Done.md`.
- [x] Index Excalidraw by the text of its text elements, not raw JSON
- [x] Canvas backlinks carry context (card text or "file card")
- [x] `.vl.json` `data.url` indexed as an embed
- [x] Validate `.canvas`, `.excalidraw`, `.vl.json`, `.json` in `Vault::write`/`create`; return `invalid` with the parse error
- [x] Link-resolution cases in one shared JSON fixture read by both Rust and Vitest tests

### M13 — Diagram tool
Done 2026-10-02, released as 0.5.0. Details in the vault note `Architecture/Done.md`; format in `crates/mosaic-core/src/diagram_format.json` and `docs/AGENTS.md`.
- [x] Step 1: diagrams rendered inside canvas cards; `New › Diagram` with templates
- [x] Step 2: 25 shapes, connection styles (UML arrowheads, end labels, thickness), connection points, auto-layout, alignment guides, hover flow
- [x] Step 3: UML stencils, a template for each of the 14 types, lifelines/frames for sequences, 4+1 and C4 templates, network/cloud icons
- [x] Step 4: Mermaid block ↔ canvas, canvases embedded in notes, SVG/PNG export, presentation mode; live preview of diagram blocks in notes
- [x] MCP follows the vault open in the app unless `--vault` pins one

### M14 — Safety for agent writes
Done 2026-10-02. Details in the vault note `Architecture/Done.md`.
- [x] File history (`history.rs`): versions with who and what, restore; app, CLI and MCP
- [x] AI activity log with undo (sidebar tab; CLI `activity` / `undo`)
- [x] Render tool for agents (`render.rs`, MCP `render`, `mosaic render`), drawing data shared with the editor

### M15 — Agent gaps, robustness, quick wins
Done 2026-10-02, released as 0.7.0. Details in the vault note `Architecture/Done.md`.
- [x] Folder permissions for agents (read-only / hidden), `move_files`, `import_file`, MCP resources
- [x] Read-only index connection for queries; safe concurrent indexing (bench scenario); CLI-process and updater tests; ⇧-arrow tree selection
- [x] Paste images, daily notes, unlinked mentions, canvas from selection, saved searches

### M16 — Editing comfort, diagram follow-ups
Done 2026-10-02, released as 0.8.0. Details in the vault note `Architecture/Done.md`.
- [x] Properties editor, custom shortcuts, note export (HTML, PDF via print)
- [x] Connections routed around cards (`route.ts` / `route.rs`), crowded labels on hover
- [x] Timing shape with state lanes (`timing.ts` / `timing.rs`), shape palette with drag and drop
- [x] Copy as Mermaid for sequence and class diagrams; Open as diagram for class diagrams

### M17 — Agent review mode, queries
Done 2026-10-02, released as 0.9.0. Details in the vault note `Architecture/Done.md`.
- [x] Review mode: folder rule "review", proposals in `history.db` (`review.rs`), inbox with diff / accept / reject in the app, `list_proposals` / `withdraw_proposal`
- [x] Queries: frontmatter in the index, query language (`query.rs`), MCP `query`, `mosaic query`, ```query blocks

### M18 — UI comfort
Done 2026-10-04. From the vault note `Architecture/Ideas.md` (UI).
- [x] Note width setting (narrow / medium / wide / full)
- [x] Numbered sublists shown as 2.1, 2.2 (display only)
- [x] Fixed icon bar on the left (sidebar panels, settings)
- [x] Easier splitting: split button in the tab bar, drag a tab to the side
- [x] Table editing in place: cells, Tab / Enter, add or remove rows and columns

### M19 — Calendar view and carry-over
Done 2026-10-04. Decisions in the vault note `Architecture/Next steps.md` §4.
- [x] Core: tasks per day (daily note tasks plus `📅` tasks), carry-over (move, leave `[>]`, unfinished subtasks only)
- [x] Calendar view: month (counts, first tasks) and week (every task, tickable)
- [x] CLI and MCP: tasks by day; carry-over for agents

### M20 — Agents in the vault
Done 2026-10-05. From the vault note `Architecture/Agentic.md`.
- [x] Core: agents from `Agents/` (`Name.md` or `Name/SKILL.md`): name, description, schedule, may-change, instructions
- [x] MCP: every agent as a prompt; `list_agents`; vault guide; CLI `mosaic agents`
- [x] Mirror agents into the vault's `.claude/skills/<name>/SKILL.md`

### M21 — Chat panel
Done 2026-10-06.
- [x] Tauri: run Claude Code headless in the vault (stream-json), continue the session, stop
- [x] Right panel chat: messages, Markdown answers, tool calls as linked lines, open note attached, agent picker and `/name`
- [x] Missing or logged-out Claude Code explained

### M22 — Tessera (scheduled agents)
- [ ] Schedules while the app is open, missed runs at start, run log, Run now, may-change enforced

## Working rules
- `scripts/check.sh` green before each milestone commit.
- Core logic gets Rust tests; UI logic gets Vitest; don't test third-party renderers beyond a smoke test.
- Keep the Tauri layer thin: no business logic outside `mosaic-core`.
