import { Fragment, useEffect, useRef, useState, type DragEvent } from "react";
import { CalendarDays, Columns2, PanelLeftOpen, PanelRight, MoreHorizontal, X } from "lucide-react";
import { isSpecialTab, specialTabName, parseView, contextKind } from "./specialTabs";
import { useWorkspace, type Pane, type SplitDirection } from "../state/workspace";
import { useVault } from "../state/vault";
import { useUi } from "../state/ui";
import { FileView } from "../viewers/FileView";
import { displayName, kindIcon } from "./FileTree";
import { kindOf } from "../ipc/kinds";
import { commands, shortcutOf } from "../commands";

import { useChat } from "../state/chat";
import { IconButton } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./workspaceChrome.css";

const TAB_DRAG = "application/x-mosaic-tab";

export function Workspace() {
  const panes = useWorkspace((s) => s.panes);
  const direction = useWorkspace((s) => s.direction);
  return (
    <div className={`panes ${direction}`}>
      {panes.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && <Divider index={i - 1} direction={direction} />}
          {/* The panes touching the window's top corners carry the sidebar toggles. */}
          <PaneView pane={p} topLeft={i === 0} topRight={direction === "row" ? i === panes.length - 1 : i === 0} />
        </Fragment>
      ))}
    </div>
  );
}

