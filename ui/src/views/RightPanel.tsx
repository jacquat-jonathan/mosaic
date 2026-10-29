import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { contextKind, parseView } from "./specialTabs";
import { api } from "../ipc/api";
import { errorMessage } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { ChatContext } from "./ChatContext";
import { usePlanning } from "../state/planning";
import { WorkflowContext } from "./Workflows";
import { dayStamp } from "../daily";
import { openDailyNote } from "../actions";
import type { Days } from "../ipc/types";
import { TaskList } from "./CalendarView";

import { NoteDetails } from "./NoteDetails";
import { IconButton } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./noteDetails.css";

/** Context follows the focused workspace, independently of the selected destination. */
export function RightPanel() {
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active ?? null);
  const kind = contextKind(active);
  const root = useVault((s) => s.vault?.root);
  if (!active || !kind) return null;
  const id = parseView(active).id;
  return (
    <aside className="right-panel" aria-label="Workspace context" data-focus-region tabIndex={-1}>
      <DesignSystemScope as="header" className="context-head note-details-header">
        <strong>{kind === "note" ? "Note details" : `${kind[0].toUpperCase()}${kind.slice(1)} details`}</strong>
        <IconButton
          label="Close context panel"
          onClick={() => {
            useUi.getState().toggleRightPanel();
            requestAnimationFrame(() => {
              const pane =
                document.querySelector<HTMLElement>(".pane.focused") ?? document.querySelector<HTMLElement>(".pane");
              const control = pane?.querySelector<HTMLButtonElement>('[aria-label="Show right panel"]');
              (control?.getClientRects().length
                ? control
                : pane?.querySelector<HTMLButtonElement>('[aria-label="More workspace actions"]')
              )?.focus();
            });
          }}
        >
          <X aria-hidden="true" />
        </IconButton>
      </DesignSystemScope>
      {kind === "note" ? (
        <NoteDetails key={`${root}/${active}`} path={active} />
      ) : kind === "chat" ? (
        <ChatContext id={id} />
      ) : kind === "workflow" ? (
        <WorkflowContext name={id} />
      ) : (
        <CalendarContext />
      )}
    </aside>
  );
}
function CalendarContext() {
  const day = usePlanning((s) => s.selectedDay);
  const revision = useVault((s) => s.revision);
  const [data, setData] = useState<Days | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    void api.days(day, day, dayStamp()).then(
      (d) => live && setData(d),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [day, revision, tick]);
  return (
    <div className="context-content">
      <h3>{day}</h3>
      <button onClick={() => void openDailyNote(new Date(`${day}T12:00`), { newTab: true })}>Open daily note</button>
      {error && <p className="error-text">{error}</p>}
      {data && (
        <>
          <p>{data.days[0]?.tasks.filter((t) => t.status === "open").length ?? 0} open tasks</p>
          <h3>Overdue</h3>
          <TaskList
            tasks={data.overdue}
            showNote
            onTick={(t, done) =>
              void api.setTask(t.path, t.line, t.text, done).then(
                () => setTick((n) => n + 1),
                (e) => setError(errorMessage(e)),
              )
            }
          />
        </>
      )}
    </div>
  );
}
