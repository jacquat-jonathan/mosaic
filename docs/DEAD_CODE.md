# Dead code report

Static analysis of the whole repository for unused code. **Nothing was removed or changed**; this file is the only deliverable. Findings come from tooling plus call-site searches. Treat every item as a lead to confirm before removal.

Confidence: **high** = no references anywhere and tooling agrees; **medium** = unreferenced by name or only used in tests/own file/gallery; **low** = likely live through a mechanism that is hard to see, or manual-only.
Risk = risk of breaking something if removed.

## Areas analyzed

| Area | Status | How |
|---|---|---|
| `crates/mosaic-core` | Analyzed | `cargo clippy -W dead_code -W unused` (default, `specta`, all-targets): 0 warnings. Workspace-wide `grep -w` for 620 `pub` items |
| `crates/mosaic-cli` | Analyzed | Same as above |
| `src-tauri` | **Partial (grep only)** | clippy cannot build here: `gdk-sys` needs GTK3 dev libs (`gdk-3.0` pkg-config). Private items not compiler-verified; rerun clippy where GTK3 is installed |
| UI components, hooks, stores, utils, types, exports | Analyzed | `tsc --noUnusedLocals --noUnusedParameters` (0 findings), `knip`, `depcheck`, `ts-prune`, importer-reachability scripts (run on a scratch copy; repo untouched). There is no `ui/src/hooks` directory |
| UI styles | Analyzed | Stylesheet reachability, class-selector and custom-property scan |
| Tauri commands / IPC / events | Analyzed | Definitions (incl. macro-generated), `collect_commands!`, `bindings.ts`, `ui/src/ipc/api.ts`, emit/listen pairs |
| `scripts/` | Analyzed | References from `package.json`, CI, docs, other scripts |
| Dependencies (Cargo + package.json) | Analyzed | Grep fallback for Cargo (`cargo-machete`/`cargo-udeps` not installable: read-only `~/.cargo`); `knip`/`depcheck` for npm |
| Feature flags, config keys, env vars | Analyzed | `[features]`, `tauri.conf.json`, capabilities, tsconfig, biome, vite, settings structs (field check is sample-based) |
| Fixtures and assets | Analyzed | Every file under `fixtures/`, `assets/`, `ui/public/` |
| Docs staleness | Analyzed | 44 repo paths, commands, flags, MCP tool names and test names cited in README/AGENTS/docs |

Not covered: Zustand store members and component props; unused helpers inside `ui/e2e/`; visual verification of CSS removals; per-field check of every Rust struct; contents of `*.canvas` templates and `diagram_format.json`.

## False positives deliberately excluded (do not remove)

- `ErrorShape` (`crates/mosaic-core/src/error.rs:74`) and the `choices` module (`preferences.rs:45-73`): `#[allow(dead_code)]`, exist only for specta TS bindings.
- IPC types used via bindings/events: `SubscriptionView`, `OverlayRange`, `ClaudeInfo`, `TesseraStatus`, `UpdateStatus`, `PlannerChanged`, `IndexProgress`.
- Macro-generated Tauri commands (`epic_lifecycle!`, `task_lifecycle!`, `event_lifecycle!` in `src-tauri/src/planner.rs`): all registered and used.
- `nyc` devDependency (used by `ui/scripts/coverage.sh:41,51`); `tauri` feature `protocol-asset` (needed by `assetProtocol` in `tauri.conf.json`).
- Dynamic CSS classes (`mds-*`, `mode-*`, `status-*`, `resize-*`, `table-*-handle`, `cm-h*`), library-owned classes, and custom properties `--mds-text-faint`, `--ui-font`, `--xy-background-color`, `--xy-node-border-radius`.
- Dynamically imported or invisible consumers: DEV `__mosaic` handle (`ui/src/main.tsx:23-26`), e2e dynamic imports of state/actions modules, `EMPTY_DRAWING`, `DIAGRAM_TEMPLATES`, lazy `ExcalidrawCanvas`/`IconCatalog`.
- Specta feature, capability permissions (`allow-start-dragging` is likely needed by `data-tauri-drag-region`), env vars (`MOSAIC_*`), and the empty `assetProtocol.scope` (scope is added at runtime).

---

## 1. Rust (`mosaic-core`, `mosaic-cli`, `src-tauri`)

Compiler lints found nothing. Because the items below are `pub` in public modules, rustc cannot flag them.

