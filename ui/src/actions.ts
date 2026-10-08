// User-level actions that touch both the vault tree and open tabs.

import { useUi } from "./state/ui";
import { baseName, joinPath, parentOf, topLevel, uniquePath, useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";
import { kindOf } from "./ipc/kinds";
import { api, pickFolder } from "./ipc/api";
import { errorMessage } from "./ipc/types";
import { displayName } from "./views/FileTree";
import { prefs } from "./state/settings";
import { vaultPrefs } from "./state/vaultPreferences";
import { resolveLink } from "./links";
import { dailyPath, dayStamp, fillTemplate } from "./daily";
import { CALENDAR_TAB } from "./views/specialTabs";

/** Folder for a new note, per Settings › "New notes go in". */
export function newNoteDir(): string {
  const configured = vaultPrefs();
  if (configured.new_note_location === "root") return "";
  if (configured.new_note_location === "folder") return configured.new_note_folder;
  const active = useWorkspace.getState().activePath();
  return active ? parentOf(active) : "";
}

export async function newNote(dir: string, name = "Untitled", newTab = true) {
  const root = useVault.getState().vault?.root;
  if (root) useUi.setState({ newNote: { dir, root, name, newTab }, menu: null, picker: null });
}

export async function newFileOfKind(dir: string, stem: string, ext: string, content: string) {
  const path = await useVault.getState().newFile(dir, stem, ext, content);
  if (path) await useWorkspace.getState().open(path, { newTab: true });
  return path;
}

export async function renamePath(from: string, to: string) {
  const out = await useVault.getState().rename(from, to);
  if (out) useWorkspace.getState().renamed(from, out);
  return out;
}

/** Whether `path` can move into folder `dir` (not already there, not into itself). */
export function canMoveInto(path: string, dir: string): boolean {
  return parentOf(path) !== dir && dir !== path && !dir.startsWith(`${path}/`);
}

export async function moveInto(path: string, dir: string) {
  if (!canMoveInto(path, dir)) return;
  await renamePath(path, dir ? `${dir}/${baseName(path)}` : baseName(path));
}

/** Moves several files and folders into `dir`, one by one (links follow each move). */
export async function moveAllInto(paths: string[], dir: string) {
  for (const p of topLevel(paths)) await moveInto(p, dir);
}

/** "Move to…": pick a destination folder, then move `paths` there. */
export function pickFolderAndMove(paths: string[]) {
  const targets = topLevel(paths);
  const folders = useVault.getState().entries.filter((e) => e.is_dir).map((e) => e.path);
  const allowed = ["", ...folders].filter((d) => targets.some((p) => canMoveInto(p, d)));
  const what = targets.length === 1 ? `“${displayName({ name: baseName(targets[0]), kind: kindOf(targets[0]) })}”` : `${targets.length} items`;
  useUi.getState().openPicker({
    placeholder: `Move ${what} to…`,
    items: allowed.map((d) => ({ id: d, label: d ? baseName(d) : "Vault root", detail: d && parentOf(d) ? parentOf(d) : undefined })),
    hint: "↵ move · esc cancel",
    onPick: (item) => void moveAllInto(targets, item.id),
  });
}

/** Moves several items to the Trash after one confirmation. */
export async function deletePaths(paths: string[]) {
  const targets = topLevel(paths);
  if (targets.length === 0) return;
  if (targets.length === 1) {
    const e = useVault.getState().entries.find((x) => x.path === targets[0]);
    return deletePath(targets[0], e?.is_dir ?? false);
  }
  const ws = useWorkspace.getState();
  const under = (b: string) => targets.some((p) => b === p || b.startsWith(`${p}/`));
  const dirty = Object.values(ws.buffers).some((b) => b.dirty && under(b.path));
  const ok = !prefs().confirmTrash && !dirty ? true : await useUi.getState().ask({
    title: `Move ${targets.length} items to the Trash?`,
    body: "They will be moved to the macOS Trash." + (dirty ? " Some have unsaved changes, which will be lost." : " You can restore them from there."),
    confirmLabel: "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  for (const p of targets) {
    if (!(await useVault.getState().remove(p))) break;
    for (const b of Object.values(useWorkspace.getState().buffers)) {
      if (b.path === p || b.path.startsWith(`${p}/`)) useWorkspace.setState((s) => ({ buffers: { ...s.buffers, [b.path]: { ...b, dirty: false } } }));
    }
    useWorkspace.getState().deleted(p);
  }
  useVault.getState().clearSelection();
}

/** Copies a file next to itself as "Name 1.ext" and starts renaming the copy. */
export async function duplicatePath(path: string) {
  const name = baseName(path);
  const ext = name.toLowerCase().endsWith(".vl.json") ? "vl.json" : name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  const vault = useVault.getState();
  const target = uniquePath(new Set(vault.entries.map((e) => e.path.toLowerCase())), parentOf(path), stem, ext);
  try {
    await api.copy(path, target);
    await vault.refresh();
    vault.setSelection([target]);
    vault.setRenaming(target);
  } catch (e) {
    vault.setError(errorMessage(e));
  }
}

/** The shortest `[[link]]` that resolves to `path`: the bare name unless another file shares it. */
export function wikilinkFor(path: string, from = useWorkspace.getState().activePath() ?? ""): string {
  if (vaultPrefs().link_style === "markdown") {
    const parts = parentOf(from).split("/").filter(Boolean);
    const target = path.split("/");
    while(parts.length && target.length && parts[0] === target[0]) { parts.shift(); target.shift(); }
    const relative = [...parts.map(() => ".."), ...target].map(segment => encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29")).join("/");
    const label = baseName(path).replace(/\.md$/i, "").replace(/[\\[\]]/g, "\\$&");
    return `[${label}](${relative})`;
  }
  const name = baseName(path);
  const md = kindOf(path) === "markdown";
  const bare = md ? name.replace(/\.(md|markdown)$/i, "") : name;
  const clash = useVault.getState().entries.some((e) => !e.is_dir && e.path !== path && e.name.toLowerCase() === name.toLowerCase());
  const target = clash ? (md ? path.replace(/\.(md|markdown)$/i, "") : path) : bare;
  return `[[${target}]]`;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    useVault.getState().setError(`Couldn't copy to the clipboard: ${errorMessage(e)}`);
  }
}

/** Expands the folders above `path`, selects it and scrolls it into view in the file tree. */
export function revealInTree(path: string) {
  const vault = useVault.getState();
  vault.revealParents(path);
  vault.setSelection([path]);
  useUi.getState().setSidebarTab("files");
  requestAnimationFrame(() => document.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" }));
}

/** Expands or collapses a folder and every folder inside it. */
export function setExpandedDeep(dir: string, open: boolean) {
  const vault = useVault.getState();
  const expanded = new Set(vault.expanded);
  for (const e of vault.entries) {
    if (e.is_dir && (e.path === dir || e.path.startsWith(`${dir}/`))) {
      if (open) expanded.add(e.path);
      else expanded.delete(e.path);
    }
  }
  useVault.setState({ expanded });
}

/** Opens a file in a new pane to the right of the focused one. */
export async function openToTheRight(path: string) {
  const ws = useWorkspace.getState();
  ws.split("row");
  await useWorkspace.getState().open(path);
}

export async function openVaultFolder() {
  const path = await pickFolder();
  if (path) await useVault.getState().openVault(path);
}

/** Asks where and under which name, then creates and opens a new, empty vault. */
export async function createVault() {
  const parent = await pickFolder("Choose where to create the new vault");
  if (!parent) return;
  const name = await useUi.getState().askText({ title: "Name of the new vault", value: "", placeholder: "My vault" });
  if (!name?.trim()) return;
  try {
    const vault = await api.createVault(parent, name.trim());
    await useVault.getState().openVault(vault.root);
  } catch (e) {
    useVault.getState().setError(errorMessage(e));
  }
}

export async function deletePath(path: string, isDir: boolean) {
  const ws = useWorkspace.getState();
  const dirty = Object.values(ws.buffers).some(
    (b) => b.dirty && (b.path === path || b.path.startsWith(`${path}/`)),
  );
  const ok = !prefs().confirmTrash && !dirty ? true : await useUi.getState().ask({
    title: `Move “${isDir ? baseName(path) : displayName({ name: baseName(path), kind: kindOf(path) })}” to the Trash?`,
    body:
      (isDir ? "The folder and everything in it will be moved to the macOS Trash." : "The file will be moved to the macOS Trash.") +
      (dirty ? " It has unsaved changes, which will be lost." : " You can restore it from there."),
    confirmLabel: "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  if (await useVault.getState().remove(path)) {
    for (const b of Object.values(useWorkspace.getState().buffers)) {
      if (b.path === path || b.path.startsWith(`${path}/`)) useWorkspace.setState((s) => ({ buffers: { ...s.buffers, [b.path]: { ...b, dirty: false } } }));
    }
    ws.deleted(path);
  }
}

const CHART_TEMPLATE = JSON.stringify(
  {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Edit the data or point data.url at a CSV/JSON file in the vault.",
    data: { values: [ { item: "A", value: 28 }, { item: "B", value: 55 }, { item: "C", value: 43 } ] },
    mark: "bar",
    encoding: { x: { field: "item", type: "nominal" }, y: { field: "value", type: "quantitative" } },
  },
  null,
  2,
);

const GRAPH_TEMPLATE = `digraph G {
  rankdir=LR;
  node [shape=box, style=rounded];
  Idea -> Draft -> Review -> Published;
  Review -> Draft [label="changes"];
}
`;

/** "New …" commands for every kind of file Mosaic can create. */
export const NEW_KINDS = [
  { label: "New note", stem: "Untitled", ext: "md", content: "" },
  // Canvases are created from a diagram template (Blank first).
  { label: "New diagram…", stem: "Diagram", ext: "canvas", content: "" },
  { label: "New drawing", stem: "Drawing", ext: "excalidraw", content: "" },
  { label: "New chart", stem: "Chart", ext: "vl.json", content: CHART_TEMPLATE },
  { label: "New graph (Graphviz)", stem: "Graph", ext: "dot", content: GRAPH_TEMPLATE },
] as const;

export async function newOfKind(dir: string, kind: (typeof NEW_KINDS)[number]) {
  if (kind.ext === "md") return newNote(dir);
  if (kind.ext === "canvas") return newDiagram(dir);
  const { EMPTY_DRAWING } = await import("./viewers/ExcalidrawEditor");
  const path = await newFileOfKind(dir, kind.stem, kind.ext, kind.ext === "excalidraw" ? EMPTY_DRAWING : kind.content);
  if (path) useVault.getState().setRenaming(path);
}

/** Opens today's daily note, creating it (from the template, if one is set) the first time. */
/**
 * Opens a day's daily note (default today), creating it from the template if needed. For today,
 * the unfinished tasks of the last daily note move into it first (carry-over, crates/mosaic-core/src/days.rs).
 */
export async function openDailyNote(d = new Date(), opts: { newTab?: boolean } = {}) {
  const { daily_folder: dailyFolder, daily_template: dailyTemplate, daily_format } = vaultPrefs();
  const existing = (await api.days(dayStamp(d), dayStamp(d), dayStamp())).days[0]?.note;
  const path = existing ?? dailyPath(dailyFolder, d, daily_format);
  const vault = useVault.getState();
  const exists = () => useVault.getState().entries.some((e) => e.path === path);
  let content: string | null = null;
  if (!exists()) {
    let template = "";
    if (dailyTemplate) {
      const t = resolveLink(dailyTemplate, vault.entries, null);
      template = t ? ((await api.read(t)).content ?? "") : "";
      if (!t) vault.setError(`The daily note template “${dailyTemplate}” wasn't found; the note starts empty.`);
    }
    content = fillTemplate(template || "# {{title}}\n\n", d);
  }
  let created = false;
  if (dayStamp(d) === dayStamp()) {
    try {
      created = (await api.carryOver(dayStamp(d), path, content)).created;
    } catch (e) {
      vault.setError(`Unfinished tasks weren't carried over: ${errorMessage(e)}`);
    }
  }
  if (!created && content !== null) {
    try {
      await api.create(path, content);
    } catch (e) {
      // Created meanwhile (another window or an agent): just open it.
      if ((e as { code?: string }).code !== "already_exists") throw e;
    }
  }
  await useWorkspace.getState().open(path, { newTab: opts.newTab ?? false });
}

/** Opens the calendar tab (or shows it if it's open). */
export function openCalendar() {
  void useWorkspace.getState().open(CALENDAR_TAB, { newTab: true });
}

/** A canvas with one file card per file, on a grid of three columns, in selection order. */
export function canvasOfFiles(files: string[], id: () => string): string {
  const cols = Math.min(3, files.length);
  const nodes = files.map((file, i) => ({ id: id(), type: "file", file, x: (i % cols) * 340, y: Math.floor(i / cols) * 280, width: 300, height: 240 }));
  return JSON.stringify({ nodes, edges: [] }, null, "\t");
}

/** "New canvas from selection": the selected files as cards, next to the first one. */
export async function canvasFromFiles(files: string[]) {
  const { newId } = await import("./viewers/canvas/jsonCanvas");
  const path = await newFileOfKind(parentOf(files[0]), "Canvas", "canvas", canvasOfFiles(files, newId));
  if (path) useVault.getState().setRenaming(path);
}

/** "New diagram…": pick a template, then create it in `dir` and start renaming it. */
export async function newDiagram(dir: string) {
  const { DIAGRAM_TEMPLATES } = await import("./diagrams/templates");
  useUi.getState().openPicker({
    placeholder: "New diagram from…",
    items: DIAGRAM_TEMPLATES.map((t) => ({ id: t.id, label: t.label, detail: t.detail })),
    hint: "↵ create · esc cancel",
    onPick: (item) => {
      const t = DIAGRAM_TEMPLATES.find((x) => x.id === item.id)!;
      void newFileOfKind(dir, t.stem, "canvas", t.content).then((path) => path && useVault.getState().setRenaming(path));
    },
  });
}

/** Whether a drag carries files from Finder (as opposed to a drag from the tree or of text). */
export function isFinderDrag(dt: DataTransfer): boolean {
  return dt.types.includes("Files");
}

/** Dropped Finder items. Must be called during the drop event itself: the DataTransfer is emptied once it returns. */
export function droppedItems(dt: DataTransfer): (FileSystemEntry | File)[] {
  const entries = [...dt.items].filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry?.() ?? i.getAsFile());
  return entries.every(Boolean) && entries.length ? (entries as (FileSystemEntry | File)[]) : [...dt.files];
}

const entryFile = (e: FileSystemFileEntry) => new Promise<File>((ok, fail) => e.file(ok, fail));
const readBatch = (r: FileSystemDirectoryReader) => new Promise<FileSystemEntry[]>((ok, fail) => r.readEntries(ok, fail));

/**
 * Copies files and folders dropped from Finder into `dir`. Taken names get " 1", " 2"… (nothing is
 * overwritten); hidden files such as .DS_Store are skipped. Returns the vault paths of the top-level items.
 */
export async function importDropped(items: (FileSystemEntry | File)[], dir: string): Promise<string[]> {
  const vault = useVault.getState();
  const existing = new Set(vault.entries.map((e) => e.path.toLowerCase()));
  const importOne = async (item: FileSystemEntry | File, into: string, top: boolean): Promise<string | null> => {
    if (item.name.startsWith(".")) return null;
    if (item instanceof File || item.isFile) {
      const file = item instanceof File ? item : await entryFile(item as FileSystemFileEntry);
      return (await api.importFile(joinPath(into, file.name), new Uint8Array(await file.arrayBuffer()))).path;
    }
    // Only top-level folders can clash with what's already there; their contents land in a fresh folder.
    const folder = top ? uniquePath(existing, into, item.name, "") : joinPath(into, item.name);
    await api.mkdir(folder);
    const reader = (item as FileSystemDirectoryEntry).createReader();
    for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
      for (const child of batch) await importOne(child, folder, false);
    }
    return folder;
  };
  const out: string[] = [];
  try {
    for (const item of items) {
      const p = await importOne(item, dir, true);
      if (p) out.push(p);
    }
  } catch (e) {
    vault.setError(errorMessage(e));
  }
  await vault.refresh();
  if (dir) vault.toggle(dir, true);
  if (out.length) vault.setSelection(out);
  return out;
}

/** Text that embeds (images, PDFs) or links (anything else) each imported file in a note. */
export function embedsFor(paths: string[], from?: string): string {
  return paths.map((p) => (["image", "pdf"].includes(kindOf(p)) ? "!" : "") + wikilinkFor(p, from)).join("\n");
}
