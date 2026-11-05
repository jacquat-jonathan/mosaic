import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, Dialog, Notice } from "../../design-system/components";
import { useVault } from "../../state/vault";
import { DesignSystemScope } from "../DesignSystemScope";
import "./calendarDialogs.css";
import { api } from "../../ipc/api";
import { errorMessage, type IcalImportPreview } from "../../ipc/types";

export function IcalImportWizard({
  preview,
  fileName,
  onDone,
  onCancel,
  returnFocusRef,
}: {
  preview: IcalImportPreview;
  fileName: string;
  onDone(): void;
  onCancel(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const root = useVault((state) => state.vault?.root),
    live = useRef(true),
    lock = useRef(false);
  const current = () => live.current && root === useVault.getState().vault?.root;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const defaults = useMemo(
    () => preview.candidates.filter((item) => !item.duplicate).map((item) => item.key),
    [preview],
  );
  const [selected, setSelected] = useState(new Set(defaults)),
    [allowDuplicates, setAllowDuplicates] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const toggle = (key: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  const submit = async () => {
    if (lock.current || !selected.size || !current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.importPlannerIcal(preview, [...selected], allowDuplicates);
      if (current()) onDone();
    } catch (reason) {
      if (current()) setError(errorMessage(reason));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <DesignSystemScope className="calendar-dialog-scope">
      <Dialog
        open
        size="wide"
        title="Import calendar events"
        description={`${fileName} · choose which independent local events to create.`}
        onClose={onCancel}
        dismissible={!busy}
        returnFocusRef={returnFocusRef}
        actions={
          <>
            <Button onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="secondary" disabled={busy || selected.size === 0} onClick={() => void submit()}>
              {busy ? "Importing…" : `Import ${selected.size} events`}
            </Button>
          </>
        }
      >
        <div className="calendar-import-summary">
          <strong>{selected.size}</strong> of {preview.candidates.length} events selected
          {preview.duplicates ? ` · ${preview.duplicates} already imported` : ""}
        </div>
        <div className="calendar-import-list">
          {preview.candidates.map((item) => (
            <label key={item.key} className={item.duplicate ? "duplicate" : ""}>
              <input
                type="checkbox"
                checked={selected.has(item.key)}
                disabled={busy || (item.duplicate && !allowDuplicates)}
                onChange={(event) => toggle(item.key, event.target.checked)}
              />
              <span>
                <strong>{item.title}</strong>
                <small>
                  {item.all_day ? item.start_value : new Date(item.start_value).toLocaleString()}
                  {item.recurrence_rule ? " · recurring" : ""}
                  {item.duplicate ? " · already imported" : ""}
                </small>
              </span>
            </label>
          ))}
        </div>
        {!preview.candidates.length && <p className="mds-hint">No events in this file.</p>}
        {preview.duplicates > 0 && (
          <label className="calendar-import-duplicates">
            <input
              type="checkbox"
              disabled={busy}
              checked={allowDuplicates}
              onChange={(event) => {
                const checked = event.target.checked;
                setAllowDuplicates(checked);
                if (!checked)
                  setSelected(
                    (current) =>
                      new Set(
                        [...current].filter(
                          (key) => !preview.candidates.some((item) => item.key === key && item.duplicate),
                        ),
                      ),
                  );
              }}
            />{" "}
            Allow intentional duplicates
          </label>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </Dialog>
    </DesignSystemScope>
  );
}
