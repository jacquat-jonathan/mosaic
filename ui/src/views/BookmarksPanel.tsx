import { useState, type DragEvent } from "react";
import { Folder, Search } from "lucide-react";
import { baseName, parentOf, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { kindOf } from "../ipc/kinds";
import { displayName, kindIcon } from "./FileTree";
import { openToTheRight, revealInTree } from "../actions";

const BOOKMARK_DRAG = "application/x-mosaic-bookmark";

/** Moves `list[from]` to position `to` (an index in the list before the move). */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to > from ? to - 1 : to, 0, item);
  return out;
}

export function BookmarksPanel() {
  const bookmarks = useVault((s) => s.bookmarks);
  const entries = useVault((s) => s.entries);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const [dropAt, setDropAt] = useState<number | null>(null);

  if (bookmarks.length === 0) {
    return <p className="tree-empty">No bookmarks yet. Right-click a file or folder and choose “Bookmark”, or star a search in the Search panel.</p>;
  }

  const onDrop = (ev: DragEvent, index: number) => {
    const from = Number(ev.dataTransfer.getData(BOOKMARK_DRAG));
    setDropAt(null);
    if (Number.isNaN(from)) return;
    ev.preventDefault();
    void useVault.getState().setBookmarks(reorder(bookmarks, from, index));
  };

  return (
    <div className="tree bookmarks" role="list">
      {bookmarks.map((path, i) => {
        if (path.startsWith("search:")) return <SearchBookmark key={path} entry={path} index={i} dropAt={dropAt} setDropAt={setDropAt} onDrop={onDrop} />;
        const entry = byPath.get(path);
        const missing = !entry;
        const isDir = entry?.is_dir ?? false;
        const kind = isDir ? null : kindOf(path);
        const open = () => {
          if (missing) return;
          if (isDir) revealInTree(path);
          else void useWorkspace.getState().open(path);
        };
        return (
          <div
            key={path}
            role="listitem"
            className={`tree-row ${missing ? "missing" : ""} ${dropAt === i ? "drop-before" : ""}`}
            title={missing ? `${path} (missing: moved outside Mosaic or deleted)` : path}
            draggable
            onDragStart={(ev) => {
              ev.dataTransfer.setData(BOOKMARK_DRAG, String(i));
              ev.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(ev) => {
              if (!ev.dataTransfer.types.includes(BOOKMARK_DRAG)) return;
              ev.preventDefault();
              setDropAt(i);
            }}
            onDragLeave={() => setDropAt((d) => (d === i ? null : d))}
            onDrop={(ev) => onDrop(ev, i)}
            onClick={(ev) => (ev.altKey && !isDir && !missing ? void useWorkspace.getState().open(path, { newTab: true }) : open())}
            onContextMenu={(ev) => {
              ev.preventDefault();
              useUi.getState().showMenu(ev.clientX, ev.clientY, [
                ...(missing
                  ? []
                  : isDir
                    ? [{ label: "Reveal in file tree", action: () => revealInTree(path) }]
                    : [
                        { label: "Open in new tab", action: () => void useWorkspace.getState().open(path, { newTab: true }) },
                        { label: "Open to the right", action: () => void openToTheRight(path) },
                        { label: "Reveal in file tree", action: () => revealInTree(path) },
                      ]),
                { label: "", separator: true },
                { label: "Remove bookmark", action: () => void useVault.getState().toggleBookmark(path) },
              ]);
            }}
          >
            <span className="tree-icon">{isDir ? <Folder size={15} strokeWidth={1.75} /> : kindIcon(kind)}</span>
            <span className="tree-name">{isDir ? baseName(path) : displayName({ name: baseName(path), kind })}</span>
            {parentOf(path) && <span className="bookmark-dir">{parentOf(path)}</span>}
          </div>
        );
      })}
      <div
        className={`bookmark-end ${dropAt === bookmarks.length ? "drop-before" : ""}`}
        onDragOver={(ev) => {
          if (!ev.dataTransfer.types.includes(BOOKMARK_DRAG)) return;
          ev.preventDefault();
          setDropAt(bookmarks.length);
        }}
        onDragLeave={() => setDropAt(null)}
        onDrop={(ev) => onDrop(ev, bookmarks.length)}
      />
    </div>
  );
}

/** A saved search (`search:<query>`): runs it in the Search panel. */
function SearchBookmark({
  entry,
  index,
  dropAt,
  setDropAt,
  onDrop,
}: {
  entry: string;
  index: number;
  dropAt: number | null;
  setDropAt(f: (d: number | null) => number | null): void;
  onDrop(ev: DragEvent, index: number): void;
}) {
  const query = entry.slice("search:".length);
  return (
    <div
      role="listitem"
      className={`tree-row ${dropAt === index ? "drop-before" : ""}`}
      title={`Search: ${query}`}
      draggable
      onDragStart={(ev) => {
        ev.dataTransfer.setData(BOOKMARK_DRAG, String(index));
        ev.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(ev) => {
        if (!ev.dataTransfer.types.includes(BOOKMARK_DRAG)) return;
        ev.preventDefault();
        setDropAt(() => index);
      }}
      onDragLeave={() => setDropAt((d) => (d === index ? null : d))}
      onDrop={(ev) => onDrop(ev, index)}
      onClick={() => useUi.getState().showSearch(query)}
      onContextMenu={(ev) => {
        ev.preventDefault();
        useUi.getState().showMenu(ev.clientX, ev.clientY, [
          { label: "Run search", action: () => useUi.getState().showSearch(query) },
          { label: "", separator: true },
          { label: "Remove bookmark", action: () => void useVault.getState().toggleBookmark(entry) },
        ]);
      }}
    >
      <span className="tree-icon">
        <Search size={15} strokeWidth={1.75} />
      </span>
      <span className="tree-name">{query}</span>
    </div>
  );
}
