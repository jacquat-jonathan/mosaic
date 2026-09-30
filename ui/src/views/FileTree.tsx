import { useMemo, useRef, useEffect, useState, type DragEvent, type MouseEvent } from "react";
import {
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
import { deletePath, moveInto, newNote, renamePath } from "../actions";

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

export function FileTree() {
  const entries = useVault((s) => s.entries);
  const expanded = useVault((s) => s.expanded);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

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

  const onRootMenu = (ev: MouseEvent) => {
    if (ev.target !== ev.currentTarget) return;
    ev.preventDefault();
    useUi.getState().showMenu(ev.clientX, ev.clientY, [
      { label: "New note", action: () => void newNote("") },
      { label: "New folder", action: () => void useVault.getState().newFolder("") },
    ]);
  };

  const drop = (dir: string) => ({
    onDragOver: (ev: DragEvent) => {
      if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = "move";
      setDropTarget(dir);
    },
    onDragLeave: () => setDropTarget((t) => (t === dir ? null : t)),
    onDrop: (ev: DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      setDropTarget(null);
      const path = ev.dataTransfer.getData(DRAG_TYPE);
      if (path) void moveInto(path, dir);
    },
  });

  return (
    <div
      className={`tree ${dropTarget === "" ? "drop" : ""}`}
      role="tree"
      onContextMenu={onRootMenu}
      {...drop("")}
    >
      {rows.map(({ entry, depth }) => (
        <TreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          open={expanded.has(entry.path)}
          dropping={dropTarget === entry.path}
          dropProps={entry.is_dir ? drop(entry.path) : drop(parentOf(entry.path))}
        />
      ))}
      {rows.length === 0 && <p className="tree-empty">This vault is empty. Right-click to create a note.</p>}
    </div>
  );
}

function TreeRow({
  entry,
  depth,
  open,
  dropping,
  dropProps,
}: {
  entry: Entry;
  depth: number;
  open: boolean;
  dropping: boolean;
  dropProps: Record<string, (ev: DragEvent) => void>;
}) {
  const renaming = useVault((s) => s.renaming === entry.path);
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active === entry.path);

  const onClick = (ev: MouseEvent) => {
    if (entry.is_dir) useVault.getState().toggle(entry.path);
    else void useWorkspace.getState().open(entry.path, { newTab: ev.metaKey });
  };

  const onMenu = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const dir = entry.is_dir ? entry.path : parentOf(entry.path);
    const items: MenuItem[] = [
      ...(entry.is_dir
        ? []
        : [
            { label: "Open in new tab", action: () => void useWorkspace.getState().open(entry.path, { newTab: true }) },
            { label: "", separator: true },
          ]),
      { label: "New note", action: () => void newNote(dir) },
      { label: "New folder", action: () => void useVault.getState().newFolder(dir) },
      { label: "", separator: true },
      { label: "Rename", action: () => useVault.getState().setRenaming(entry.path) },
      { label: "Move to Trash", danger: true, action: () => void deletePath(entry.path, entry.is_dir) },
    ];
    useUi.getState().showMenu(ev.clientX, ev.clientY, items);
  };

  return (
    <div
      className={`tree-row ${active ? "active" : ""} ${dropping ? "drop" : ""}`}
      role="treeitem"
      aria-expanded={entry.is_dir ? open : undefined}
      style={{ paddingLeft: 8 + depth * 14 }}
      draggable={!renaming}
      onDragStart={(ev) => {
        ev.dataTransfer.setData(DRAG_TYPE, entry.path);
        ev.dataTransfer.effectAllowed = "move";
      }}
      onClick={onClick}
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
