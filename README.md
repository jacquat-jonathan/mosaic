# Mosaic

A local-first knowledge base for macOS: very readable for humans, very accessible for AI.

Mosaic opens any folder of plain files (including an existing **Obsidian vault**) and lets you
write, link and visualise your notes: Markdown with live preview, canvases, drawings, charts,
diagrams, HTML pages, PDFs and data files. AI agents (Claude Code, Claude Desktop, any shell agent)
get the same abilities through an **MCP server** and a **`mosaic` command-line tool**, and whatever
they change appears in the app within a second.

Everything stays on your disk as ordinary files. Mosaic only contacts GitHub when you explicitly
check for or download an update. There is no telemetry, background polling, or vault upload.
Optional Claude features use Claude Code's own connection. A developer-only source updater remains available.

## Getting started

1. [Download the latest release](https://github.com/jacquat-jonathan/mosaic/releases/latest), open its universal `.dmg`, and drag **Mosaic.app** into **Applications**. No build tools are needed.
2. Open Mosaic and pick a folder: an existing Obsidian vault works as it is, or create a new one.
3. Optional: **AI › Connections** connects Claude Code or Claude Desktop. Notes work without AI.
4. To get new versions: **Settings › About & updates › Check for updates** (see [Update](#update)).

## Features

- **Markdown live preview:** formatting renders as you type; wikilinks `[[…]]`, embeds `![[…]]`,
  frontmatter properties, tags, tasks, tables, KaTeX math, and Mermaid, Graphviz and Vega-Lite
  blocks. Type `/` on an empty line to insert headings, lists, tables, code or diagrams.
  Drag a table column boundary to resize neighboring columns while keeping the table width steady;
  widths are remembered in app storage.
- **Visuals:** JSON Canvas boards (`.canvas`, Obsidian's format), Excalidraw drawings
  (`.excalidraw`), charts (`.vl.json`) and graphs (`.dot`).
- **Other files:** sandboxed HTML preview and source editing, a PDF viewer, an editable CSV/TSV
  table, and a syntax-highlighted editor for JSON, YAML, code and text.
- **Navigation:** Notes, Find, Plan and AI destinations; full-text search (`tag:`, `path:`,
  `"phrases"`), bookmarks, tags, the ⌘O quick switcher and the ⌘P command palette. Notes and feature
  views share tabs and split panes; resizable context panels follow the active item.
- **Plan:** Today, month/week/day calendars, tasks, saved task views and a task board.
  Drag cards between New, Blocked, In progress, In QA and Done; subtasks stay grouped under their parent.
- **AI workspace:** automatically saved chats per vault, model choices and attachments; manual,
  scheduled or note-created-event workflows with a guided setup, per-workflow models, allowed
  folders, pause controls, safe event chains and run details.
- **File tree:** drag and drop to move (links follow), ⌘/⇧-click multi-selection, and a right-click
  menu to duplicate, move, copy links or paths and reveal in Finder. Click the vault name to switch
  between recent vaults or create a new one.
- **Import from Finder:** drop files or folders onto the tree to copy them in; drop images into a
  note or onto a canvas to copy them next to it and embed them. Nothing is ever overwritten.
- **Everyday notes:** daily notes from a template (⌘⇧D), paste images straight into a note, unlinked
  mentions with a one-click link, saved searches and structured queries in Bookmarks, a canvas from selected notes.
- **Note templates:** Settings › Templates manages a per-vault Templates folder and inherited folder
  defaults. Every New note action offers Name, Folder and Template with a preview; choose a different
  template or Blank for that note. Markdown starters for meetings, retros, projects, analysis and
  brainstorming are opt-in. `{{title}}`, `{{date}}`, `{{time}}` and `{{weekday}}` are filled at creation.
- **History and undo:** every change keeps a version (right-click › File history…), and the AI activity
  tab lists what agents changed, with Undo.
- **Safe editing:** deletes go to the macOS Trash; renames update links everywhere. When a file
  changes on disk while you're editing it, Mosaic asks you what to do instead of overwriting.

## Install on a Mac

Mosaic supports **macOS 12+ on Intel and Apple Silicon**, with one universal download.

1. Open the [latest release](https://github.com/jacquat-jonathan/mosaic/releases/latest) and download `Mosaic-<version>-universal.dmg` under Assets.
2. Double-click the DMG. Drag **Mosaic.app** onto its **Applications** shortcut.
3. Eject the disk image, then launch Mosaic from Applications. Choose a notes folder or create a vault.

**First-launch warning.** Mosaic is ad-hoc signed, without a paid Apple Developer ID or Apple
notarization. macOS may say it cannot verify the developer or check the app for malicious software.
If you downloaded it from this repository and trust it, try opening it once, then use **System Settings
› Privacy & Security › Open Anyway** for Mosaic and confirm the app-specific prompt. Wording differs
by macOS version. This approval leaves Gatekeeper enabled for other apps.

A warning that the app **contains malware**, **will damage your computer**, or **is damaged** is not
the routine developer-verification warning: stop, delete that download, and report it. Don't disable
Gatekeeper or run quarantine-removal commands. Mosaic does neither automatically.

For command-line use, **AI › Connections › Install** optionally links the bundled CLI into
`~/.local/bin/mosaic`. Add `~/.local/bin` to your shell's PATH if necessary. The app and AI setup work
without that shortcut; MCP instructions use the absolute bundled executable.

### Build it yourself (developers)

Prerequisites:

- macOS 12 or later.
- Xcode command line tools: `xcode-select --install`.
- Rust: <https://rustup.rs>, or Homebrew `rustup`.
- Node 24 or later (the current UI build requires a modern Node runtime).
- pnpm: `corepack enable pnpm`.

```sh
git clone https://github.com/jacquat-jonathan/mosaic.git
cd mosaic
scripts/install.sh            # this Mac's architecture
scripts/install.sh --universal  # Apple Silicon + Intel in one app
```

This installs `/Applications/Mosaic.app` and links the `mosaic` command into `~/.local/bin`.

If tools aren't found, ensure your Node/pnpm and Rust installations are on PATH before building.
Downloaded or transferred builds may need the first-launch approval described above.

## Connect AI

In the app, open **AI › Connections**. It installs the CLI and
shows the exact commands for your vault. Or set it up by hand:

**Claude Code**

```sh
claude mcp add --scope user mosaic -- /Applications/Mosaic.app/Contents/MacOS/mosaic mcp
```

This registers Mosaic privately for your user in **all Claude Code projects**, not just the folder
where you run the command. Start a new Claude session and check `/mcp`. The absolute bundled path
also works when a client doesn't inherit your terminal's PATH. If Mosaic is installed elsewhere,
use the path shown in Connections.

Without `--vault` (and without a `MOSAIC_VAULT` environment override), the server works on the vault
selected in the Mosaic app and follows when you switch vaults, even in already-running sessions
from other projects. When the app is closed, it uses the last selected vault. This is not a network
server: each client starts a local stdio process. To tie it to one vault, use
`mosaic --vault "/path/to/vault" mcp`; it then warns the agent when the app shows another vault.

Existing local/project registrations named `mosaic` override the user registration. Remove or
update those in their original project if they pin a vault. For project-only registration use
`--scope local` instead of `--scope user`; the default when scope is omitted is local.

**Claude Desktop**: add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mosaic": {
      "command": "/Applications/Mosaic.app/Contents/MacOS/mosaic",
      "args": ["mcp"]
    }
  }
}
```

The MCP tools are `vault_guide`, `list_files`, `read_file`, `outline`, `search`, `create_file`,
`edit_file`, `patch_file`, `append_to_file`, `rename`, `copy_file`, `delete_file`, `create_folder`,
`get_backlinks`, `list_tags`, `query` (notes by tag, frontmatter field, date or links), `list_bookmarks`,
`add_bookmark`, `remove_bookmark`, `move_files`, `import_file`, `file_history`, `restore_version`,
`list_proposals`, `withdraw_proposal` and `render` (a PNG of a canvas, so the agent can check what it
drew). Notes are also MCP resources (`mosaic:///Folder/Note.md`). In AI › Connections you can make folders
read-only for agents, hide them, or **review** agents' changes there: edits, new files and deletions wait
under AI activity until you accept or reject them. Edits accept an `expected_hash` so an agent never
overwrites a newer human edit.

**Command line**

```sh
mosaic search "release plan" tag:project
mosaic read Projects/Plan.md
echo "- follow up with design" | mosaic append Inbox.md
mosaic patch Projects/Plan.md --find "Q3" --replace "Q4"
mosaic rename Ideas.md Archive/Ideas.md   # links follow
mosaic copy Template.md Projects/New.md   # never overwrites
mosaic bookmarks add Projects/Plan.md     # shows up in the app's Bookmarks panel
mosaic --json backlinks Projects/Plan.md
mosaic render Architecture.canvas -o map.png   # a canvas as a picture (or .svg)
mosaic history Projects/Plan.md           # versions Mosaic kept; `mosaic restore <path> <id>` puts one back
mosaic activity                           # what agents changed; `mosaic undo <id>` reverts one
mosaic guide                              # conventions for AI agents (docs/AGENTS.md)
mosaic templates --for Meetings/Retro.md   # templates and the inherited folder default
mosaic template render Meetings/Retro.md  # preview without creating a file
mosaic note create Meetings/Retro.md      # create using its default; --template <path> or --blank to override
```

The vault is chosen by `--vault`, then `$MOSAIC_VAULT`, then the vault last opened in the app.

## Update

Open **Settings › About & updates** (⌘,).

1. **Check for updates** reads public GitHub Releases metadata over HTTPS. Only complete, stable
   universal releases with a valid signed manifest are offered; drafts and prereleases are ignored.
2. **Download update** stages the package with progress and Cancel. An embedded Ed25519 public key
   verifies the release manifest, then Mosaic checks the signed checksum, bundle ID, version,
   universal app/CLI architectures and code signature. This free release signature is separate from Apple signing.
3. **Restart to finish** saves your notes, replaces only the installed app, and reopens it. Failed
   swaps roll back; the previous app is retained under a unique hidden `.mosaic-install-*` directory
   beside the installed bundle for recovery. Your vault, settings, history and CLI/MCP path are preserved.

Install into `/Applications` or your own `~/Applications` first. A read-only DMG cannot update
itself, and an unwritable Applications folder requires a manual install or your own Applications folder.
macOS may still request app-specific approval; the updater doesn't remove quarantine. Restart
connected MCP clients afterward to load the new executable.

Versions **0.17 and earlier** use the source updater. Download the first binary-update release
manually (or rebuild once); those older apps don't acquire the new updater just by checking.

**Developer option › source builds** lets you explicitly choose a git checkout and retain pull-and-rebuild
updates, requiring the developer tools above. **Use releases** returns to downloads.

**If an update fails:** inspect the update log in Settings and `~/Library/Logs/Mosaic/update.log`.
Corrupt packages or signature failures never replace the app. An interrupted download is safe to retry.
For manual recovery, copy the retained `Previous.app` back to `Mosaic.app` after quitting Mosaic.

## Personalize Mosaic

Settings contains Appearance (local note/code fonts, size, width, spacing, heading scale, accent,
interface scale/density and preview), Editor (spellcheck, source line numbers, Trash confirmation),
Vault folders, Templates, Calendar & links, Workspace, Shortcuts, and About. Search by a setting's name.
Each field can return to its default; section resets ask first and explain their scope.

App-wide preferences include appearance, week start, link opening, startup and sidebar defaults.
Vault-specific preferences include agents/daily/template folders, new-note and attachment destinations,
daily filenames, generated link syntax, folder colors and startup note. Folder changes affect future
creation/discovery only; they never migrate files. Missing paths can be selected again or explicitly created.
Daily names support `YYYY-MM-DD`, `DD-MM-YYYY` and `YYYYMMDD`, while legacy ISO notes remain recognized.
Date placeholders and task due dates stay ISO. Duplicate daily dates are reported, never overwritten.
Shared vault preferences are readable with `mosaic preferences` and MCP `get_vault_preferences`.

Workflow creation/editing is one page. Schedules and note-created events can coexist; manual Run now
is always available. Changes require review by default. Existing agents retain their identity and
custom source fields; saving configures the workflow without running or unpausing it.

## Develop

```sh
pnpm install
pnpm dev               # run the app with hot reload
scripts/check.sh       # rustfmt, clippy, Rust tests, TypeScript, Vitest
scripts/bench.sh       # search/index performance budgets (5,000 notes)
pnpm --dir ui dev      # UI only, in a browser, against an in-memory mock vault
```

Layout:

| Path | What |
|---|---|
| `crates/mosaic-core` | All vault logic: file access, parser, link resolution, SQLite FTS5 index, watcher, API |
| `crates/mosaic-cli` | The `mosaic` binary: CLI plus `mosaic mcp` |
| `src-tauri` | The desktop app shell (thin commands over the core) |
| `ui` | React + TypeScript UI (CodeMirror 6, React Flow, Excalidraw, Mermaid, Vega-Lite, Graphviz, pdf.js) |
| `docs/AGENTS.md` | Guide for AI agents, also served by the MCP server |
| `docs/PLAN.md` | Implementation plan and milestones |

**Releasing.** Describe changes under `## Unreleased` in `CHANGELOG.md`. On a clean tree,
`scripts/release.sh <new-version>` bumps the shared version, dates the notes, commits and tags it.
Push with `git push --follow-tags`. The release workflow needs the protected
`MOSAIC_RELEASE_PRIVATE_KEY` Actions secret and publishes the complete signed assets after tests.
A Git tag alone is not a downloadable release and will not appear in binary **Check for updates**.
See [publishing from your personal computer](docs/PUBLISHING.md) for the 0.18.0 handoff.

The search index lives in `~/Library/Caches/mosaic/` and is rebuilt automatically. Mosaic never
writes anything into your vault except your own content.
