import { useMemo, useRef, useEffect, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import {
  Bookmark,
  ChevronRight,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  PenTool,
  Globe,
  Network,
} from "lucide-react";
import type { Entry, FileKind } from "../ipc/types";
import { parentOf, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi, type MenuItem } from "../state/ui";
import {
  canMoveInto,
  copyText,
  deletePath,
  deletePaths,
  droppedItems,
  duplicatePath,
  importDropped,
  isFinderDrag,
  moveAllInto,
  NEW_KINDS,
  newNote,
  newOfKind,
  openToTheRight,
  pickFolderAndMove,
  renamePath,
  setExpandedDeep,
  wikilinkFor,
} from "../actions";
import { api, openInDefaultApp, revealInFinder } from "../ipc/api";
import { shortcutOf } from "../commands";

const DRAG_TYPE = "application/x-mosaic-path";

export function kindIcon(kind: FileKind | null, size = 15) {
  const p = { size, strokeWidth: 1.75 };
  switch (kind) {
    case "markdown": return <FileText {...p} />;
    case "canvas": return <LayoutDashboard {...p} />;
    case "excalidraw": return <PenTool {...p} />;
    case "html": return <Globe {...p} />;
    case "image": return <FileImage {...p} />;
    case "csv": return <FileSpreadsheet {...p} />;
    case "json": case "yaml": return <FileJson {...p} />;
    case "graphviz": return <Network {...p} />;
    case "code": return <FileCode {...p} />;
    default: return <File {...p} />;
  }
}

/** Display name: Markdown notes are shown without their extension, like Obsidian. */
export function displayName(e: { name: string; kind: FileKind | null }) {
  return e.kind === "markdown" ? e.name.replace(/\.(md|markdown)$/i, "") : e.name;
}

/** Paths being dragged from the tree (the drag data can't be read during dragover). */
let dragging: string[] = [];
const OPEN_ON_HOVER_MS = 600;

export function FileTree() {
  const entries = useVault((s) => s.entries);
  const expanded = useVault((s) => s.expanded);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hoverTimer = useRef<{ dir: string; t: ReturnType<typeof setTimeout> } | null>(null);

  const children = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of entries) {
      const parent = parentOf(e.path);
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent)!.push(e);
    }
    return map;
  }, [entries]);

  const rows: { entry: Entry; depth: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of children.get(dir) ?? []) {
      rows.push({ entry: e, depth });
      if (e.is_dir && expanded.has(e.path)) walk(e.path, depth + 1);
    }
  };
  walk("", 0);
  const order = rows.map((r) => r.entry.path);

  const onRootMenu = (ev: MouseEvent) => {
    if (ev.target !== ev.currentTarget) return;
    ev.preventDefault();
    useVault.getState().clearSelection();
    useUi.getState().showMenu(ev.clientX, ev.clientY, [
      ...newItems(""),
      { label: "", separator: true },
      { label: "Collapse all", action: () => useVault.setState({ expanded: new Set() }) },
      { label: "Reveal vault in Finder", action: () => void revealInFinder("") },
    ]);
  };

  const cancelHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current.t);
    hoverTimer.current = null;
  };

  const drop = (dir: string, openOnHover = false) => ({
    onDragOver: (ev: DragEvent) => {
      const finder = isFinderDrag(ev.dataTransfer);
      if (!finder && !ev.dataTransfer.types.includes(DRAG_TYPE)) return;
      ev.stopPropagation();
      if (!finder && !dragging.some((p) => canMoveInto(p, dir))) {
        ev.dataTransfer.dropEffect = "none";
        setDropTarget(null);
        return;
      }
      ev.preventDefault();
      ev.dataTransfer.dropEffect = finder ? "copy" : "move";
      setDropTarget(dir);
      if (openOnHover && hoverTimer.current?.dir !== dir) {
        cancelHover();
        hoverTimer.current = { dir, t: setTimeout(() => useVault.getState().toggle(dir, true), OPEN_ON_HOVER_MS) };
      }
    },
    onDragLeave: () => {
      setDropTarget((t) => (t === dir ? null : t));
      if (hoverTimer.current?.dir === dir) cancelHover();
    },
    onDrop: (ev: DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      setDropTarget(null);
      cancelHover();
      if (isFinderDrag(ev.dataTransfer)) {
        // Like a new note: the (first) dropped file opens; everything dropped stays selected.
        void importDropped(droppedItems(ev.dataTransfer), dir).then((paths) => {
          const dirs = new Set(useVault.getState().entries.filter((e) => e.is_dir).map((e) => e.path));
          const file = paths.find((p) => !dirs.has(p));
          if (file) void useWorkspace.getState().open(file, { newTab: true });
        });
        return;
      }
      const paths = dragging;
      dragging = [];
      if (paths.length) void moveAllInto(paths, dir);
    },
  });

  const onKeyDown = (ev: KeyboardEvent) => {
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    const vault = useVault.getState();
    const sel = [...vault.selected];
    if (ev.key === "Escape") vault.clearSelection();
    else if (ev.key === "Backspace" && ev.metaKey && sel.length) void deletePaths(sel);
    else if (ev.key === "Enter" && sel.length === 1) vault.setRenaming(sel[0]);
    else if (ev.key === "a" && ev.metaKey) vault.setSelection(order);
    else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      const i = vault.anchor ? order.indexOf(vault.anchor) : -1;
      const next = order[Math.max(0, Math.min(order.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)))];
      if (!next) return;
      vault.select(next, "single");
      document.querySelector(`[data-path="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
    } else return;
    ev.preventDefault();
  };

  return (
    <div
      className={`tree ${dropTarget === "" ? "drop" : ""}`}
      role="tree"
      aria-multiselectable="true"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={(ev) => ev.target === ev.currentTarget && useVault.getState().clearSelection()}
      onContextMenu={onRootMenu}
      onDragEnd={() => {
        dragging = [];
        setDropTarget(null);
        cancelHover();
      }}
      {...drop("")}
    >
      {rows.map(({ entry, depth }) => (
        <TreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          open={expanded.has(entry.path)}
          order={order}
          dropping={dropTarget === entry.path}
          dropProps={entry.is_dir ? drop(entry.path, !expanded.has(entry.path)) : drop(parentOf(entry.path))}
        />
      ))}
      {rows.length === 0 && <p className="tree-empty">This vault is empty. Right-click to create a note.</p>}
    </div>
  );
}

/** "New note / canvas / … / folder" inside `dir`. */
function newItems(dir: string): MenuItem[] {
  return [
    { label: "New note", shortcut: shortcutOf("new-note"), action: () => void newNote(dir) },
    {
      label: "New",
      children: [
        ...NEW_KINDS.filter((k) => k.ext !== "md").map((k) => ({ label: k.label.replace(/^New /, ""), action: () => void newOfKind(dir, k) })),
      ],
    },
    { label: "New folder", shortcut: shortcutOf("new-folder"), action: () => void useVault.getState().newFolder(dir) },
  ];
}

function copyItems(entry: Entry): MenuItem {
  return {
    label: "Copy",
    children: [
      ...(entry.is_dir ? [] : [{ label: "Wikilink", detail: wikilinkFor(entry.path), action: () => void copyText(wikilinkFor(entry.path)) }]),
      { label: "Vault path", detail: entry.path, action: () => void copyText(entry.path) },
      { label: "Absolute path", action: () => void api.absolutePath(entry.path).then(copyText) },
    ],
  };
}

function singleMenu(entry: Entry): MenuItem[] {
  const vault = useVault.getState();
  const bookmarked = vault.bookmarks.includes(entry.path);
  const dir = entry.is_dir ? entry.path : parentOf(entry.path);
  const ws = useWorkspace.getState();
  return [
    ...(entry.is_dir
      ? [
          ...newItems(dir),
          { label: "", separator: true },
          { label: "Expand all", action: () => setExpandedDeep(entry.path, true) },
          { label: "Collapse all", action: () => setExpandedDeep(entry.path, false) },
        ]
      : [
          { label: "Open in new tab", shortcut: "⌥-click", action: () => void ws.open(entry.path, { newTab: true }) },
          { label: "Open to the right", action: () => void openToTheRight(entry.path) },
          { label: "Open in default app", action: () => void openInDefaultApp(entry.path) },
          { label: "", separator: true },
          ...newItems(dir),
        ]),
    { label: "", separator: true },
    { label: bookmarked ? "Remove bookmark" : "Bookmark", action: () => void vault.toggleBookmark(entry.path) },
    copyItems(entry),
    { label: "Reveal in Finder", action: () => void revealInFinder(entry.path) },
    { label: "", separator: true },
    { label: "Rename", shortcut: "↵", action: () => vault.setRenaming(entry.path) },
    ...(entry.is_dir ? [] : [{ label: "Duplicate", action: () => void duplicatePath(entry.path) }]),
    { label: "Move to…", action: () => pickFolderAndMove([entry.path]) },
    { label: "", separator: true },
    { label: "Move to Trash", shortcut: "⌘⌫", danger: true, action: () => void deletePath(entry.path, entry.is_dir) },
  ];
}

function multiMenu(paths: string[]): MenuItem[] {
  const vault = useVault.getState();
  const byPath = new Map(vault.entries.map((e) => [e.path, e]));
  const files = paths.filter((p) => byPath.get(p) && !byPath.get(p)!.is_dir);
  const allBookmarked = paths.every((p) => vault.bookmarks.includes(p));
  return [
    { label: `${paths.length} items selected`, disabled: true },
    { label: "", separator: true },
    ...(files.length
      ? [{ label: `Open ${files.length === 1 ? "file" : `${files.length} files`} in new tabs`, action: () => void openAll(files) }]
      : []),
    { label: allBookmarked ? "Remove bookmarks" : "Bookmark all", action: () => void vault.toggleBookmarks(paths) },
    ...(files.length ? [{ label: "Copy wikilinks", action: () => void copyText(files.map(wikilinkFor).join("\n")) }] : []),
    { label: "", separator: true },
    { label: "Move to…", action: () => pickFolderAndMove(paths) },
    { label: `Move ${paths.length} items to Trash`, shortcut: "⌘⌫", danger: true, action: () => void deletePaths(paths) },
  ];
}

async function openAll(paths: string[]) {
  for (const p of paths) await useWorkspace.getState().open(p, { newTab: true });
}

function TreeRow({
  entry,
  depth,
  open,
  order,
  dropping,
  dropProps,
}: {
  entry: Entry;
  depth: number;
  open: boolean;
  order: string[];
  dropping: boolean;
  dropProps: Record<string, (ev: DragEvent) => void>;
}) {
  const renaming = useVault((s) => s.renaming === entry.path);
  const selected = useVault((s) => s.selected.has(entry.path));
  const bookmarked = useVault((s) => s.bookmarks.includes(entry.path));
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active === entry.path);

  const onClick = (ev: MouseEvent) => {
    const vault = useVault.getState();
    if (ev.metaKey) return vault.select(entry.path, "toggle");
    if (ev.shiftKey) return vault.select(entry.path, "range", order);
    vault.select(entry.path, "single");
    if (entry.is_dir) vault.toggle(entry.path);
    else void useWorkspace.getState().open(entry.path, { newTab: ev.altKey });
  };

  const onMenu = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const vault = useVault.getState();
    const inSelection = vault.selected.has(entry.path) && vault.selected.size > 1;
    if (!inSelection) vault.select(entry.path, "single");
    const items = inSelection ? multiMenu(order.filter((p) => vault.selected.has(p))) : singleMenu(entry);
    useUi.getState().showMenu(ev.clientX, ev.clientY, items);
  };

  return (
    <div
      className={`tree-row ${active ? "active" : ""} ${selected ? "selected" : ""} ${dropping ? "drop" : ""}`}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={entry.is_dir ? open : undefined}
      data-path={entry.path}
      style={{ paddingLeft: 8 + depth * 14 }}
      draggable={!renaming}
      onDragStart={(ev) => {
        const vault = useVault.getState();
        if (!vault.selected.has(entry.path)) vault.select(entry.path, "single");
        dragging = order.filter((p) => useVault.getState().selected.has(p));
        ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging));
        // Dropped into a note, the drag inserts links to the files.
        ev.dataTransfer.setData("text/plain", dragging.map((p) => (p.includes(".") ? wikilinkFor(p) : p)).join("\n"));
        ev.dataTransfer.effectAllowed = "copyMove";
      }}
      onClick={onClick}
      onAuxClick={(ev) => ev.button === 1 && !entry.is_dir && void useWorkspace.getState().open(entry.path, { newTab: true })}
      onContextMenu={onMenu}
      title={entry.path}
      {...dropProps}
    >
      <span className="tree-icon">
        {entry.is_dir ? (
          <ChevronRight size={14} className={open ? "chev open" : "chev"} />
        ) : (
          kindIcon(entry.kind)
        )}
      </span>
      {renaming ? <RenameInput entry={entry} /> : <span className="tree-name">{entry.is_dir ? entry.name : displayName(entry)}</span>}
      {bookmarked && !renaming && <Bookmark size={11} className="tree-mark" aria-label="Bookmarked" />}
    </div>
  );
}
function RenameInput({ entry }: { entry: Entry }) {
  const ref = useRef<HTMLInputElement>(null);
  const shown = displayName(entry);
  const ext = entry.kind === "markdown" ? entry.name.slice(shown.length) : "";
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = entry.is_dir || ext ? -1 : shown.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : shown.length);
  }, [entry.is_dir, ext, shown]);

  const commit = async () => {
    const name = ref.current?.value.trim() ?? "";
    useVault.getState().setRenaming(null);
    if (!name || name === shown) return;
    if (name.includes("/")) {
      useVault.getState().setError("Names can't contain “/”. Drag the item to move it.");
      return;
    }
    const dir = parentOf(entry.path);
    await renamePath(entry.path, (dir ? `${dir}/` : "") + name + ext);
  };

  return (
    <input
      ref={ref}
      className="tree-rename"
      defaultValue={shown}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") ref.current?.blur();
        if (e.key === "Escape") useVault.getState().setRenaming(null);
      }}
    />
  );
}
