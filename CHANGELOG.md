# Changelog

What changed in each version of Mosaic. Settings › About & updates shows the sections newer than the installed app, so write each line for someone using the app. New work goes under **Unreleased**; `scripts/release.sh <version>` turns that section into a release.

## Unreleased

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
