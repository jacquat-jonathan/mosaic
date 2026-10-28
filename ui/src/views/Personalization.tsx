import { useState, type ReactNode } from "react";
import { DEFAULT_PREFS, useSettings, type Prefs } from "../state/settings";
import {
  DEFAULT_VAULT_PREFS,
  saveVaultPreferences,
  useVaultPreferences,
  type VaultPreferences,
} from "../state/vaultPreferences";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { api } from "../ipc/api";
import { dailyPath } from "../daily";

function Field({ label, hint, children, reset }: { label: string; hint?: string; children: ReactNode; reset(): void }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">
        {children}
        <button
          type="button"
          className="setting-reset"
          aria-label={`Reset ${label}`}
          title="Reset to default"
          onClick={reset}
        >
          ↺
        </button>
      </div>
    </div>
  );
}
const CHOICE_LABELS: Record<string, string> = {
  current: "Current file's folder",
  root: "Vault root",
  folder: "Selected folder",
  "next-to-note": "Next to note",
  restore: "Restore previous workspace",
  today: "Plan Today",
  note: "Specific note",
  wiki: "Wiki [[title]]",
  markdown: "Markdown [title](path)",
};
const choose = (label: string, value: string, options: readonly string[], change: (v: string) => void) => (
  <select aria-label={label} value={value} onChange={(e) => change(e.target.value)}>
    {options.map((v) => (
      <option key={v} value={v}>
        {CHOICE_LABELS[v] ?? v}
      </option>
    ))}
  </select>
);
export function AppPreference({
  name,
  label,
  hint,
  options,
  min,
  max,
  step,
}: {
  name: keyof Prefs;
  label: string;
  hint?: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
}) {
  const s = useSettings();
  const value = s[name];
  return (
    <Field label={label} hint={hint} reset={() => s.set(name, DEFAULT_PREFS[name])}>
      {options ? (
        choose(label, String(value), options, (v) => s.set(name, v as never))
      ) : typeof value === "boolean" ? (
        <input
          type="checkbox"
          aria-label={label}
          checked={value}
          onChange={(e) => s.set(name, e.target.checked as never)}
        />
      ) : typeof value === "number" ? (
        <>
          <input
            type="range"
            aria-label={label}
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => s.set(name, Number(e.target.value) as never)}
          />
          <output>{value}</output>
        </>
      ) : (
        <input aria-label={label} value={String(value)} onChange={(e) => s.set(name, e.target.value as never)} />
      )}
    </Field>
  );
}
export function SectionReset({ keys, label }: { keys: (keyof Prefs)[]; label: string }) {
  return (
    <button
      className="secondary"
      onClick={() =>
        void useUi
          .getState()
          .ask({
            title: `Reset ${label}?`,
            body: "Only this app-wide section returns to its defaults. Vault files, templates, permissions and history are unchanged.",
            confirmLabel: "Reset section",
          })
          .then((ok) => {
            if (ok) for (const key of keys) useSettings.getState().set(key, DEFAULT_PREFS[key]);
          })
      }
    >
      Reset {label}…
    </button>
  );
}

