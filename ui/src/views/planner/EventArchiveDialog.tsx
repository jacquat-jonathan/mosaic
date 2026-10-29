import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button, Dialog, Notice, SegmentedControl } from "../../design-system/components";
import { api } from "../../ipc/api";
import { errorMessage, type PlannerEvent } from "../../ipc/types";
import { useVault } from "../../state/vault";
import { DesignSystemScope } from "../DesignSystemScope";
import "./calendarDialogs.css";

export function EventArchiveDialog({
  onChange,
  onClose,
  returnFocusRef,
}: {
  onChange(): Promise<void>;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const root = useVault((state) => state.vault?.root),
    live = useRef(true),
    lock = useRef(false),
    generation = useRef(0),
    controls = useRef<HTMLDivElement>(null),
    retry = useRef<HTMLButtonElement>(null);
  const [events, setEvents] = useState<PlannerEvent[]>([]),
    [view, setView] = useState<"archive" | "trash">("archive"),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const current = useCallback(() => live.current && root === useVault.getState().vault?.root, [root]);
  const load = useCallback(async () => {
    const version = ++generation.current;
    const valid = () => current() && generation.current === version;
    if (!current()) return;
    setLoading(true);
    try {
      const next = await api.plannerEvents(true, true);
      if (valid()) {
        setEvents(next);
        setError(null);
      }
    } catch (reason) {
      if (valid()) setError(errorMessage(reason));
    } finally {
      if (valid()) setLoading(false);
    }
  }, [current]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      generation.current++;
    };
  }, [load]);
  const returnActionFocus = () =>
    setTimeout(() => {
      if (current()) controls.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    }, 0);
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (current()) {
        await load();
        await onChange();
      }
    } catch (reason) {
      if (current()) setError(errorMessage(reason));
    } finally {
      lock.current = false;
      if (current()) {
        setBusy(false);
        returnActionFocus();
      }
    }
  };
  const visible = events.filter((item) =>
    view === "trash" ? !!item.trashed_at : !!item.archived_at && !item.trashed_at,
  );
  return (
    <DesignSystemScope className="calendar-dialog-scope">
      <Dialog
        open
        title="Local event archive"
        size="wide"
        onClose={onClose}
        dismissible={!busy}
        returnFocusRef={returnFocusRef}
        actions={
          <Button variant="secondary" disabled={busy} aria-label="Close event archive" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div ref={controls}>
          <SegmentedControl<"archive" | "trash">
            label="Archived event view"
            value={view}
            disabled={busy}
            options={[
              { value: "archive", label: "Archive" },
              { value: "trash", label: "Deleted" },
            ]}
            onChange={setView}
          />
        </div>
        {error && (
          <Notice tone="error">
            {error}
            <Button ref={retry} disabled={busy || loading} onClick={() => void load().then(returnActionFocus)}>
              Retry archived events
            </Button>
          </Notice>
        )}
        {loading ? (
          <p className="mds-hint" role="status">
            Loading archived events…
          </p>
        ) : !error && !visible.length ? (
          <p className="mds-hint">No events here.</p>
        ) : (
          <ul className="calendar-archive-list" aria-label="Archived events">
            {visible.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <p className="mds-hint">
                    {item.all_day ? item.start_value : new Date(item.start_value).toLocaleString()}
                  </p>
                </div>
                <Button disabled={busy} onClick={() => void run(() => api.restorePlannerEvent(item.id, item.revision))}>
                  Restore
                </Button>
                {view === "archive" && (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => void run(() => api.trashPlannerEvent(item.id, item.revision))}
                  >
                    Delete
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </DesignSystemScope>
  );
}
