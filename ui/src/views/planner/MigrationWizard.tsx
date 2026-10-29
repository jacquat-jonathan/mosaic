import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton, Notice } from "../../design-system/components";
import { X } from "lucide-react";
import { useVault } from "../../state/vault";
import { DesignSystemScope } from "../DesignSystemScope";
import "./migrationWizard.css";
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
  const root = useVault((state) => state.vault?.root),
    live = useRef(true),
    lock = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  const current = () => live.current && root === useVault.getState().vault?.root;
  useEffect(() => {
    live.current = true;
    heading.current?.focus();
    return () => {
      live.current = false;
    };
  }, []);
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
    if (lock.current || !selected.size || !current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      await api.importMarkdownToPlanner(preview, [...selected], includeDuplicates, timezone);
      if (current()) onDone();
    } catch (e) {
      if (current()) setError(errorMessage(e));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <DesignSystemScope
      className="migration-wizard"
      role="region"
      aria-label="Import Markdown tasks"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          if (!busy) onCancel();
        }
      }}
    >
      <header>
        <div>
          <h2 ref={heading} tabIndex={-1}>
            Preview Markdown task import
          </h2>
          <p>Your notes will not be edited. Imported tasks become independent planner objects.</p>
        </div>
        <IconButton label="Close import preview" disabled={busy} onClick={onCancel}>
          <X size={16} />
        </IconButton>
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
            <section key={group.source_path} role="group" aria-label={group.source_path}>
              <label className="migration-group-toggle">
                <input
                  type="checkbox"
                  aria-label={`Select all from ${group.source_path}`}
                  checked={allSelected}
                  disabled={busy || fingerprints.length === 0}
                  ref={(input) => {
                    if (input) input.indeterminate = mixed;
                  }}
                  onChange={(event) => toggleGroup(fingerprints, event.target.checked)}
                />
                <strong className="migration-source">{group.source_path}</strong>
                <small>
                  {selectedInGroup}/{fingerprints.length}
                </small>
              </label>
              {group.tasks.map((task) => (
                <label
                  key={task.fingerprint}
                  className={task.duplicate ? "duplicate" : ""}
                  style={{ paddingLeft: Math.min(task.depth, 4) * 12 }}
                >
                  <input
                    type="checkbox"
                    aria-label={task.title}
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
            disabled={busy}
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
      {error && <Notice tone="error">{error}</Notice>}
      {!preview.candidates && <p className="mds-hint">No Markdown tasks to import.</p>}
      <footer>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => void submit()} disabled={busy || selected.size === 0}>
          {busy ? "Importing…" : `Import ${selected.size} items`}
        </Button>
      </footer>
    </DesignSystemScope>
  );
}
