# M29 — Note templates: specification and implementation plan

Status: **Accepted and implemented — released as 0.17.0.**
Date: 2026-10-08. Baseline: Mosaic 0.16.1.

## Purpose

Make meeting and project notes easy to create with a consistent structure, and let AI agents
produce analysis, brainstorming and other reports using the same templates.

Example: Settings maps `Meetings/Retros/` to `Templates/Retro.md`. Creating a note in that folder
preselects Retro and starts the note with its headings and properties. The person can choose
another template or Blank for that particular note.

## Agreed requirements

- Templates are ordinary Markdown files in a configurable Templates folder.
- Folder defaults are configured **only in Settings**; no folder context-menu configuration.
- Every ordinary new-note flow offers a template choice, with the applicable default selected.
- Subfolders inherit defaults; the most specific matching folder wins.
- A person can override the default for one note, including choosing Blank.
- Templates can contain title/date placeholders.
- AI reports use the same templates and folder defaults. Agent instructions describe how to
  investigate; the template describes the report's output structure.
- Apply a template during creation, before note-created workflows run.
- Focus on meetings, projects and AI reports. Daily-note changes are outside this milestone;
  existing daily-note behavior remains supported.

The user accepted this specification on 2026-10-08. The behaviors below are implemented.

## Settings › Templates

Add a dedicated Templates section with settings scoped to the current vault:

1. **Templates folder:** vault-folder picker, initially `Templates/`. Show missing-folder status
   and an explicit Create folder action. Selecting a location alone does not create files.
2. **Available templates:** discover Markdown files recursively, showing filename and relative
   subfolder to disambiguate names. Open a template in the ordinary editor to change it.
3. **Folder defaults:** rows with a destination-folder picker and a template picker. Each row can
   select a template or **Blank**, and can be removed. Removing a row restores inheritance;
   selecting Blank explicitly stops inheritance for that folder and its descendants.
4. **Starter templates:** an explicit Add starter templates action creates editable Meeting,
   Retro, Project, Analysis and Brainstorm notes. Preview them first; report existing names and
   never overwrite them. The app does not install or assign starters automatically.

The vault root may have a default. Each folder has at most one rule. The UI explains inheritance
and shows missing references. Defaults can target only templates inside the configured folder.
Notes created inside the Templates folder always start Blank by default, so template authoring
does not accidentally use a destination rule; an explicit template choice is still allowed.

## New note dialog

Route ⌘N, the command palette, file-tree New note, and other ordinary New note buttons through one
dialog. Fields: **Name**, **Folder**, **Template**, followed by a read-only preview and Create/Cancel.

- Start in the destination selected by the invoking action and the existing New notes go in
  preference. Keep folder context from a file-tree action.
- Preselect the applicable folder default, or Blank if none exists.
- Recompute the default when Folder changes until the person explicitly chooses a template.
  After an explicit choice, retain it across folder changes; offer Use folder default to return
  to automatic selection.
- Show why a template was chosen, e.g. “Retro · default from Meetings/Retros”.
- Search templates by name/path; Blank is always available. Preview updates with Name/Template.
- Creation uses the final filename for `{{title}}`, not a temporary Untitled name.
- Normalize a single `.md` suffix, reject invalid names, and show filename collisions before
  creation. A concurrent collision keeps the dialog open with a useful error; suggest another
  name rather than silently changing the title.
- Cancel creates nothing. On success, open the note and focus its editor.
- Keep keyboard operation, focus trapping, accessible field labels and compact-window layout.

## Resolution rules

| Selection for a note | Result |
| --- | --- |
| Explicit template | Use that template, overriding folder defaults |
| Explicit Blank | Create an empty note |
| Use folder default | Use the longest matching ancestor-folder rule |
| Nearest rule is Blank | Create an empty note; stop inheritance |
| No rule exists | Create an empty note |

Use validated vault-relative paths and actual directory boundaries: `Meetings/Retro/` must not
match `Meetings/Retrospective/`. Apply the vault's existing path/case conventions consistently.
Never combine multiple templates or parent rules.

If the chosen template is missing, unreadable, invalid UTF-8 or no longer in the configured
Templates folder, keep the dialog open with an actionable error. A broken nearest rule does not
silently fall back to another template; the person can explicitly choose a replacement or Blank.

