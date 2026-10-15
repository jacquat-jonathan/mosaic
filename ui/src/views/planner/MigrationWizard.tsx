import { useMemo, useState } from "react";
import { api } from "../../ipc/api";
import { errorMessage, type MarkdownImportPreview } from "../../ipc/types";

export function MigrationWizard({
  preview,
  onDone,
  onCancel,
}: {
  preview: MarkdownImportPreview;
  onDone(): void;
  onCancel(): void;
}) {
  const defaults = useMemo(
    () =>
      preview.groups
        .flatMap((group) => group.tasks)
        .filter((task) => task.default_selected && !task.duplicate)
        .map((task) => task.fingerprint),
    [preview],
  );
  const [selected, setSelected] = useState(new Set(defaults));
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archivedSelected = useMemo(
    () =>
      preview.groups.flatMap((group) => group.tasks).filter((task) => task.archived && selected.has(task.fingerprint))
        .length,
    [preview, selected],
  );
  const toggle = (fingerprint: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(fingerprint);
      else next.delete(fingerprint);
      return next;
    });
  const toggleGroup = (fingerprints: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const fingerprint of fingerprints)
        if (checked) next.add(fingerprint);
        else next.delete(fingerprint);
      return next;
    });
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      await api.importMarkdownToPlanner(preview, [...selected], includeDuplicates, timezone);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="migration-wizard" aria-label="Import Markdown tasks">
      <header>
        <div>
          <h2>Preview Markdown task import</h2>
          <p>Your notes will not be edited. Imported tasks become independent planner objects.</p>
        </div>
        <button onClick={onCancel}>Close</button>
      </header>
      <div className="migration-summary">
        <strong>{selected.size}</strong> of {preview.candidates} items selected
        {archivedSelected ? ` · ${archivedSelected} will import to Archive` : ""}
        {preview.duplicates ? ` · ${preview.duplicates} previously imported` : ""}
      </div>
      <div className="migration-groups">
        {preview.groups.map((group) => {
          const eligible = group.tasks.filter((task) => includeDuplicates || !task.duplicate),
            fingerprints = eligible.map((task) => task.fingerprint),
            selectedInGroup = fingerprints.filter((fingerprint) => selected.has(fingerprint)).length,
            allSelected = fingerprints.length > 0 && selectedInGroup === fingerprints.length,
            mixed = selectedInGroup > 0 && !allSelected;
          return (
            <section key={group.source_path}>
              <label className="migration-group-toggle">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={busy || fingerprints.length === 0}
                  ref={(input) => {
                    if (input) input.indeterminate = mixed;
                  }}
                  onChange={(event) => toggleGroup(fingerprints, event.target.checked)}
                />
                <h3>{group.source_path}</h3>
                <small>
                  {selectedInGroup}/{fingerprints.length}
                </small>
              </label>
              {group.tasks.map((task) => (
                <label
                  key={task.fingerprint}
                  className={task.duplicate ? "duplicate" : ""}
                  style={{ paddingLeft: task.depth * 18 }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(task.fingerprint)}
                    disabled={busy || (task.duplicate && !includeDuplicates)}
                    onChange={(event) => toggle(task.fingerprint, event.target.checked)}
                  />
                  <span>{task.title}</span>
                  <small>
                    {task.kind}
                    {task.kind !== "epic" ? ` · ${task.status}` : ""}
                    {task.archived ? " · imports to Archive" : ""}
                    {task.due_date ? ` · due ${task.due_date}` : ""}
                    {task.duplicate ? " · already imported" : ""}
                  </small>
                </label>
              ))}
            </section>
          );
        })}
      </div>
      {preview.duplicates > 0 && (
        <label className="migration-duplicates">
          <input
            type="checkbox"
            checked={includeDuplicates}
            onChange={(event) => {
              setIncludeDuplicates(event.target.checked);
              if (!event.target.checked)
                setSelected(
                  (current) =>
                    new Set(
                      [...current].filter(
                        (id) =>
                          !preview.groups
                            .flatMap((group) => group.tasks)
                            .some((task) => task.fingerprint === id && task.duplicate),
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
        <button className="primary" onClick={() => void submit()} disabled={busy || selected.size === 0}>
          {busy ? "Importing…" : `Import ${selected.size} items`}
        </button>
      </footer>
    </section>
  );
}
