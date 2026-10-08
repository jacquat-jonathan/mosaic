import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Download, FolderOpen, Info, Keyboard, Palette, PenLine, RefreshCw, X } from "lucide-react";
import { useUi, type SettingsSection } from "../state/ui";
import { DEFAULT_PREFS, NOTE_SIZE_MAX, NOTE_SIZE_MIN, useSettings, type NoteWidth, type Theme, type Prefs } from "../state/settings";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { leaveAllDrafts } from "../state/drafts";
import { api, onUpdateDone, onUpdateLog, pickFolder, revealInFinder } from "../ipc/api";
import { errorMessage, type UpdateCheck, type UpdateStatus } from "../ipc/types";
import { commands, formatKeys, keysFor, rebind, type Keys } from "../commands";
import { createVault, openVaultFolder } from "../actions";
import { renderInlineMarkdown } from "../markdown";
import { openExternal } from "../ipc/api";
import { TemplatesSettings } from "./TemplatesSettings";
import { AppearanceExtras, AppPreference, CalendarLinks, SectionReset, VaultFolders, WorkspacePreferences } from "./Personalization";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "editor", label: "Editor & files", icon: PenLine },
  { id: "vault", label: "Vault folders", icon: FolderOpen },
  { id: "templates", label: "Templates", icon: PenLine },
  { id: "calendar", label: "Calendar & links", icon: PenLine },
  { id: "workspace", label: "Workspace", icon: FolderOpen },
  { id: "ai", label: "Connections & safety", icon: PenLine },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "about", label: "About & updates", icon: Info },
];