Defaults govern intentional Markdown-note creation through Mosaic's template-aware interface.
Imports, copies, duplicates, moves, external creations and existing-note edits preserve supplied
content. The file watcher observes creations; it does not fill templates after the fact.

## Template format and rendering

Use the saved Markdown source exactly, including frontmatter, links, tasks and code blocks.
There is no template-specific metadata added to the created note.

First-version placeholders, with optional whitespace inside braces:

| Placeholder | Value |
| --- | --- |
| `{{title}}` | Final note filename without `.md` |
| `{{date}}` | Creation date, `YYYY-MM-DD` |
| `{{time}}` | Creation time, `HH:mm` |
| `{{weekday}}` | English weekday, matching current daily-template behavior |

Render all values from one creation timestamp in the caller's local timezone. Preview and Create
share that timestamp; a changed source template requires a refreshed preview. Title substitutions
are literal, so authors should quote YAML values appropriately. Unknown placeholders remain
unchanged. No execution, expressions, includes, loops or custom variable prompts in this version.

Core rendering takes explicit title and timestamp values so tests are deterministic. Extend or
share the existing daily-placeholder behavior without changing its date-based title semantics.
Applying a template makes an independent copy; future template edits affect future notes.

## AI, CLI and MCP

Store configuration in the shared per-vault settings, outside the vault content, so agents and
the desktop agree. UI-only localStorage is insufficient for this feature.

Implemented interfaces over the same core service:

- `list_templates`: list readable template paths and names. With an optional destination note
  path, include its effective default and the rule it came from.
- `render_template`: accept the destination note path and selection (default, blank or explicit
  template). Return rendered content, template path/hash when applicable, resolution provenance
  and the placeholder context. This previews an output; it does not write a file.
- `create_note`: create a Markdown note with that selection and an optional expected template
  hash from its preview. Return the normal write/proposal result and template provenance.
- CLI equivalents: `mosaic templates [--for <note-path>]`,
  `mosaic template render <note-path> [--template <path> | --blank]`, and
  `mosaic note create <note-path> [--template <path> | --blank]`. Omitting the selection uses the
  folder default. Rendering and creation also accept `--timestamp` and `--expected-template-hash`
  to preserve preview context and reject a changed source.

For an AI report: resolve/render the selected template, investigate according to the agent's
instructions, fill the report's sections, then create the complete content through the existing
`create_file` operation. Expose templates in the vault guide so agents know to consult defaults
when producing a new report and honor an explicit user template choice. A template supplies a
structure; it does not constrain or verify the quality of an agent's reasoning.

Keep existing `create_file`/`mosaic create` semantics: caller-supplied content is stored as supplied.
Use `create_note` for automatic initialization from a default or chosen template. This separates
creating a scaffold from saving a completed report and preserves existing integrations.

All new operations obey existing template-read and destination-write permissions. Discovery
omits hidden templates; direct requests cannot bypass hidden access. Review-folder creations
produce a proposal containing the rendered note. Scheduled/event runs retain `may-change`
restrictions. Reading a source template never grants permission to modify it or its output folder.
Agents can read defaults but do not receive a tool to configure them.

## Persistence, renames and workflow ordering

Add a versioned per-vault template configuration to the existing shared Settings structure:
configured folder and a list of destination-folder rules with template-or-Blank values. Preserve
unrelated settings and use the current atomic save behavior. Validate configuration in the core;
malformed or unsupported configuration must produce a visible error rather than selecting an
unexpected template. Saving one vault's configuration must not affect another vault.

Renames performed through Mosaic update configured template paths, the Templates folder and
destination rules alongside existing reference updates. External renames/deletions are detected
as missing references and repaired in Settings; do not guess a replacement from its filename.

Resolve and render first, then perform one normal atomic create. History records one creation
with the correct actor, and indexing sees the complete initial content. A note-created workflow
must never receive the temporary empty scaffold; preserve existing event coalescing and avoid
duplicate workflow runs. Proposal acceptance uses the existing creation-event behavior.

## Starter outlines