function Divider({ index, direction }: { index: number; direction: "row" | "column" }) {
  const panes = useWorkspace((state) => state.panes);
  const total = panes.reduce((sum, pane) => sum + (pane.size ?? 1), 0);
  const before = panes[index]?.size ?? 1,
    after = panes[index + 1]?.size ?? 1;
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (
    <DesignSystemScope
      className="pane-divider"
      role="separator"
      aria-label="Resize workspace panes"
      aria-orientation={direction === "row" ? "vertical" : "horizontal"}
      aria-valuemin={10}
      aria-valuemax={Math.round(((before + after) / total) * 100 - 10)}
      aria-valuenow={Math.round((before / total) * 100)}
      aria-valuetext={`Pane ${index + 1}: ${Math.round((before / total) * 100)}% of workspace`}
      title="Drag or use arrow keys to resize · Enter to balance adjacent panes"
      tabIndex={0}
      onKeyDown={(event) => {
        const backwards = direction === "row" ? "ArrowLeft" : "ArrowUp";
        const forwards = direction === "row" ? "ArrowRight" : "ArrowDown";
        if (![backwards, forwards, "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        const delta =
          event.key === "Enter"
            ? (after - before) / 2 / total
            : event.key === "Home"
              ? -1
              : event.key === "End"
                ? 1
                : event.key === forwards
                  ? 0.02
                  : -0.02;
        useWorkspace.getState().resize(index, delta);
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        cleanup.current?.();
        const container = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const extent = direction === "row" ? container.width : container.height;
        if (extent <= 0) return;
        let last = direction === "row" ? e.clientX : e.clientY;
        const move = (ev: MouseEvent) => {
          const pos = direction === "row" ? ev.clientX : ev.clientY;
          useWorkspace.getState().resize(index, (pos - last) / extent);
          last = pos;
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.classList.remove("resizing");
          cleanup.current = null;
        };
        cleanup.current = up;
        document.body.classList.add("resizing");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    />
  );
}

function PaneView({ pane, topLeft, topRight }: { pane: Pane; topLeft: boolean; topRight: boolean }) {
  const left = useUi((s) => s.leftSidebar);
  const right = useUi((s) => s.rightPanel);
  const focused = useWorkspace((s) => s.focused === pane.id);
  const multi = useWorkspace((s) => s.panes.length > 1);
  const [dropping, setDropping] = useState(false);
  const tabs = useRef<HTMLDivElement>(null);
  const [keyboardTab, setKeyboardTab] = useState<string | null>(null);
  useEffect(() => {
    const reveal = () =>
      tabs.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    reveal();
    if (!tabs.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(tabs.current);
    return () => observer.disconnect();
  }, [pane.active, pane.tabs]);
  useEffect(() => {
    if (!keyboardTab) return;
    if (pane.active !== keyboardTab) {
      setKeyboardTab(null);
      return;
    }
    // Newly mounted editors focus their document. Arrow navigation stays in the tab list.
    const timer = setTimeout(() => {
      (tabs.current?.children[pane.tabs.indexOf(keyboardTab)] as HTMLElement | undefined)?.focus({
        preventScroll: true,
      });
      setKeyboardTab(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [keyboardTab, pane.active, pane.tabs]);
  // Dragging a tab over the right or bottom edge of the pane body: drop to split there.
  const [edge, setEdge] = useState<SplitDirection | null>(null);
  const edgeOf = (ev: DragEvent): SplitDirection | null => {
    const r = ev.currentTarget.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    if (x > 0.7 && x - 0.7 >= y - 0.7) return "row";
    if (y > 0.7) return "column";
    return null;
  };

  const onDrop = (ev: DragEvent, index?: number) => {
    const raw = ev.dataTransfer.getData(TAB_DRAG);
    if (!raw) return;
    ev.preventDefault();
    ev.stopPropagation();
    setDropping(false);
    const { path, from } = JSON.parse(raw) as { path: string; from: string };
    useWorkspace.getState().moveTab(path, from, pane.id, index);
  };

  return (
    <section
      className={`pane ${focused && multi ? "focused" : ""} ${dropping ? "drop" : ""} ${topLeft ? "top-left" : ""}`}
      style={{ flexGrow: pane.size ?? 1 }}
      aria-label="Workspace pane"
      data-focus-region
      tabIndex={-1}
      onFocusCapture={() => useWorkspace.getState().focus(pane.id)}
      onMouseDownCapture={() => useWorkspace.getState().focus(pane.id)}
      onDragOver={(ev) => {
        if (ev.dataTransfer.types.includes(TAB_DRAG)) {
          ev.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(ev) => onDrop(ev)}
    >
      <DesignSystemScope className="tabbar workspace-tabbar">
        {topLeft && !left && (
          <IconButton
            className="bar-toggle workspace-sidebar-toggle"
            label="Show sidebar"
            title={`Show sidebar (${shortcutOf("toggle-left")})`}
            onClick={() => useUi.getState().toggleLeftSidebar()}
          >
            <PanelLeftOpen size={16} />
          </IconButton>
        )}
        <div ref={tabs} className="tabs" role="tablist" aria-label="Workspace tabs">
          {pane.tabs.map((path, i) => (
            <Tab
              key={path}
              pane={pane}
              path={path}
              active={pane.active === path}
              onDropAt={(ev) => onDrop(ev, i)}
              onKeyboardActivate={(next) => {
                useWorkspace.getState().activate(pane.id, next);
                setKeyboardTab(next);
              }}
            />
          ))}
        </div>
        <IconButton
          className="bar-toggle workspace-split-toggle"
          label="Split right"
          title={`Split right (${shortcutOf("split-right")}); split down: ${shortcutOf("split-down")}. Or drag a tab to the right or bottom edge of a pane.`}
          onClick={() => {
            useWorkspace.getState().focus(pane.id);
            useWorkspace.getState().split("row");
          }}
        >
          <Columns2 size={16} />
        </IconButton>
        <IconButton
          className="bar-toggle"
          label="More workspace actions"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            useWorkspace.getState().focus(pane.id);
            const ids = [
              "add-property",
              "file-history",
              "export-html",
              "export-pdf",
              "move-file",
              "rename",
              "bookmark",
              "delete",
              "split-down",
              "split-right",
              "toggle-left",
              "toggle-right",
            ];
            useUi.getState().showMenu(
              r.right - 220,
              r.bottom,
              commands()
                .filter((c) => ids.includes(c.id) && (c.when?.() ?? true))
                .map((c) => ({ label: c.label, action: c.run, danger: c.id === "delete" })),
            );
          }}
        >
          <MoreHorizontal size={16} />
        </IconButton>
        {topRight && contextKind(pane.active) && (
          <IconButton
            className={`bar-toggle workspace-context-toggle ${right ? "active" : ""}`}
            label={right ? "Hide right panel" : "Show right panel"}
            aria-pressed={right}
            title={`${right ? "Hide" : "Show"} context panel (${shortcutOf("toggle-right")})`}
            onClick={() => useUi.getState().toggleRightPanel()}
          >
            <PanelRight size={16} />
          </IconButton>
        )}
      </DesignSystemScope>
      <div
        className="pane-body"
        onDragOver={(ev) => {
          if (!ev.dataTransfer.types.includes(TAB_DRAG)) return;
          ev.preventDefault();
          setEdge(edgeOf(ev));
        }}
        onDragLeave={(ev) => {
          if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setEdge(null);
        }}
        onDrop={(ev) => {
          const raw = ev.dataTransfer.getData(TAB_DRAG);
          const where = edgeOf(ev);
          setEdge(null);
          if (!raw || !where) return; // the middle: the pane's own drop (moves the tab here)
          ev.preventDefault();
          ev.stopPropagation();
          setDropping(false);
          const { path, from } = JSON.parse(raw) as { path: string; from: string };
          useWorkspace.getState().splitWith(path, from, pane.id, where);
        }}
      >
        {pane.active ? <FileView key={pane.active} path={pane.active} /> : <EmptyPane />}
        {edge && <div className={`split-preview ${edge}`} aria-hidden />}
      </div>
    </section>
  );
}

function Tab({
  pane,
  path,
  active,
  onDropAt,
  onKeyboardActivate,
}: {
  pane: Pane;
  path: string;
  active: boolean;
  onDropAt(ev: DragEvent): void;
  onKeyboardActivate(path: string): void;
}) {
  const dirty = useWorkspace((s) => s.buffers[path]?.dirty ?? false);
  const kind = useWorkspace((s) => s.buffers[path]?.kind) ?? kindOf(path);
  const special = isSpecialTab(path);
  const chatTitle = useChat((s) => s.chats[parseView(path).id]?.title);
  const name =
    special && parseView(path).kind === "chat" && chatTitle
      ? chatTitle
      : special
        ? specialTabName(path)
        : displayName({ name: path.split("/").pop() ?? path, kind });
  const ws = useWorkspace.getState;
  return (
    <div
      className={`tab ${active ? "active" : ""}`}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onKeyboardActivate(path);
        }
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const i = pane.tabs.indexOf(path);
          const at =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? pane.tabs.length - 1
                : (i + (e.key === "ArrowRight" ? 1 : -1) + pane.tabs.length) % pane.tabs.length;
          onKeyboardActivate(pane.tabs[at]);
        }
      }}
      title={special ? specialTabName(path) : path}
      draggable
      onDragStart={(ev) => ev.dataTransfer.setData(TAB_DRAG, JSON.stringify({ path, from: pane.id }))}
      onDrop={onDropAt}
      onClick={() => ws().activate(pane.id, path)}
      onAuxClick={(ev) => ev.button === 1 && ws().closeTab(pane.id, path)}
      onContextMenu={(ev) => {
        ev.preventDefault();
        useUi.getState().showMenu(ev.clientX, ev.clientY, [
          { label: "Close", shortcut: "⌘W", action: () => ws().closeTab(pane.id, path) },
          {
            label: "Close others",
            action: () => pane.tabs.filter((t) => t !== path).forEach((t) => ws().closeTab(pane.id, t)),
          },
          { label: "", separator: true },
          {
            label: "Split right",
            action: () => {
              ws().activate(pane.id, path);
              ws().split("row");
            },
          },
          {
            label: "Split down",
            action: () => {
              ws().activate(pane.id, path);
              ws().split("column");
            },
          },
        ]);
      }}
    >
      <span className="tab-icon">{special ? <CalendarDays size={13} /> : kindIcon(kind, 13)}</span>
      <span className="tab-name">{name}</span>
      <IconButton
        className={`tab-close ${dirty ? "dirty" : ""}`}
        label="Close tab"
        title={`${dirty ? "Unsaved changes · " : ""}Close ${name}`}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(ev) => {
          ev.stopPropagation();
          const tabs = ev.currentTarget.closest(".tabs");
          const closed = ev.currentTarget.closest('[role="tab"]');
          const keyboard = ev.detail === 0;
          ws().closeTab(pane.id, path);
          requestAnimationFrame(() => {
            if (!closed?.isConnected && (keyboard || document.activeElement === document.body))
              tabs?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
          });
        }}
      >
        <X size={12} />
      </IconButton>
    </div>
  );
}

function EmptyPane() {
  const hasFiles = useVault((s) => s.entries.length > 0);
  return (
    <DesignSystemScope className="empty workspace-empty">
      <p>
        {hasFiles ? "Pick a file in the sidebar, or press ⌘N for a new note." : "Press ⌘N to create your first note."}
      </p>
    </DesignSystemScope>
  );
}
