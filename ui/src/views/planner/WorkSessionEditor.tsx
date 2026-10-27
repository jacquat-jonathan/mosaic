import { useEffect, useState } from "react";
import { api } from "../../ipc/api";
import { errorMessage, isCoreError, type PlannerWorkSession } from "../../ipc/types";
import { workSessionDraft, workSessionError, workSessionUpdate, type WorkSessionDraft } from "./workSessionModel";

export function WorkSessionEditor({
  session,
  taskTitle,
  onClose,
  onDone,
  onReload,
}: {
  session: PlannerWorkSession;
  taskTitle: string;
  onClose(): void;
  onDone(): void;
  onReload(): void;
}) {
  const [draft, setDraft] = useState<WorkSessionDraft>(() => workSessionDraft(session)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [conflict, setConflict] = useState(false);
  useEffect(() => {
    setDraft(workSessionDraft(session));
    setError(null);
    setConflict(false);
  }, [session]);
  const validation = workSessionError(draft, session.timezone);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      await action();
      onDone();
    } catch (reason) {
      setError(errorMessage(reason));
      setConflict(isCoreError(reason) && reason.code === "conflict");
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="planner-editor work-session-editor" aria-label={`Edit work session for ${taskTitle}`}>
      <header>
        <h2>Work session</h2>
        <button aria-label="Close work session editor" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="work-session-task">{taskTitle}</p>
      {error && (
        <div className="error-text">
          <p>{error}</p>
          {conflict && (
            <button
              onClick={() => {
                onReload();
                setError(null);
                setConflict(false);
              }}
            >
              Reload latest
            </button>
          )}
        </div>
      )}
      <label className="event-check">
        <input
          type="checkbox"
          checked={draft.allDay}
          onChange={(event) => setDraft((current) => ({ ...current, allDay: event.target.checked }))}
        />{" "}
        All day
      </label>
      <label>
        Day
        <input
          type="date"
          value={draft.day}
          onChange={(event) => setDraft((current) => ({ ...current, day: event.target.value }))}
        />
      </label>
      {!draft.allDay && (
        <div className="planner-editor-row">
          <label>
            Start time
            <input
              type="time"
              step="60"
              value={draft.startTime}
              onChange={(event) => setDraft((current) => ({ ...current, startTime: event.target.value }))}
            />
          </label>
          <label>
            End time
            <input
              type="time"
              step="60"
              value={draft.endTime}
              onChange={(event) => setDraft((current) => ({ ...current, endTime: event.target.value }))}
            />
          </label>
        </div>
      )}
      <p className="panel-meta">Time zone: {session.timezone}</p>
      {validation && <p className="error-text">{validation}</p>}
      <footer>
        <button
          className="danger"
          disabled={busy}
          onClick={() => void run(() => api.cancelPlannerWorkSession(session.id, session.revision))}
        >
          Delete
        </button>
        <button
          className="primary"
          disabled={busy || !!validation}
          onClick={() => void run(() => api.updatePlannerWorkSession(session.id, workSessionUpdate(session, draft)))}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </footer>
    </aside>
  );
}
