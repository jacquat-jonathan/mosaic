import { useState } from "react";
import { useVault } from "../state/vault";

/** Searchable multi-select; selected missing paths remain visible and removable. */
export function FolderChoices({ label, value, onChange, root = false }: { label: string; value: string[]; onChange(value: string[]): void; root?: boolean }) {
  const [query, setQuery] = useState("");
  const folders = useVault(s => s.entries).filter(e => e.is_dir).map(e => e.path);
  const choices = [...(root ? [""] : []), ...folders].filter(path => !value.includes(path) && (path || "Vault root").toLowerCase().includes(query.toLowerCase()));
  return <fieldset className="folder-picker"><legend>{label}</legend>
    <div className="folder-chips">{value.map(path => <button type="button" key={path} aria-label={`Remove ${path || "Vault root"}`} onClick={() => onChange(value.filter(p => p !== path))}>{path || "Vault root"}{path && !folders.includes(path) ? " · missing" : ""} ×</button>)}</div>
    <input aria-label={`Search ${label.toLowerCase()}`} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search folders…" />
    <div className="folder-results">{choices.slice(0, 30).map(path => <button type="button" key={path} onClick={() => onChange([...value, path])}>+ {path || "Vault root"}</button>)}{choices.length > 30 && <p>Keep typing to narrow {choices.length} folders.</p>}{!choices.length && <p>No matching folders.</p>}</div>
  </fieldset>;
}