### High confidence
| Location | Symbol | Kind | Evidence | Risk |
|---|---|---|---|---|
| `crates/mosaic-core/src/schedule.rs:120` | `minute_start` | pub fn | Zero references in `crates/`, `src-tauri/`, `ui/` | Low (workspace-internal API) |

### Medium confidence
| Location | Symbol | Kind | Evidence | Risk |
|---|---|---|---|---|
| `crates/mosaic-core/src/api.rs:241` | `Workspace::with_index_file` | assoc fn (test-only) | Only caller `api.rs:2197`, inside the `#[cfg(test)]` module (starts `api.rs:1753`). Could be `#[cfg(test)]` | Low |

**Over-exported (used only inside their defining file; narrow to `pub(crate)`/private).** Not dead, but narrowing lets rustc find real dead code. Medium confidence, low risk:

- `agents.rs:64 slug`, `:147 parse_agent`
- `api.rs:111 FailedLink`, `:131 find_mentions`, `:406 check_read`
- `chat.rs:173 summarize_tool`; `history.rs:18 MAX_BYTES`
- `index.rs:41 SYNC_BATCH`, `:51 SyncBatch`, `:202 default_db_path`
- `links.rs:32 join_relative`; `parse.rs:92 split_wiki_inner`
- `planner/mod.rs:529 current_revision`; `planner/tasks.rs:11 row_to_task`
- `query.rs:35 DEFAULT_LIMIT`, `:36 MAX_LIMIT`, `:108 TaskRow`, `:126 QueryRow`
- `render.rs:70 plain_lines`; `review.rs:103 pending_for`, `:132 proposal_data`, `:537 ReviewService`
- `route.rs:8 Pt`, `:162 simplify`; `settings.rs:159 path_key`
- `templates.rs:9 TemplateRule`, `:102 TemplateResolution`, `:134 TemplateContext`
- `timing.rs:17 Lane`, `:23 Timing`, `:91 tick_step`; `vault_id.rs:23 VaultIdentity`
- `vault_state.rs:21 TESSERA_FILE`, `:47 peek_in`, `:63 in_dir`; `watch.rs:15 DEBOUNCE`, `:26 HEARTBEAT`
- `crates/mosaic-cli/src/mcp.rs:438 MosaicMcp`

(All paths above except the last are under `crates/mosaic-core/src/`.) Some of these (e.g. `TemplateRule`, `Lane`, `Timing`, `FailedLink`, `QueryRow`) also appear as specta/bindings types; check `ui/src/ipc/bindings.ts` before narrowing.

### Unused dependencies and features
None found. Every dependency has at least one source reference (name-based grep; `cargo-machete`/`cargo-udeps` not run). The only feature, `specta` in `mosaic-core`, is used by 17 files and enabled by `src-tauri/Cargo.toml:16`.

### `src-tauri`
No dead symbols found by grep. Private items with two grep hits (e.g. `tessera.rs:537 enqueue_event`, `update/binary.rs:32 Asset`) were not individually traced. **Re-run clippy with GTK3 installed.**

---

## 2. Tauri commands, IPC, events

Every collected command resolves to a definition; every `bindings.ts` key maps to a registered command; all 9 events have matching emit/listen sides.

| Location | Symbol | Kind | Evidence | Conf. | Risk |
|---|---|---|---|---|---|
| `src-tauri/src/lib.rs:595-609` (wrapper `ui/src/ipc/api.ts:99`, binding `bindings.ts:12`) | `set_task_workflow` | command | No production UI caller. Only `ui/src/views/taskBoard.test.ts:48-55` and `ui/src/ipc/mock.behavior.test.ts:208-220`. Core method `api.rs:769` is tested; CLI/MCP don't use it | medium | Medium (may be an unfinished feature) |
| `ui/src/ipc/api.ts:232` | `read_raw` (invoked, undefined in Rust) | command name | Only used when `!inTauri` (`api.ts:217`), handled by `mock.ts:2746`. Browser-mock only | low | Low |

---

## 3. UI (`ui/`)

No unreachable production file: all non-test files under `ui/src` are reachable from `index.html` or `design-system.html`.

### 3a. Dependencies (`ui/package.json`)
| Location | Item | Evidence | Conf. | Risk |
|---|---|---|---|---|
| `ui/package.json:30` | `@lezer/markdown` | No import anywhere; knip and depcheck agree; pulled transitively by `@codemirror/lang-markdown` | high | Low (regenerate lockfile) |
| `ui/package.json:57` | `@types/katex` | `katex` ships its own types; scratch `tsc` passes without it | high | Low |
| `ui/package.json:64` | `@vitest/coverage-v8` | Coverage provider is `istanbul` (`vite.config.ts:85`); no v8 use in scripts/CI | medium | Low-medium (check local `--coverage.provider=v8`) |

