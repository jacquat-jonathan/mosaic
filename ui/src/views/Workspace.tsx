import { Fragment, useState, type DragEvent } from "react";
import { X } from "lucide-react";
import { useWorkspace, type Pane } from "../state/workspace";
import { useVault } from "../state/vault";
import { useUi } from "../state/ui";
import { FileView } from "../viewers/FileView";
import { displayName, kindIcon } from "./FileTree";
import { kindOf } from "../ipc/kinds";

const TAB_DRAG = "application/x-mosaic-tab";

export function Workspace() {
  const panes = useWorkspace((s) => s.panes);
  const direction = useWorkspace((s) => s.direction);
  return (
    <div className={`panes ${direction}`}>
      {panes.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && <div className="pane-divider" />}
          <PaneView pane={p} />
        </Fragment>
      ))}
    </div>
  );
}

function PaneView({ pane }: { pane: Pane }) {
  const focused = useWorkspace((s) => s.focused === pane.id);
  const multi = useWorkspace((s) => s.panes.length > 1);
  const [dropping, setDropping] = useState(false);

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
      className={`pane ${focused && multi ? "focused" : ""} ${dropping ? "drop" : ""}`}
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
        {pane.tabs.map((path, i) => (
          <Tab key={path} pane={pane} path={path} active={pane.active === path} onDropAt={(ev) => onDrop(ev, i)} />
        ))}
      </div>
      <div className="pane-body">
        {pane.active ? <FileView key={pane.active} path={pane.active} /> : <EmptyPane />}
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
