# Mosaic — implementation plan

Source of truth: `~/Documents/Vaults/Perso/Work/_active/mobsidian/spec.html` (approved 2026-09-30).
This file turns the spec into ordered, checkable work. Tick boxes as work lands; each milestone ends with a commit.

## Fixed decisions

- Product **Mosaic**, bundle id `dev.jona.mosaic`, binary `mosaic` (`mosaic mcp` = stdio MCP server), core crate `mosaic-core`. Repo folder stays `mobsidian`.
- Tauri 2 · Rust (stable) · React 18 + TypeScript + Vite · pnpm · CodeMirror 6.
- Index: SQLite FTS5 via `rusqlite` (bundled), in `~/Library/Caches/mosaic/<vault-hash>/index.db`, WAL mode. Never write inside the vault except user content.
- Ad-hoc signing only. macOS 12+. Universal2 at release.
- Offline: CSP `default-src 'self'`, no updater, no telemetry, every renderer bundled.

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
- [ ] Viewer registry by extension
- [ ] HTML: sandboxed iframe (no scripts, CSP no network) + source tab
- [ ] Images; PDF via pdfjs-dist (worker bundled)
- [ ] CSV: papaparse + TanStack Table, editable cells, byte-identical round-trip when untouched
- [ ] JSON/YAML/code/text: CodeMirror language packs; >5 MB → read-only

### M6 — Visuals (ac-5)
- [ ] JSON Canvas: @xyflow/react; text/file/link/group nodes, edges, colors; save preserves unknown fields
- [ ] Excalidraw `.excalidraw` editor (assets bundled, no CDN fonts)
- [ ] Vega-Lite: fenced `vega-lite` blocks + `.vl.json`, data from relative CSV/JSON
- [ ] Graphviz: fenced `dot` blocks + `.dot` via @viz-js/viz
- [ ] Parse errors inline, never overwrite on error
- [ ] "New note / canvas / drawing / chart" commands

### M7 — CLI + MCP (ac-8)
- [ ] `mosaic` CLI (clap): every api op, `--vault` / `MOSAIC_VAULT` / last vault, `--json`
- [ ] `mosaic mcp`: rmcp stdio server, one tool per api op with JSON schemas
- [ ] `docs/AGENTS.md`: vault conventions, JSON Canvas cheat-sheet, Mermaid/Vega/DOT usage
- [ ] MCP resource or tool exposing the AI guide
- [ ] Integration tests: scripted MCP client + CLI against fixture vault
- [ ] App menu "Install command line tool…" (symlink to /usr/local/bin)

### M8 — Hardening + release (ac-1, ac-10)
- [ ] Offline audit (no outbound requests), perf pass
- [ ] Universal2 release build, `scripts/install.sh` → /Applications
- [ ] README: prerequisites, build/install, Gatekeeper first launch, MCP setup for Claude Code + Desktop

## Working rules
- `scripts/check.sh` green before each milestone commit.
- Core logic gets Rust tests; UI logic gets Vitest; don't test third-party renderers beyond a smoke test.
- Keep the Tauri layer thin: no business logic outside `mosaic-core`.
