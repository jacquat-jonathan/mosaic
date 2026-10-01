# Mosaic

A local-first knowledge base for macOS: very readable for humans, very accessible for AI.

Mosaic opens any folder of plain files (including an existing **Obsidian vault**) and lets you
write, link and visualise your notes: Markdown with live preview, canvases, drawings, charts,
diagrams, HTML pages, PDFs and data files. AI agents (Claude Code, Claude Desktop, any shell agent)
get the same abilities through an **MCP server** and a **`mosaic` command-line tool**, and whatever
they change appears in the app within a second.

Everything stays on your disk as ordinary files. The app makes no network requests, except `git fetch`/`git pull`
of its own source when you click **Check for updates** or **Update** in Settings.

## Features

- **Markdown live preview:** formatting renders as you type; wikilinks `[[…]]`, embeds `![[…]]`,
  frontmatter properties, tags, tasks, tables, KaTeX math, and Mermaid, Graphviz and Vega-Lite
  blocks.
- **Visuals:** JSON Canvas boards (`.canvas`, Obsidian's format), Excalidraw drawings
  (`.excalidraw`), charts (`.vl.json`) and graphs (`.dot`).
- **Other files:** sandboxed HTML preview and source editing, a PDF viewer, an editable CSV/TSV
  table, and a syntax-highlighted editor for JSON, YAML, code and text.
- **Navigation:** full-text search (`tag:`, `path:`, `"phrases"`), backlinks, outline, tags,
  bookmarks, the ⌘O quick switcher, the ⌘P command palette, tabs, split panes and resizable sidebars.
- **File tree:** drag and drop to move (links follow), ⌘/⇧-click multi-selection, and a right-click
  menu to duplicate, move, copy links or paths and reveal in Finder. Click the vault name to switch
  between recent vaults or create a new one.
- **Import from Finder:** drop files or folders onto the tree to copy them in; drop images into a
  note or onto a canvas to copy them next to it and embed them. Nothing is ever overwritten.
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

In the app, click the robot icon in the sidebar (**Connect AI**). It installs the CLI and shows the
exact commands for your vault. Or set it up by hand:

**Claude Code**

```sh
claude mcp add mosaic -- mosaic --vault "/path/to/vault" mcp
```

**Claude Desktop**: add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mosaic": {
      "command": "/Applications/Mosaic.app/Contents/MacOS/mosaic",
      "args": ["--vault", "/path/to/vault", "mcp"]
    }
  }
}
```

The MCP tools are `vault_guide`, `list_files`, `read_file`, `outline`, `search`, `create_file`,
`edit_file`, `patch_file`, `append_to_file`, `rename`, `copy_file`, `delete_file`, `create_folder`,
`get_backlinks`, `list_tags`, `list_bookmarks`, `add_bookmark` and `remove_bookmark`. Edits accept an `expected_hash` so an agent never overwrites a
newer human edit.

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
mosaic guide                              # conventions for AI agents (docs/AGENTS.md)
```

The vault is chosen by `--vault`, then `$MOSAIC_VAULT`, then the vault last opened in the app.

## Update

Open **Settings › About & updates** (⌘,). Mosaic remembers the source folder it was built from:
**Check for updates** fetches it and lists new commits, **Update** runs `git pull` and
`scripts/install.sh --build-only` with a live log, and **Restart to finish** swaps in the new build.
You can point it at another checkout with **Change…**. Updating needs the same tools as installing.

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

The search index lives in `~/Library/Caches/mosaic/` and is rebuilt automatically. Mosaic never
writes anything into your vault except your own content.