### 3b. Zero-reference symbols and dead re-exports (high)
| Location | Symbol | Kind | Risk |
|---|---|---|---|
| `ui/src/views/planner/calendarModel.ts:14` | `DAY_MS` | const | Low |
| `ui/src/diagrams/shapes.tsx:35` | `drawOf` | function | Low |
| `ui/src/ipc/types.ts:10,19,21,40,41,43,45,53,57,63` | `RecentVault`, `Day`, `CarryOver`, `DueMarker`, `DayWorkload`, `IcalImportCandidate`, `IcalImportResult`, `Renamed`, `Release`, `TemplateRule` | type aliases (no importer; `tsc` verifies) | Low |
| `ui/src/editor/widgets.ts:16` | `export { splitRow }` | dead re-export | Low |
| `ui/src/views/AreaSidebar.tsx:17` | `export { ChatList }` | dead re-export (file uses its own import at line 5) | Low |
| `ui/src/design-system/components.tsx:434` | `MenuAction` | export, only via barrel with no consumer (medium) | Low-medium |

### 3c. Exported but used only inside own module (medium; drop `export`, or delete with the in-module use)
`commands.ts:293 openPalette`; `editor/properties.ts:16 kindOf` (distinct from the live `ipc/kinds.ts kindOf`); `editor/selectionToolbar.ts:70 toggleSelectionMark`, `:110 addNoteLink`; `editor/slashMenu.ts:17 insertions`; `editor/tableEdit.ts:13 splitRow`; `editor/blocks.ts:18 registerBlockRenderer`, `:31 addFlowHover` (possible extension points); `state/chat.ts:30 Conversation`, `:66 chatTitle`; `state/settings.ts:8 Theme`, `:10 NoteWidth`, `:12 NOTE_WIDTHS`, `:59 ShortcutKeys`, `:194 applyPrefs`; `state/planning.ts:4 PlanningView`; `state/ui.ts:67 SidebarTab`; `diagrams/timing.ts:9 Lane`, `:15 Timing`, `:70 TimingColors`; `viewers/CsvEditor.tsx:21 detectDelimiter`; `viewers/HtmlViewer.tsx:21-23 HTML_ZOOM_*`; `viewers/MarkdownEditor.tsx:35 editorContextFor`; `views/SearchPanel.tsx:13 Snippet`; `views/taskBoardModel.ts:11 taskKey`; `views/treeAutoScroll.ts:1-2 TREE_AUTO_SCROLL_*`; `views/calendar.ts:6 atNoon` (live copy is in `calendarModel.ts:26`); `views/planner/calendarModel.ts:32 startOfWeek` (live copy `views/calendar.ts:15`, itself test-only); `views/planner/workSessionModel.ts:22 zonedInstant`. Roughly 25 more type-only exports are listed in the analysis notes (low value). Risk: low.

### 3d. Exported only for tests (medium; 38)
Imported only by `*.test.*`: `actions.ts:47 moveInto`, `:342 canvasOfFiles`, `:364 newDiagram`; `editor/queryBlock.ts:41 isTaskQuery`, `:62 querySort`, `:72 sortQuery`, `:100 queryTable`; `viewers/HtmlViewer.tsx` `:25 clampHtmlZoom`, `:29 isLocalHtmlResource`, `:31 resolveHtmlResource`, `:41 htmlPreviewCsp`, `:74 externalHtmlOrigins`, `:102 htmlContentHash`, `:113 htmlScriptPermission`, `:137 embedLocalFetches`, `:171 renderHtmlMermaid`; `export/note.ts` `:51 exportCss`, `:148 noteToHtml`, `:154 exportNoteHtml`, `:167 printNote`; `markdown.ts` `:63 markdownToHtml`, `:83 inlineMarkdownToHtml`; `state/vault.ts` `:35 remapPath`, `:40 rangeBetween`, `:57 isPlannerRecoveryError`; `state/workspace.ts` `:78 migrateLayout`, `:108 AUTOSAVE_MS`; `views/calendar.ts` `:8 addDays`, `:15 startOfWeek`, `:20 monthGrid`, `:25 weekRange`, `:48 counts`; `views/outline.ts` `:47 sectionRange`, `:62 siblingLines`; `views/planner/plannerModel.ts` `:76 descendants`, `:144 subtaskProgress`; `views/taskBoardModel.ts` `:12 workflowState`, `:23 taskGroups`. Not dead (tests cover them) but dead in production. Medium; removal also requires removing tests.

