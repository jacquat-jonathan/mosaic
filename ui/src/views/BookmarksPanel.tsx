import { useEffect, useRef, useState, type DragEvent } from "react";
import { Folder, ListFilter, MoreHorizontal, Plus, Search } from "lucide-react";
import { baseName, parentOf, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi, type MenuItem } from "../state/ui";
import { kindOf } from "../ipc/kinds";
import { displayName, kindIcon } from "./FileTree";
import { openToTheRight, revealInTree } from "../actions";
import { viewPath } from "./specialTabs";
import { api } from "../ipc/api";
import { errorMessage } from "../ipc/types";
import { Button, IconButton, Notice } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./bookmarksPanel.css";

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
  const root = useVault((s) => s.vault?.root);
  const active = useWorkspace((s) => s.activePath());
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const saveButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const menu = useUi((s) => s.menu),
    prompt = useUi((s) => s.prompt);
  const current = () => mounted.current && useVault.getState().vault?.root === root;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!busy && !menu && !prompt && opener.current) {
      (opener.current.isConnected ? opener.current : saveButton.current)?.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [busy, menu, prompt]);
  const act = async (work: () => Promise<unknown>) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (cause) {
      if (current()) setProblem(errorMessage(cause));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const persist = async (paths: string[]) => {
    if (!current()) return;
    await api.setBookmarks(paths);
    if (current()) useVault.setState({ bookmarks: paths });
  };
  const saveQuery = () =>
    act(async () => {
      const query = await useUi
        .getState()
        .askText({ title: "Save a query", value: "", placeholder: "tag:project status=active OR priority>2" });
      if (!query?.trim() || !current()) return;
      const value = query.trim();
      await api.query(value);
      if (!current()) return;
      const vault = useVault.getState(),
        key = `query:${value}`;
      if (!vault.bookmarks.includes(key)) await persist([...vault.bookmarks, key]);
    });
  const move = (from: number, to: number) =>
    act(async () => {
      const list = useVault.getState().bookmarks;
      if (!Number.isInteger(from) || from < 0 || from >= list.length || to < 0 || to > list.length) return;
      await persist(reorder(list, from, to));
    });
  const onDrop = (event: DragEvent, index: number) => {
    setDropAt(null);
    if (!event.dataTransfer.types.includes(BOOKMARK_DRAG)) return;
    event.preventDefault();
    const value = event.dataTransfer.getData(BOOKMARK_DRAG);
    if (value !== "") void move(Number(value), index);
  };
  const dragOver = (event: DragEvent, index: number) => {
    if (busy || !event.dataTransfer.types.includes(BOOKMARK_DRAG)) return;
    event.preventDefault();
    setDropAt(index);
  };
  return (
    <DesignSystemScope className="bookmarks-panel" role="group" aria-label="Bookmarks" aria-busy={busy}>
      <Button
        variant="secondary"
        ref={saveButton}
        disabled={busy}
        onClick={(event) => {
          opener.current = event.currentTarget;
          void saveQuery();
        }}
      >
        <Plus aria-hidden="true" /> Save query…
      </Button>
      {problem && (
        <Notice tone="error">
          {problem}
          <Button onClick={() => setProblem(null)}>Dismiss</Button>
        </Notice>
      )}
      {bookmarks.length === 0 && (
        <p className="mds-hint">
          No bookmarks yet. Right-click a file or folder, star a search, or save a structured query.
        </p>
      )}
      <div role="list" aria-label="Saved bookmarks" className="bookmarks-list">
        {bookmarks.map((path, index) => {
          const search = path.startsWith("search:"),
            query = path.startsWith("query:");
          const entry = entries.find((item) => item.path === path);
          const missing = !search && !query && !entry,
            isDir = entry?.is_dir ?? false;
          const kind = isDir ? null : kindOf(path);
          const label = search
            ? path.slice(7)
            : query
              ? path.slice(6)
              : isDir
                ? baseName(path)
                : displayName({ name: baseName(path), kind });
          const title = search
            ? `Search: ${label}`
            : query
              ? `Query: ${label}`
              : missing
                ? `${path} (missing: moved outside Mosaic or deleted)`
                : path;
          const open = (newTab = false) => {
            if (missing) return;
            if (search) useUi.getState().showSearch(label);
            else if (query) void act(() => useWorkspace.getState().open(viewPath("query", label)));
            else if (isDir) revealInTree(path);
            else
              void act(() =>
                newTab ? useWorkspace.getState().open(path, { newTab: true }) : useWorkspace.getState().open(path),
              );
          };
          const items = (): MenuItem[] => [
            ...(search
              ? [{ label: "Run search", action: () => open() }]
              : query
                ? [{ label: "Run query", action: () => open() }]
                : missing
                  ? []
                  : isDir
                    ? [{ label: "Reveal in file tree", action: () => revealInTree(path) }]
                    : [
                        { label: "Open in new tab", action: () => open(true) },
                        { label: "Open to the right", action: () => void act(() => openToTheRight(path)) },
                        { label: "Reveal in file tree", action: () => revealInTree(path) },
                      ]),
            { label: "", separator: true },
            { label: "Move up", disabled: index === 0, action: () => void move(index, index - 1) },
            { label: "Move down", disabled: index === bookmarks.length - 1, action: () => void move(index, index + 2) },
            {
              label: "Remove bookmark",
              action: () => void act(() => persist(useVault.getState().bookmarks.filter((item) => item !== path))),
            },
          ];
          return (
            <div
              key={path}
              role="listitem"
              className={`bookmark-item ${dropAt === index ? "drop-before" : ""}`}
              draggable={!busy}
              onDragStart={(event) => {
                event.dataTransfer.setData(BOOKMARK_DRAG, String(index));
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => dragOver(event, index)}
              onDragLeave={() => setDropAt((value) => (value === index ? null : value))}
              onDrop={(event) => onDrop(event, index)}
              onDragEnd={() => setDropAt(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!busy) {
                  opener.current = event.currentTarget.querySelector<HTMLButtonElement>(".bookmark-actions");
                  useUi.getState().showMenu(event.clientX, event.clientY, items());
                }
              }}
            >
              <Button
                className={`bookmark-open ${missing ? "missing" : ""}`}
                title={title}
                disabled={busy || missing}
                aria-current={active === (query ? viewPath("query", label) : path) ? "page" : undefined}
                onClick={(event) => open(event.altKey && !isDir)}
                onKeyDown={(event) => {
                  if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                    event.preventDefault();
                    opener.current = event.currentTarget;
                    if (
                      (event.key === "ArrowUp" && index > 0) ||
                      (event.key === "ArrowDown" && index < bookmarks.length - 1)
                    )
                      void move(index, event.key === "ArrowUp" ? index - 1 : index + 2);
                  }
                }}
              >
                <span className="bookmark-icon" aria-hidden="true">
                  {search ? <Search /> : query ? <ListFilter /> : isDir ? <Folder /> : kindIcon(kind, 16)}
                </span>
                <span className="bookmark-label">
                  {label}
                  {missing && <span className="bookmark-detail">Missing file</span>}
                  {!search && !query && parentOf(path) && <span className="bookmark-detail">{parentOf(path)}</span>}
                </span>
              </Button>
              <IconButton
                className="bookmark-actions"
                label={`Actions for bookmark ${label}`}
                disabled={busy}
                aria-haspopup="menu"
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  useUi.getState().showMenu(bounds.left, bounds.bottom + 4, items());
                }}
              >
                <MoreHorizontal aria-hidden="true" />
              </IconButton>
            </div>
          );
        })}
        <div
          className={`bookmark-end ${dropAt === bookmarks.length ? "drop-before" : ""}`}
          onDragOver={(event) => dragOver(event, bookmarks.length)}
          onDragLeave={() => setDropAt(null)}
          onDrop={(event) => onDrop(event, bookmarks.length)}
        />
      </div>
    </DesignSystemScope>
  );
}
