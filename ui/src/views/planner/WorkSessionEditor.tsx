import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button, IconButton, Notice, TextField } from "../../design-system/components";
import { api } from "../../ipc/api";
import { errorMessage, isCoreError, type PlannerWorkSession } from "../../ipc/types";
import { useVault } from "../../state/vault";
import { DesignSystemScope } from "../DesignSystemScope";
import { workSessionDraft, workSessionError, workSessionUpdate, type WorkSessionDraft } from "./workSessionModel";
import "./plannerEditor.css";

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
  const root = useVault((state) => state.vault?.root),
    live = useRef(true),
    lock = useRef(false);
  const first = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const current = () => live.current && root === useVault.getState().vault?.root;
  useEffect(() => {
    live.current = true;
    first.current?.focus();
    return () => {
      live.current = false;
    };
  }, []);
  const [draft, setDraft] = useState<WorkSessionDraft>(() => workSessionDraft(session)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [conflict, setConflict] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh a draft only when the selected record or its revision changes
  useEffect(() => {
    setDraft(workSessionDraft(session));
    setError(null);
    setConflict(false);
  }, [session.id, session.revision]);
  const validation = workSessionError(draft, session.timezone);
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      await action();
      if (current()) onDone();
    } catch (reason) {
      if (current()) {
        setError(errorMessage(reason));
        setConflict(isCoreError(reason) && reason.code === "conflict");
      }
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <DesignSystemScope
      as="aside"
      className="planner-editor work-session-editor planner-editor-design"
      aria-label={`Edit work session for ${taskTitle}`}
      aria-busy={busy}
    >
      <header>
        <h2>Work session</h2>
        <IconButton label="Close work session editor" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <p className="work-session-task">{taskTitle}</p>
      {error && (
        <Notice tone="error">
          {error}
          {conflict && (
            <Button
              disabled={busy}
              onClick={() => {
                onReload();
                setError(null);
                setConflict(false);
              }}
            >
              Reload latest
            </Button>
          )}
        </Notice>
      )}
      <label className="event-check">
        <input
          type="checkbox"
          checked={draft.allDay}
          disabled={busy}
          onChange={(event) => setDraft((value) => ({ ...value, allDay: event.target.checked }))}
        />{" "}
        All day
      </label>
      <TextField
        ref={first}
        label="Day"
        type="date"
        value={draft.day}
        disabled={busy}
        aria-describedby={validation ? errorId : undefined}
        aria-invalid={validation && !draft.day ? true : undefined}
        onChange={(event) => setDraft((value) => ({ ...value, day: event.target.value }))}
      />
      {!draft.allDay && (
        <div className="planner-editor-row">
          <TextField
            label="Start time"
            type="time"
            step="60"
            value={draft.startTime}
            disabled={busy}
            aria-describedby={validation ? errorId : undefined}
            onChange={(event) => setDraft((value) => ({ ...value, startTime: event.target.value }))}
          />
          <TextField
            label="End time"
            type="time"
            step="60"
            value={draft.endTime}
            disabled={busy}
            aria-invalid={validation ? true : undefined}
            aria-describedby={validation ? errorId : undefined}
            onChange={(event) => setDraft((value) => ({ ...value, endTime: event.target.value }))}
          />
        </div>
      )}
      <p className="mds-hint">Time zone: {session.timezone}</p>
      {validation && (
        <div id={errorId}>
          <Notice tone="error">{validation}</Notice>
        </div>
      )}
      <footer>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => void run(() => api.cancelPlannerWorkSession(session.id, session.revision))}
        >
          Delete
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !!validation}
          onClick={() => void run(() => api.updatePlannerWorkSession(session.id, workSessionUpdate(session, draft)))}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </footer>
    </DesignSystemScope>
  );
}
