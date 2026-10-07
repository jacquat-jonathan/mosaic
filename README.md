# Mosaic

A local-first knowledge base for macOS: very readable for humans, very accessible for AI.

Mosaic opens any folder of plain files (including an existing **Obsidian vault**) and lets you
write, link and visualise your notes: Markdown with live preview, canvases, drawings, charts,
diagrams, HTML pages, PDFs and data files. AI agents (Claude Code, Claude Desktop, any shell agent)
get the same abilities through an **MCP server** and a **`mosaic` command-line tool**, and whatever
they change appears in the app within a second.

Everything stays on your disk as ordinary files. The app makes no network requests, except `git fetch`/`git pull`
of its own source when you click **Check for updates** or **Update** in Settings.

## Getting started

1. Install the prerequisites and run `scripts/install.sh` (see [Install](#install-build-it-yourself)).
2. Open Mosaic and pick a folder: an existing Obsidian vault works as it is, or create a new one.
3. Optional: **Settings › AI** (⌘, or the robot icon) connects Claude Code or Claude Desktop to your vault.
4. To get new versions: **Settings › About & updates › Check for updates** (see [Update](#update)).

## Features

- **Markdown live preview:** formatting renders as you type; wikilinks `[[…]]`, embeds `![[…]]`,
  frontmatter properties, tags, tasks, tables, KaTeX math, and Mermaid, Graphviz and Vega-Lite
  blocks.
- **Visuals:** JSON Canvas boards (`.canvas`, Obsidian's format), Excalidraw drawings
  (`.excalidraw`), charts (`.vl.json`) and graphs (`.dot`).
- **Other files:** sandboxed HTML preview and source editing, a PDF viewer, an editable CSV/TSV
  table, and a syntax-highlighted editor for JSON, YAML, code and text.
- **Navigation:** Notes, Find, Plan and AI destinations; full-text search (`tag:`, `path:`,
  `"phrases"`), bookmarks, tags, the ⌘O quick switcher and the ⌘P command palette. Notes and feature
  views share tabs and split panes; resizable context panels follow the active item.
- **Plan:** Today, month/week/day calendars, tasks and saved task views.
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
- **History and undo:** every change keeps a version (right-click › File history…), and the AI activity
  tab lists what agents changed, with Undo.
- **Safe editing:** deletes go to the macOS Trash; renames update links everywhere. When a file
  changes on disk while you're editing it, Mosaic asks you what to do instead of overwriting.

## Install (build it yourself)

Prerequisites:

- macOS 12 or later.
- Xcode command line tools: `xcode-select --install`.
- Rust: <https://rustup.rs>, or Homebrew `rustup`.
- Node 20 or later.
- pnpm: `corepack enable pnpm`.

```sh
git clone <this repo> mosaic && cd mosaic
scripts/install.sh            # this Mac's architecture
scripts/install.sh --universal  # Apple Silicon + Intel in one app
```

This installs `/Applications/Mosaic.app` and links the `mosaic` command into `~/.local/bin`.

**First launch.** The app is signed ad hoc (there's no Apple Developer ID), which is fine for a build
you made yourself. If you copy the `.app` to another Mac instead of building it there, macOS will
refuse to open it the first time. Right-click the app, choose **Open**, then confirm.

## Connect AI

In the app, open **AI › Connections**. It installs the CLI and
shows the exact commands for your vault. Or set it up by hand:

**Claude Code**

```sh
claude mcp add mosaic -- mosaic mcp
```

Without `--vault`, the server works on the vault open in the Mosaic app and follows when you switch
vaults, so agents always write where you're looking. To tie it to one vault, use
`mosaic --vault "/path/to/vault" mcp`; it then warns the agent when the app shows another vault.

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
drew). Notes are also MCP resources (`mosaic:///Folder/Note.md`). In Settings › AI you can make folders
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
```

The vault is chosen by `--vault`, then `$MOSAIC_VAULT`, then the vault last opened in the app.

## Update

Open **Settings › About & updates** (⌘,). It shows your version, e.g. **Mosaic 0.2.0 (668163f)**.
Mosaic remembers the source folder it was built from; you can point it at another checkout with
**Change…**.

1. **Check for updates** fetches the source and lists the newer versions with what changed in each
   (from `CHANGELOG.md`). The individual commits are listed underneath.
2. **Update** runs `git pull` and `scripts/install.sh --build-only` with a live log. It takes a few
   minutes and you can keep working. **Cancel** stops it at any point.
3. **Restart to finish** saves your notes, swaps in the new build and reopens Mosaic.

Your installed app is only replaced in step 3, so a failed or cancelled build never breaks it.
Updating needs the same tools as installing.

**If an update fails:** the build log in Settings shows the failing step. A common cause is
uncommitted changes in the source folder (`git pull` refuses to run). Commit or stash them, then try
again. If the swap in step 3 fails, Mosaic keeps the old app and says so in Settings; the details are
in `~/Library/Logs/Mosaic/update.log`.

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

**Releasing.** Describe each change under `## Unreleased` in `CHANGELOG.md` as you go, written for
someone using the app. To cut a release, run `scripts/release.sh 0.3.0` on a clean tree: it bumps the
version (workspace `Cargo.toml` and `src-tauri/tauri.conf.json`), turns the Unreleased section into
the release, commits and tags `v0.3.0`. Push with `git push --follow-tags`; coworkers then see it in
**Check for updates**.

The search index lives in `~/Library/Caches/mosaic/` and is rebuilt automatically. Mosaic never
writes anything into your vault except your own content.
