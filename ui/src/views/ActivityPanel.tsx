// AI activity: every change AI agents and the command line made to the vault, newest first, each with
// a one-click undo (built on the file history, see crates/mosaic-core/src/history.rs).

import { useCallback, useEffect, useState } from "react";
import { History as HistoryIcon, Undo2 } from "lucide-react";
import { api, onVaultChanged } from "../ipc/api";
import { errorMessage, type Version } from "../ipc/types";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { ago, dayLabel } from "../time";
import { what, who } from "./history";

export function ActivityPanel() {
  const [items, setItems] = useState<Version[] | null>(null);
  const [problem, setProblem] = useState<{ id: number; message: string } | null>(null);
  const [undone, setUndone] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    api.aiActivity().then(setItems, (e) => setProblem({ id: -1, message: errorMessage(e) }));
  }, []);

  useEffect(() => {
    load();
    let off: (() => void) | undefined;
    void onVaultChanged(() => load()).then((f) => (off = f));
    return () => off?.();
  }, [load]);

  const undo = async (v: Version) => {
    setProblem(null);
    try {
      await api.undoChange(v.id);
      setUndone((s) => new Set(s).add(v.id));
      load();
    } catch (e) {
      const message =
        (e as { code?: string }).code === "conflict"
          ? "The file changed again since. Open its history to pick a version."
          : (e as { code?: string }).code === "already_exists"
            ? "A file with that name exists again, so it wasn't brought back."
            : errorMessage(e);
      setProblem({ id: v.id, message });
    }
  };

  if (!items) return <div className="panel-meta">Loading…</div>;
  if (!items.length) {
    return (
      <div className="activity-empty panel-meta">
        No changes by AI agents yet. When an agent (or the <code>mosaic</code> command) creates, edits, moves or deletes a file, it shows up
        here, with one-click undo.
      </div>
    );
  }
  let lastDay = "";
  return (
    <div className="activity" role="list">
      {items.map((v) => {
        const day = dayLabel(v.time);
        const header = day !== lastDay ? <h4 className="activity-day">{day}</h4> : null;
        lastDay = day;
        const gone = v.action === "deleted";
        return (
          <div key={v.id} role="listitem">
            {header}
            <div className="activity-item">
              <div className="activity-line">
                <span className={`history-who source-${v.source}`}>{who(v)}</span> {what(v)}
              </div>
              <button className="activity-path" title={v.path} disabled={gone} onClick={() => void useWorkspace.getState().open(v.path, { newTab: false })}>
                {v.path.replace(/\.md$/, "")}
              </button>
              <div className="activity-meta">
                <span>{ago(v.time)}</span>
                <span className="spacer" />
                <button title="Versions of this file" aria-label="File history" onClick={() => useUi.getState().openHistory(v.path, v.action === "renamed" ? undefined : v.id)}>
                  <HistoryIcon size={13} />
                </button>
                <button title={undone.has(v.id) ? "Undone" : "Undo this change"} disabled={undone.has(v.id)} onClick={() => void undo(v)}>
                  <Undo2 size={13} /> {undone.has(v.id) ? "Undone" : "Undo"}
                </button>
              </div>
              {problem?.id === v.id && <p className="error-text">{problem.message}</p>}
            </div>
          </div>
        );
      })}
      {problem?.id === -1 && <p className="error-text">{problem.message}</p>}
    </div>
  );
}
