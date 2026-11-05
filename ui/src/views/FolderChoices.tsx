import { useState } from "react";
import { useVault } from "../state/vault";
import { Button, TextField } from "../design-system/components";
import { X } from "lucide-react";

/** Searchable multi-select; selected missing paths remain visible and removable. */
export function FolderChoices({
  label,
  value,
  onChange,
  root = false,
  disabled = false,
  error,
}: {
  label: string;
  value: string[];
  onChange(value: string[]): void;
  root?: boolean;
  disabled?: boolean;
  error?: string;
}) {
  const [query, setQuery] = useState("");
  const folders = useVault((s) => s.entries)
    .filter((e) => e.is_dir)
    .map((e) => e.path);
  const choices = [...(root ? [""] : []), ...folders].filter(
    (path) => !value.includes(path) && (path || "Vault root").toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <fieldset className="workflow-folder-picker" disabled={disabled}>
      <legend>{label}</legend>
      <div className="workflow-folder-chips">
        {value.map((path) => (
          <Button
            variant="secondary"
            type="button"
            key={path}
            aria-label={`Remove ${path || "Vault root"}`}
            onClick={() => onChange(value.filter((p) => p !== path))}
          >
            {path || "Vault root"}
            {path && !folders.includes(path) ? " · missing" : ""} <X aria-hidden="true" />
          </Button>
        ))}
      </div>
      <TextField
        label={`Search ${label.toLowerCase()}`}
        error={error}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search folders…"
      />
      <div className="workflow-folder-results">
        {choices.slice(0, 30).map((path) => (
          <Button variant="secondary" key={path} onClick={() => onChange([...value, path])}>
            + {path || "Vault root"}
          </Button>
        ))}
        {choices.length > 30 && <p className="mds-hint">Keep typing to narrow {choices.length} folders.</p>}
        {!choices.length && <p className="mds-hint">No matching folders.</p>}
      </div>
    </fieldset>
  );
}
