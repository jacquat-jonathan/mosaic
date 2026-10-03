import { Fragment, useState, type DragEvent } from "react";
import { Columns2, PanelLeftOpen, PanelRight, X } from "lucide-react";
import { useWorkspace, type Pane, type SplitDirection } from "../state/workspace";
import { useVault } from "../state/vault";
import { useUi } from "../state/ui";
import { FileView } from "../viewers/FileView";
import { displayName, kindIcon } from "./FileTree";
import { kindOf } from "../ipc/kinds";
import { shortcutOf } from "../commands";

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
  return (
    <div
      className="pane-divider"
      onMouseDown={(e) => {
        e.preventDefault();
        const container = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const extent = direction === "row" ? container.width : container.height;
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
        };
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
      <div className="tabbar" data-tauri-drag-region>
        {topLeft && !left && (
          <button className="bar-toggle" aria-label="Show sidebar" title={`Show sidebar (${shortcutOf("toggle-left")})`} onClick={() => useUi.getState().toggleLeftSidebar()}>
            <PanelLeftOpen size={16} />
          </button>
        )}
        <div className="tabs" data-tauri-drag-region>
          {pane.tabs.map((path, i) => (
            <Tab key={path} pane={pane} path={path} active={pane.active === path} onDropAt={(ev) => onDrop(ev, i)} />
          ))}
        </div>
        <button
          className="bar-toggle"
          aria-label="Split right"
          title={`Split right (${shortcutOf("split-right")}); split down: ${shortcutOf("split-down")}. Or drag a tab to the right or bottom edge of a pane.`}
          onClick={() => {
            useWorkspace.getState().focus(pane.id);
            useWorkspace.getState().split("row");
          }}
        >
          <Columns2 size={16} />
        </button>
        {topRight && (
          <button
            className={`bar-toggle ${right ? "active" : ""}`}
            aria-label={right ? "Hide right panel" : "Show right panel"}
            aria-pressed={right}
            title={`${right ? "Hide" : "Show"} backlinks and outline (${shortcutOf("toggle-right")})`}
            onClick={() => useUi.getState().toggleRightPanel()}
          >
            <PanelRight size={16} />
          </button>
        )}
      </div>
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

function Tab({ pane, path, active, onDropAt }: { pane: Pane; path: string; active: boolean; onDropAt(ev: DragEvent): void }) {
  const dirty = useWorkspace((s) => s.buffers[path]?.dirty ?? false);
  const kind = useWorkspace((s) => s.buffers[path]?.kind) ?? kindOf(path);
  const name = displayName({ name: path.split("/").pop() ?? path, kind });
  const ws = useWorkspace.getState;
  return (
    <div
      className={`tab ${active ? "active" : ""}`}
      title={path}
      draggable
      onDragStart={(ev) => ev.dataTransfer.setData(TAB_DRAG, JSON.stringify({ path, from: pane.id }))}
      onDrop={onDropAt}
      onClick={() => ws().activate(pane.id, path)}
      onAuxClick={(ev) => ev.button === 1 && ws().closeTab(pane.id, path)}
      onContextMenu={(ev) => {
        ev.preventDefault();
        useUi.getState().showMenu(ev.clientX, ev.clientY, [
          { label: "Close", shortcut: "⌘W", action: () => ws().closeTab(pane.id, path) },
          { label: "Close others", action: () => pane.tabs.filter((t) => t !== path).forEach((t) => ws().closeTab(pane.id, t)) },
          { label: "", separator: true },
          { label: "Split right", action: () => { ws().activate(pane.id, path); ws().split("row"); } },
          { label: "Split down", action: () => { ws().activate(pane.id, path); ws().split("column"); } },
        ]);
      }}
    >
      <span className="tab-icon">{kindIcon(kind, 13)}</span>
      <span className="tab-name">{name}</span>
      <button
        className={`tab-close ${dirty ? "dirty" : ""}`}
        aria-label="Close tab"
        onClick={(ev) => {
          ev.stopPropagation();
          ws().closeTab(pane.id, path);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function EmptyPane() {
  const hasFiles = useVault((s) => s.entries.length > 0);
  return (
    <div className="empty">
      <p>{hasFiles ? "Pick a file in the sidebar, or press ⌘N for a new note." : "Press ⌘N to create your first note."}</p>
    </div>
  );
}