### 3e. Gallery-only design-system components (medium)
`design-system/planning.tsx:258 CalendarLayer`, `:268 CalendarChooser`, `:360 CalendarChip`, `:404 CalendarGrid`, `:426 CalendarDay`, `:457 CalendarSessionMenu`, `:479 TaskTray`, `:519 TaskTrayGroup`, `:543 TaskTrayItem`: used only by `PlanningExamples.tsx` (the `design-system.html` gallery). Risk medium: documented in the design-system README.

### 3f. Generated `ui/src/ipc/bindings.ts` (low)
About 30 generated types have no `B.*` reference or import. Verified list with `ui/src/ipc/bindings.ts` lines: `Access`:163, `AttachmentLocation`:236, `CreatedNote`:342, `DailyFormat`:354, `FailedLink`:449, `FileContent`:454, `Heading`:488, `LinkStyle`:521, `NewNoteLocation`:551, `OutLink`:553, `QueryResult`:685, `QueryRow`:703, `RawRule`:729, `Renamed`:748, `RunTranscript`:777, `TemplateContext`:831, `TemplateEntry`:839, `TemplateResolution`:867, `VaultInfo`:958, `WorkflowAgent`:1039, `Written`:1051 (21 confirmed; the remaining ~9 were not enumerated). File is generated: any fix belongs in the Rust export list (`src-tauri/src/lib.rs` `specta_builder`), not here.

### 3g. CSS
All 60 stylesheets are imported; 80 custom properties all used. **~56 class selectors have no reference** anywhere (medium; low risk, no visual check done):
All in `ui/src/styles.css` (line of first appearance; some only inside compound/grouped selectors):
`board-archived`:2901, `board-card`:2849, `board-card-actions`:2866, `board-column`:2839, `board-group`:2826, `board-group-title`:2829, `board-headings`:2806, `board-lane`:2807, `calendar-cell`:2432, `calendar-chip`:2476, `calendar-counts`:2467, `calendar-day`:2460, `calendar-day-head`:2515, `calendar-empty`:2539, `calendar-error`:2394, `calendar-month`:2411, `calendar-overdue`:2397, `calendar-selection`:2644, `calendar-sources`:3816, `calendar-week`:2497, `calendar-weekday`:2423, `commit-details`:1791, `commit-list`:1781, `connecting`:1447, `diff-sign`:1129, `epic-drag-active`:2936, `epic-drop-before`:2943, `event-archive`:4004, `event-archive-list`:4025, `ical-import`:3815, `ical-import-list`:3846, `ok-text`:1806, `warn-text`:1801, `parent-task`:2863, `pdf-meta`:1268, `plain-editor`:291, `planner-card`:2991, `planner-card-meta`:3015, `planner-export`:3980, `planner-history-dialog`:3962, `planner-lane`:2911, `planner-lane-drag`:2977, `planner-lane-title`:2948, `range-value`:1763, `setting-control`:1683, `setting-label`:1671, `setting-reset`:4086, `settings-lede`:1649, `settings-note`:1654, `tessera-answer`:2544, `toolbar-error`:1335, `unscheduled-epic`:3788, `workspace-heading`:2606.

Other files: `ui/src/views/connectionsSettings.css:94 connection-settings-entry`; `ui/src/views/planner/calendarDesign.css:68 planner-all-day-label`; `ui/src/editor/editorControls.css:99 cm-slash-detail`.

---

## 4. Scripts and package.json scripts

| Location | Item | Evidence | Conf. | Risk |
|---|---|---|---|---|
| `package.json:7` | script `build:debug` | Referenced nowhere (docs, CI, scripts) | low-medium | Low |
| `scripts/bench.sh` | script | Only README:256, docs/PLAN.md:92, comment `index.rs:1410`; not in CI/package.json; target tests are `#[ignore]` | low | Low (manual tool) |
| `scripts/check-ui.sh` | script | Called by `check.sh` and `.claude/agents/tests.md`; CI runs pnpm commands directly | low | Low |
| `scripts/create-release-key.mjs` | script | Only `docs/PUBLISHING.md:206` (documented manual step) | low | Medium (key bootstrap) |
| `package.json:8` / `assets/icon.png` | script `icons` | Only consumer of `assets/icon.png`; outputs referenced by `tauri.conf.json:41-45` | low | Medium (breaks `pnpm icons`) |

All other scripts are referenced by CI, other scripts, or docs.

## 5. Fixtures, assets, config, feature flags

