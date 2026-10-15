import { useMemo, useState } from "react";
import { api } from "../../ipc/api";
import { errorMessage, type IcalImportPreview } from "../../ipc/types";

export function IcalImportWizard({
  preview,
  fileName,
  onDone,
  onCancel,
}: {
  preview: IcalImportPreview;
  fileName: string;
  onDone(): void;
  onCancel(): void;
}) {
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
    setBusy(true);
    setError(null);
    try {
      await api.importPlannerIcal(preview, [...selected], allowDuplicates);
      onDone();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section
        className="modal ical-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ical-import-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="ical-import-title">Import calendar events</h2>
            <p>{fileName} · choose which independent local events to create.</p>
          </div>
          <button aria-label="Close import" onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="migration-summary">
          <strong>{selected.size}</strong> of {preview.candidates.length} events selected
          {preview.duplicates ? ` · ${preview.duplicates} already imported` : ""}
        </div>
        <div className="ical-import-list">
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
        {preview.duplicates > 0 && (
          <label className="migration-duplicates">
            <input
              type="checkbox"
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
        {error && <p className="error-text">{error}</p>}
        <footer>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy || selected.size === 0} onClick={() => void submit()}>
            {busy ? "Importing…" : `Import ${selected.size} events`}
          </button>
        </footer>
      </section>
    </div>
  );
}