export function Settings() {
  const [query, setQuery] = useState("");
  const section = useUi((s) => s.settings) ?? "appearance";
  const close = () => { const ws = useWorkspace.getState(); ws.closeTab(ws.focused, "mosaic:settings"); };
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="settings-workspace">
      <div
        className="settings"
        role="region"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          <input aria-label="Search settings" placeholder="Search settings…" value={query} onChange={e => setQuery(e.target.value)} />
          {!!query && <div className="settings-search-results">{SECTIONS.filter(s => (`${s.label} ${SETTING_WORDS[s.id] ?? ""}`).toLowerCase().includes(query.toLowerCase())).map(s => <button key={s.id} onClick={() => { useUi.getState().openSettings(s.id); setQuery(""); }}>{s.label} →</button>)}{!SECTIONS.some(s => (`${s.label} ${SETTING_WORDS[s.id] ?? ""}`).toLowerCase().includes(query.toLowerCase())) && <p role="status">No matching settings.</p>}</div>}
          {SECTIONS.map((s) => (
            <button key={s.id} className={s.id === section ? "active" : ""} aria-current={s.id === section} onClick={() => useUi.getState().openSettings(s.id)}>
              <s.icon size={15} /> {s.label}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          <header className="settings-head">
            <h2>{current.label}</h2>
            <button aria-label="Close settings" title="Close settings" onClick={close}>
              <X size={16} />
            </button>
          </header>
          <div className="settings-scroll">
            {section === "appearance" && <Appearance />}
            {section === "editor" && <EditorFiles />}
            {section === "vault" && <><VaultSection /><VaultFolders /></>}
            {section === "templates" && <TemplatesSettings />}
            {section === "calendar" && <CalendarLinks />}
            {section === "workspace" && <WorkspacePreferences />}
            {section === "ai" && <><p className="settings-note">Connection setup and agent permissions live together in the AI workspace. Folder review rules always take precedence over workflow allowances.</p><button onClick={() => useUi.getState().openView("connections")}>Open Connections & safety</button></>}
            {section === "shortcuts" && <Shortcuts />}
            {section === "about" && <About />}
          </div>
        </section>
      </div>
    </div>
  );
}
const SETTING_WORDS: Partial<Record<SettingsSection, string>> = {
  appearance: "theme system light dark note text size width font code font line spacing heading scale accent color interface scale density preview local fallback",
  editor: "spellcheck source line numbers trash confirmation",
  vault: "agents daily notes folder template new notes attachments folder colors creation discovery current root fixed missing create folder",
  templates: "templates defaults folder assignments rules starters preview",
  calendar: "week starts monday sunday daily file name format new link syntax wiki markdown open note links new tab",
  workspace: "startup destination restore previous plan today specific note sidebar context panel visibility default width",
  shortcuts: "keyboard shortcuts bindings", about: "version updates download installation CLI release source", ai: "connections permissions review safety Claude MCP",
};

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const key = ({ Theme:"theme", "Note text size":"noteSize", "Note width":"noteWidth", Spellcheck:"spellcheck", "Ask before moving to the Trash":"confirmTrash" } as Record<string, keyof Prefs>)[label];
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}{key && <button aria-label={`Reset ${label}`} title="Reset to default" onClick={() => useSettings.getState().set(key, DEFAULT_PREFS[key])}>↺</button>}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Appearance() {
  const s = useSettings();
  return (
    <>
      <Row label="Theme" hint="System follows macOS. Open diagrams, canvases and drawings switch colours right away.">
        <Segmented<Theme>
          label="Theme"
          value={s.theme}
          onChange={(v) => s.set("theme", v)}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Row>
      <Row label="Note text size" hint="Text size in Markdown notes.">
        <div className="range">
          <input
            type="range"
            min={NOTE_SIZE_MIN}
            max={NOTE_SIZE_MAX}
            value={s.noteSize}
            aria-label="Note text size"
            onChange={(e) => s.set("noteSize", Number(e.target.value))}
          />
          <span className="range-value">{s.noteSize}px</span>
        </div>
      </Row>
      <Row label="Note width" hint="How wide the text of a note gets. Full uses the whole pane; the others keep lines comfortable to read.">
        <Segmented<NoteWidth>
          label="Note width"
          value={s.noteWidth}
          options={[
            { value: "narrow", label: "Narrow" },
            { value: "medium", label: "Medium" },
            { value: "wide", label: "Wide" },
            { value: "full", label: "Full" },
          ]}
          onChange={(v) => s.set("noteWidth", v)}
        />
      </Row>
      <AppearanceExtras />
    </>
  );
}

function EditorFiles() {
  const s = useSettings();
  return (
    <>
      <Row label="Spellcheck" hint="Underline misspelled words in notes.">
        <Toggle label="Spellcheck" checked={s.spellcheck} onChange={(v) => s.set("spellcheck", v)} />
      </Row>
      <AppPreference name="sourceLineNumbers" label="Source line numbers" hint="Applies to source/code editors, not Markdown live preview." />
      <Row label="Ask before moving to the Trash" hint="Files always go to the macOS Trash, so they can be restored either way.">
        <Toggle label="Ask before moving to the Trash" checked={s.confirmTrash} onChange={(v) => s.set("confirmTrash", v)} />
      </Row>
      <p className="settings-note">Daily notes, new note destinations and attachments are configured per vault in Vault folders. Connections and agent safety are in the AI workspace.</p>
      <SectionReset keys={["spellcheck", "sourceLineNumbers", "confirmTrash"]} label="Editor" />
    </>
  );
}

function VaultSection() {
  const vault = useVault((s) => s.vault);
  if (!vault) return null;
  return (
    <>
      <Row label={vault.name} hint={<code className="path">{vault.root}</code>}>
        <button className="secondary" onClick={() => void revealInFinder("")}>
          Reveal in Finder
        </button>
      </Row>
      <Row label="Another vault" hint="Any folder works, including an existing Obsidian vault. Recent vaults are in the menu under the vault name.">
        <div className="button-row">
          <button className="secondary" onClick={() => void openVaultFolder()}>
            Open folder…
          </button>
          <button className="secondary" onClick={() => void createVault()}>
            Create new…
          </button>
        </div>
      </Row>
      <p className="settings-note">
        Mosaic keeps its search index and your bookmarks outside the vault; the vault only ever holds your own files.
      </p>
    </>
  );
}

const TREE_KEYS: [string, string][] = [
  ["⌘-click", "Add or remove a file from the selection"],
  ["⇧-click", "Select a range"],
  ["⌥-click", "Open in a new tab"],
  ["↵", "Rename the selected file"],
  ["⌘⌫", "Move the selection to the Trash"],
  ["⌘A", "Select everything visible"],
  ["esc", "Clear the selection"],
];

function Shortcuts() {
  const custom = useSettings((s) => s.shortcuts);
  const set = useSettings((s) => s.set);
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    // Captures the next key combination for `recording` (before the app's own shortcuts see it).
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return;
      if (e.key === "Escape") return setRecording(null);
      if (e.key === "Backspace" && !e.metaKey) {
        set("shortcuts", rebind(recording, null).shortcuts);
        setNote(null);
        return setRecording(null);
      }
      if (!e.metaKey) return setNote("Shortcuts start with ⌘ (add ⇧ or ⌥ if you like). Esc cancels, ⌫ removes the shortcut.");
      const keys: Keys = { code: e.code, meta: true, shift: e.shiftKey || undefined, alt: e.altKey || undefined };
      const { shortcuts, tookFrom } = rebind(recording, keys);
      set("shortcuts", shortcuts);
      setNote(tookFrom ? `${formatKeys(keys)} was used by “${tookFrom}”, which now has no shortcut.` : null);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, set]);

  const list = commands();
  return (
    <>
      <p className="settings-note">Click a shortcut to change it, then press the new keys. Every command can have one.</p>
      {note && <p className="warn-text">{note}</p>}
      <table className="shortcut-table">
        <tbody>
          {list.map((c) => {
            const k = keysFor(c);
            const changed = custom[c.id] !== undefined;
            return (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td>
                  <button
                    className={`shortcut-key ${recording === c.id ? "recording" : ""} ${changed ? "changed" : ""}`}
                    title={recording === c.id ? "Press the new keys · Esc cancels · ⌫ removes" : "Change this shortcut"}
                    onClick={() => {
                      setNote(null);
                      setRecording(recording === c.id ? null : c.id);
                    }}
                  >
                    {recording === c.id ? "Press keys…" : k ? <kbd>{formatKeys(k)}</kbd> : <span className="muted">None</span>}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {Object.keys(custom).length > 0 && (
        <button className="secondary" onClick={() => set("shortcuts", {})}>
          Reset all shortcuts
        </button>
      )}
      <h3>In the file tree</h3>
      <table className="shortcut-table">
        <tbody>
          {TREE_KEYS.map(([k, what]) => (
            <tr key={k}>
              <td>{what}</td>
              <td>
                <kbd>{k}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="settings-note">Every command, with or without a shortcut, is in the command palette (⌘P).</p>
    </>
  );
}

// ---------- About & updates ----------

interface UpdateFlow {
  log: string[];
  phase: "idle" | "running" | "built" | "failed" | "cancelled";
  error: string | null;
}

/** Update progress outlives the Settings panel, so closing it doesn't lose the build log. */
export const useUpdateFlow = create<UpdateFlow>(() => ({ log: [], phase: "idle", error: null }));
const LOG_LIMIT = 2000;

/** Subscribes to the backend's update events once, at startup. */
export async function startUpdateListeners(): Promise<() => void> {
  const offLog = await onUpdateLog((line) =>
    useUpdateFlow.setState((s) => ({ log: s.log.length >= LOG_LIMIT ? [...s.log.slice(-LOG_LIMIT + 1), line] : [...s.log, line] })),
  );
  const offDone = await onUpdateDone((d) =>
    useUpdateFlow.setState(d.ok ? { phase: "built", error: null } : d.cancelled ? { phase: "cancelled", error: null } : { phase: "failed", error: d.error }),
  );
  return () => {
    offLog();
    offDone();
  };
}

/** Saves every note with unsaved edits; resolves false if any save failed. */
async function saveAll(): Promise<boolean> {
  const ws = useWorkspace.getState();
  const dirty = Object.values(ws.buffers).filter((b) => b.dirty && !b.conflict && !b.deleted);
  await Promise.all(dirty.map((b) => ws.save(b.path)));
  return Object.values(useWorkspace.getState().buffers).every((b) => !b.dirty);
}

function About() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flow = useUpdateFlow();
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    api.updateStatus().then(
      (st) => {
        setStatus(st);
        // A build that finished while Settings was closed (or before a reload) is still waiting.
        if (st.ready_to_install && useUpdateFlow.getState().phase === "idle") useUpdateFlow.setState({ phase: "built" });
        if (st.running) useUpdateFlow.setState({ phase: "running" });
      },
      (e) => setError(errorMessage(e)),
    );
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [flow.log.length]);

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setCheck(await api.checkUpdates());
    } catch (e) {
      setCheck(null);
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const changeSource = async (reset: boolean) => {
    const path = reset ? null : await pickFolder("Choose the Mosaic source folder (the git checkout)");
    if (!reset && !path) return;
    try {
      setStatus(await api.setUpdateSource(path));
      setCheck(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const update = async () => {
    setError(null);
    useUpdateFlow.setState({ log: [], phase: "running", error: null });
    try {
      await api.startUpdate();
    } catch (e) {
      useUpdateFlow.setState({ phase: "failed", error: errorMessage(e) });
    }
  };

  const cancel = async () => {
    try {
      await api.cancelUpdate();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const restart = async () => {
    if (!(await leaveAllDrafts())) return;
    if (!(await saveAll())) {
      setError("Some notes couldn't be saved. Resolve them first, then restart.");
      return;
    }
    try {
      await api.finishUpdate();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (!status) return error ? <p className="error-text">{error}</p> : <p className="settings-note">Loading…</p>;
  const dev = status.app_path === null;
  const binary = status.mode === "binary";
  const canUpdate = !dev && !status.source_problem && flow.phase !== "running";
  const hasNews = !!check && (check.behind.length > 0 || check.installed_outdated);

  return (
    <>
      <Row label={status.commit ? `Mosaic ${status.version} (${status.commit})` : `Mosaic ${status.version}`} hint={status.commit ? undefined : "Build commit unknown"}>
        {dev ? <span className="badge">Development build</span> : <span className="badge">{status.app_path}</span>}
      </Row>
      {status.last_install_error && (
        <p className="warn-text">The last update was built but not installed: {status.last_install_error}</p>
      )}
      <details className="settings-note"><summary>Developer option · source builds</summary><Row
        label="Source folder"
        hint={
          <>
            <code className="path">{status.source_dir}</code>
            {status.source_problem && <span className="warn-text">{status.source_problem}</span>}
          </>
        }
      >
        <div className="button-row">
          <button className="secondary" onClick={() => void changeSource(false)}>
            Change…
          </button>
          <button className="secondary" title="Use downloadable releases" onClick={() => void changeSource(true)}>
            Use releases
          </button>
        </div>
      </Row></details>

      <div className="update-box">
        <p className="settings-note">
          {binary ? "Mosaic downloads signed universal packages from GitHub Releases. No git, Node or Rust is needed. Checks and downloads use HTTPS only when you click; there is no background polling or telemetry." : <>Developer mode: pulls source commits and rebuilds with <code>scripts/install.sh</code>, only when you click.</>}
        </p>
        {dev && <p className="warn-text">This is a development build (pnpm dev); it can't replace itself. Use scripts/install.sh.</p>}
        <div className="button-row">
          <button className="secondary" disabled={checking || !!status.source_problem || flow.phase === "running"} onClick={() => void runCheck()}>
            <RefreshCw size={14} className={checking ? "spin" : ""} /> {checking ? "Checking…" : "Check for updates"}
          </button>
          {flow.phase === "running" && (
            <button className="secondary" title="Stop the build; the installed app stays as it is" onClick={() => void cancel()}>
              <X size={14} /> Cancel
            </button>
          )}
          {flow.phase !== "built" && flow.phase !== "running" && (
            <button
              className={hasNews ? "primary" : "secondary"}
              disabled={!canUpdate || (binary && !hasNews)}
              title={check && !hasNews ? "Rebuild the current source anyway" : undefined}
              onClick={() => void update()}
            >
              <Download size={14} /> {binary ? "Download update" : check && !hasNews ? "Rebuild anyway" : "Update"}
            </button>
          )}
          {flow.phase === "built" && (
            <button className="primary" onClick={() => void restart()}>
              Restart to finish
            </button>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}

        {check && (
          <div className="update-result">
            {check.releases.length > 0 && (
              <>
                <p>
                  Mosaic {check.releases[0].version} is available (you have {status.version}).
                </p>
                {check.releases.map((r) => (
                  <div key={r.version} className="release">
                    <p className="release-head">
                      {r.version} {r.date && <span className="settings-note">{r.date}</span>}
                    </p>
                    <ul>
                      {r.notes.map((n, i) => (
                        <li key={i} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(n) }} onClick={e => {
                          const link = (e.target as HTMLElement).closest("a");
                          if (link) { e.preventDefault(); void openExternal(link.href); }
                        }} />
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )}
            {binary ? <p>{hasNews ? "The package is verified before installation. Your vault and settings are preserved." : check.latest_version ? "You're up to date with downloadable releases." : "No complete signed downloadable release is available yet."}</p> : check.behind.length > 0 ? (
              <details className="commit-details" open={check.releases.length === 0}>
                <summary>
                  {check.behind.length} new {check.behind.length === 1 ? "commit" : "commits"} on <code>{check.upstream}</code>
                </summary>
                <ul className="commit-list">
                  {check.behind.map((c) => (
                    <li key={c.hash}>
                      <code>{c.hash}</code> {c.subject}
                    </li>
                  ))}
                </ul>
              </details>
            ) : check.installed_outdated ? (
              <p>
                No new commits on <code>{check.upstream}</code>, but the source folder (at <code>{check.source_head}</code>) is newer
                than this app. Update to rebuild it.
              </p>
            ) : (
              <p>You're up to date with <code>{check.upstream}</code>.</p>
            )}
            {check.ahead > 0 && (
              <p className="settings-note">
                The source folder has {check.ahead} local {check.ahead === 1 ? "commit" : "commits"} that aren't on {check.upstream}; they're
                included in the build.
              </p>
            )}
            {check.dirty && (
              <p className="warn-text">The source folder has uncommitted changes. git pull may refuse to run until you commit or stash them.</p>
            )}
          </div>
        )}

        {flow.phase === "running" && <p className="settings-note">{binary ? "Downloading and verifying…" : "Building…"} You can keep working meanwhile.</p>}
        {flow.phase === "built" && <p className="ok-text">The new version is ready. Restart to switch to it; unsaved notes are saved first. The previous app is retained for recovery.</p>}
        {binary && <p className="settings-note">Mosaic is ad-hoc signed, not Apple-notarized. macOS may ask you to approve it in Privacy & Security. Mosaic never disables Gatekeeper or removes quarantine. Restart connected MCP clients after updating.</p>}
        {flow.phase === "failed" && flow.error && <p className="error-text">{flow.error}</p>}
        {flow.phase === "cancelled" && <p className="settings-note">Update cancelled. The installed app wasn't changed.</p>}
        {flow.log.length > 0 && (
          <details className="update-log" open={flow.phase !== "built"}>
            <summary>Update log</summary>
            <pre ref={logRef}>{flow.log.join("\n")}</pre>
          </details>
        )}
      </div>
    </>
  );
}