| Location | Item | Evidence | Conf. | Risk |
|---|---|---|---|---|
| `fixtures/vault/data.csv` | fixture | No explicit reference (only a generic example at `docs/AGENTS.md:121`); picked up implicitly by whole-vault copies | medium | Medium (may change file counts in whole-vault tests; unverified) |
| `ui/tsconfig.json`, `ui/biome.json` | config gap (not dead code) | `ui/test/coverage.ts` and `vite.design-system.config.ts` are not type-checked/linted | low | n/a |

Other fixtures (`links.json`, `contract.json`, `Home.md`, `Board.canvas`, `Ideas.md`, `Daily/…`, `Projects/Mosaic/Plan.md`, `Attachments/diagram.png`, `.obsidian/app.json`) are referenced by tests. `ui/public/icon.png` is used by `Welcome.tsx:49`. No unused feature flags, `tauri.conf.json` keys, capability permissions or `MOSAIC_*` env vars were found; settings/preferences struct fields were spot-checked (all read).

## 6. Stale docs references

| Location | Reference | Evidence | Conf. | Risk |
|---|---|---|---|---|
| `docs/PLANNER_ACCEPTANCE.md:11` | test `opening_a_pre_planner_vault_and_previewing_migration_never_changes_markdown` | Real test is `opening_a_pre_planner_vault_and_board_never_changes_markdown` (`crates/mosaic-core/src/planner/tests.rs:712`) | high | None |
| `docs/PLANNER_ACCEPTANCE.md:13` | test `markdown_import_previews_maps_and_deduplicates_without_editing_notes` | No such test in the repo | high | None |
| `docs/PLANNER_ACCEPTANCE.md` | whole file | No inbound link from README, PLAN.md or elsewhere | medium | Low |
| `ui/src/design-system/README.md:132` | mentions removed `Personalization.tsx` | Historical note only | low | None |

Everything else checked in docs (paths, `pnpm` commands, `mosaic` subcommands/flags, MCP tool names, release flags) exists. `ui/coverage` and `ui/dist` are gitignored build outputs, not stale.

---

## Summary

| Area | High | Medium | Low | Total |
|---|---:|---:|---:|---:|
| Rust crates | 1 | 39 (1 test-only + 38 over-exported) | 0 | 40 |
| `src-tauri` | 0 | 0 | 0 | 0 (grep only) |
| IPC / commands | 0 | 1 | 1 | 2 |
| UI dependencies | 2 | 1 | 0 | 3 |
| UI symbols / exports / re-exports | 14 | 29 in-module + 9 gallery-only + `MenuAction` (+38 test-only, counted separately in 3d) | ~30 (generated bindings types) | ~83 |
| UI CSS selectors | 0 | ~55 | 0 | ~55 |
| Scripts | 0 | 0 | 5 | 5 |
| Fixtures / assets / config | 0 | 1 | 1 | 2 |
| Docs | 2 | 1 | 1 | 4 |

("High" UI symbols = `DAY_MS`, `drawOf`, 10 type aliases, 2 dead re-exports = 14. Medium = 29 named in-module exports (3c; excludes ~25 unlisted type-only exports) + 9 gallery-only components + `MenuAction` = 39. Low = ~30 generated types. Total ~83; counts marked ~ are approximate.)

## Recommended removal order

1. **Docs fixes** (no code risk): correct the two stale test names in `docs/PLANNER_ACCEPTANCE.md`, and link or drop that file.
2. **UI dependencies**: drop `@lezer/markdown`, `@types/katex`; regenerate `pnpm-lock.yaml`; run `tsc` and unit tests.
3. **UI zero-reference items**: `DAY_MS`, `drawOf`, 10 `ipc/types.ts` aliases, 2 dead re-export lines (verified by `tsc`).
4. **Rust**: remove `minute_start`; mark `with_index_file` `#[cfg(test)]`.
5. **Narrow visibility**: Rust over-exports to `pub(crate)` (after checking bindings use) and UI in-module exports; then re-run clippy/knip to surface newly dead code. Re-run clippy on `src-tauri` with GTK3 installed.
6. **CSS selectors**: remove in small batches with a visual/e2e check.
7. **Decide on product intent**: `set_task_workflow`, gallery-only planning components, `@vitest/coverage-v8`, `build:debug`, `data.csv`, test-only exports. These need a maintainer decision; they may be intentional.
8. **Leave alone**: generated `bindings.ts` (fix via the Rust export list), manual scripts (`bench.sh`, `create-release-key.mjs`), and the false positives listed above.