| Template | Suggested sections |
| --- | --- |
| Meeting | Date, participants, purpose, agenda, notes, decisions, actions |
| Retro | Context, what went well, what to improve, themes, agreed actions |
| Project | Purpose, outcomes, scope, stakeholders, milestones, decisions, risks, next actions |
| Analysis | Question, context, evidence, assumptions, options, recommendation, open questions |
| Brainstorm | Prompt, constraints, ideas, themes, promising directions, next experiments |

Keep starters short and editable. They contain no fabricated facts or agent execution instructions.
Existing task syntax remains usable inside them; no daily-note starter is part of this milestone.

## Implementation sequence

1. **Core and settings:** add `templates.rs`, per-vault configuration, discovery, inheritance,
   deterministic rendering and template-aware creation. Integrate permissions, review, history
   and reference updates. Keep Tauri thin.
2. **App settings:** typed IPC, mock-vault support, Settings › Templates, folder/default pickers,
   source opening, missing-reference states and optional starters.
3. **Creation dialog:** replace ordinary immediate empty-note creation with the shared flow;
   preview/hash handling, explicit overrides, blank choice, final-name rendering and focus.
4. **Agent access:** CLI/MCP discovery, rendering and creation, schemas and vault-guide updates;
   update chat tool summaries/change tracking for the new operations and verify an analysis-report
   scenario using a folder default.
5. **Acceptance and release readiness:** focused tests, full repository check, production UI
   and native builds, browser/native smoke checks, README and user-facing changelog. Update
   Ideation with actual decisions and verification at the end, distinguishing implemented work
   from a published release.

Relevant existing touchpoints: `crates/mosaic-core/src/settings.rs`, `api.rs`, `chat.rs`, `watch.rs`;
`crates/mosaic-cli/src/main.rs` and `mcp.rs`; `src-tauri/src/lib.rs`; `ui/src/actions.ts`,
`daily.ts`, `state/vault.ts`, `state/ui.ts`, `views/Settings.tsx`, `views/FileTree.tsx`,
`commands.ts` and `ipc/`; `docs/AGENTS.md`.

## Acceptance criteria

- [x] Settings is the sole folder-default configuration surface; configuration is per vault.
- [x] Creating a Retro note preselects Retro, renders the final name/date and opens a complete note.
- [x] All ordinary New note entry points offer the same template choice and Blank option.
- [x] Inheritance, a more-specific override, root default and explicit Blank stop behave as specified.
- [x] Folder changes update automatic defaults while preserving an explicit per-note choice.
- [x] Cancel, invalid names, collisions, missing templates and stale previews create no partial notes.
- [x] Editing a template affects the next note, preserving notes already created from it.
- [x] Template/default changes are available consistently to the app, CLI and MCP after vault switching.
- [x] Hidden/read-only/review rules and scheduled-run restrictions remain enforced end to end.
- [x] AI can render an Analysis default and save a completed report with that structure.
- [x] Renames through Mosaic follow references; external deletions show repairable errors.
- [x] Imports, duplicates and external files preserve their original content.
- [x] Creation history and workflow triggers observe complete initial content, once.
- [x] Existing daily notes and raw create APIs retain their established behavior.
- [x] Starters are opt-in and never overwrite files; dialog/settings pass keyboard and compact-layout checks.
- [x] Core and UI regression tests, full release gate and production/native builds pass.

## Verification and release status

Implemented after user acceptance on 2026-10-08. `scripts/check.sh` passes: 115 Rust tests
(two opt-in benchmarks ignored), 148 UI tests, Rust formatting/clippy and TypeScript checks.
Production UI and universal arm64/x86_64 macOS builds pass; the bundle's ad-hoc signature verifies.
Browser smoke checks cover Settings, starter installation, inherited Retro previews, explicit
overrides, Blank, collisions, quick-switch creation, cancellation, focus trapping and a 700×600
window without horizontal overflow. Native smoke testing in an isolated temporary vault creates
a fully rendered Retro note and opens it with editor focus; the bundled CLI reads the same content.

Template-aware creation delegates to the existing atomic create/review pipeline; it does not add
a watcher-based scaffold fill or a second creation event. Existing event/review/scheduled-permission
regressions remain green alongside template-specific core, CLI and MCP tests.

Released as 0.17.0 (`v0.17.0`) on 2026-10-08 after the user requested release and push.
The release does not replace the installed app; install or update explicitly when ready.