function VaultField({
  name,
  label,
  hint,
  options,
  note = false,
}: {
  name: keyof VaultPreferences;
  label: string;
  hint?: string;
  options?: readonly string[];
  note?: boolean;
}) {
  const { value, root } = useVaultPreferences();
  const entries = useVault((s) => s.entries);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const path = String(value[name]);
  const update = async (next: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveVaultPreferences({ [name]: next });
      if (name === "agents_folder") await api.mirrorAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const picker = () =>
    useUi.getState().openPicker({
      placeholder: `Choose ${label.toLowerCase()}`,
      items: [
        ...(!note && name !== "agents_folder"
          ? [{ id: "", label: "Vault root" }]
          : note
            ? [{ id: "", label: "None" }]
            : []),
        ...entries
          .filter((e) => (note ? !e.is_dir && e.path.endsWith(".md") : e.is_dir))
          .map((e) => ({ id: e.path, label: e.path })),
      ],
      onPick: (item) => void update(item.id),
    });
  const missing = !options && !!path && !entries.some((e) => e.path === path);
  return (
    <>
      <Field label={label} hint={hint} reset={() => void update(DEFAULT_VAULT_PREFS[name])}>
        {options ? (
          choose(label, path, options, (v) => void update(v))
        ) : (
          <>
            <button disabled={busy || !root} aria-label={label} onClick={picker}>
              {path || (note ? "None" : "Vault root")}…
            </button>
            {!note && (
              <button
                disabled={busy || !root}
                aria-label={`Set ${label.toLowerCase()} path`}
                onClick={() =>
                  void useUi
                    .getState()
                    .askText({ title: `Set ${label.toLowerCase()}`, value: path, placeholder: "Vault-relative folder" })
                    .then((next) => {
                      if (next !== null) void update(next);
                    })
                }
              >
                Set path…
              </button>
            )}
          </>
        )}
      </Field>
      {missing && (
        <p className="notice warn">
          Missing: <code>{path}</code>. Choose a replacement
          {!note && (
            <>
              {" "}
              or{" "}
              <button
                disabled={busy}
                onClick={() =>
                  void api
                    .mkdir(path)
                    .then(() => useVault.getState().refresh())
                    .catch((e) => setError(String(e)))
                }
              >
                Create folder
              </button>
            </>
          )}
          .
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
export function CalendarLinks() {
  const { value } = useVaultPreferences();
  return (
    <>
      <p className="settings-note">
        Week start and link opening apply app-wide. File names and generated syntax belong to the open vault.
      </p>
      <AppPreference name="weekStart" label="Week starts on" options={["monday", "sunday"]} />
      <VaultField
        name="daily_format"
        label="Daily file name"
        options={["YYYY-MM-DD", "DD-MM-YYYY", "YYYYMMDD"]}
        hint="Unambiguous patterns only. Existing ISO notes still work; duplicate dates require repair. No files are renamed."
      />
      <p className="settings-note">
        Preview: <code>{dailyPath(value.daily_folder, new Date(2026, 9, 8), value.daily_format)}</code>
      </p>
      <VaultField
        name="link_style"
        label="New link syntax"
        options={["wiki", "markdown"]}
        hint="Only new Mosaic-generated links change. Both styles remain readable."
      />
      <AppPreference
        name="openLinksNewTab"
        label="Open note links in a new tab"
        hint="Explicit new-tab modifiers and commands take precedence. External links still open in your browser."
      />
      <SectionReset keys={["weekStart", "openLinksNewTab"]} label="Calendar app preferences" />
    </>
  );
}
export function WorkspacePreferences() {
  const startup = useSettings((s) => s.startup);
  return (
    <>
      <p className="settings-note">
        App-wide · Sidebar defaults apply to fresh layouts, not to an already restored or resized workspace.
      </p>
      <AppPreference
        name="startup"
        label="Startup destination"
        options={["restore", "today", "note"]}
        hint="Restore previous workspace, Plan Today, or a note. Never creates a daily note or runs an agent."
      />
      {startup === "note" && (
        <VaultField
          name="startup_note"
          label="Startup note"
          note
          hint="Vault-specific. Missing notes fall back to your restored workspace."
        />
      )}
      <AppPreference name="sidebarVisible" label="Show left sidebar by default" />
      <AppPreference name="sidebarWidth" label="Default left sidebar width" min={180} max={600} step={10} />
      <AppPreference name="contextVisible" label="Show context panel by default" />
      <AppPreference name="contextWidth" label="Default context panel width" min={180} max={600} step={10} />
      <SectionReset
        keys={["startup", "sidebarVisible", "sidebarWidth", "contextVisible", "contextWidth"]}
        label="Workspace"
      />
    </>
  );
}
