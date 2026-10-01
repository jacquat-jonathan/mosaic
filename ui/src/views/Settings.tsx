import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Bot, Download, FolderOpen, Info, Keyboard, Palette, PenLine, RefreshCw, X } from "lucide-react";
import { useUi, type SettingsSection } from "../state/ui";
import { NOTE_SIZE_MAX, NOTE_SIZE_MIN, useSettings, type Theme } from "../state/settings";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { api, onUpdateDone, onUpdateLog, pickFolder, revealInFinder } from "../ipc/api";
import { errorMessage, type UpdateCheck, type UpdateStatus } from "../ipc/types";
import { commands, formatKeys } from "../commands";
import { createVault, openVaultFolder } from "../actions";
import { ConnectAiSection } from "./ConnectAi";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "editor", label: "Editor & files", icon: PenLine },
  { id: "vault", label: "Vault", icon: FolderOpen },
  { id: "ai", label: "AI", icon: Bot },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "about", label: "About & updates", icon: Info },
];

export function Settings() {
  const section = useUi((s) => s.settings);
  if (!section) return null;
  const close = () => useUi.getState().closeSettings();
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          {SECTIONS.map((s) => (
            <button key={s.id} className={s.id === section ? "active" : ""} aria-current={s.id === section} onClick={() => useUi.getState().openSettings(s.id)}>
              <s.icon size={15} /> {s.label}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          <header className="settings-head">
            <h2>{current.label}</h2>
            <button aria-label="Close settings" title="Close (esc)" onClick={close} autoFocus>
              <X size={16} />
            </button>
          </header>
          <div className="settings-scroll">
            {section === "appearance" && <Appearance />}
            {section === "editor" && <EditorFiles />}
            {section === "vault" && <VaultSection />}
            {section === "ai" && <ConnectAiSection />}
            {section === "shortcuts" && <Shortcuts />}
            {section === "about" && <About />}
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
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
      <Row label="Readable line width" hint="Keep notes to a comfortable line length instead of the full width of the pane.">
        <Toggle label="Readable line width" checked={s.readableWidth} onChange={(v) => s.set("readableWidth", v)} />
      </Row>
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
      <Row label="New notes go in" hint="Where ⌘N and the “New note” button create notes.">
        <Segmented
          label="New notes go in"
          value={s.newNoteLocation}
          onChange={(v) => s.set("newNoteLocation", v)}
          options={[
            { value: "current", label: "Current file's folder" },
            { value: "root", label: "Vault root" },
          ]}
        />
      </Row>
      <Row label="Ask before moving to the Trash" hint="Files always go to the macOS Trash, so they can be restored either way.">
        <Toggle label="Ask before moving to the Trash" checked={s.confirmTrash} onChange={(v) => s.set("confirmTrash", v)} />
      </Row>
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
  const list = commands().filter((c) => c.keys);
  return (
    <>
      <table className="shortcut-table">
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td>{c.label}</td>
              <td>
                <kbd>{formatKeys(c.keys!)}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  phase: "idle" | "running" | "built" | "failed";
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
  const offDone = await onUpdateDone((d) => useUpdateFlow.setState({ phase: d.ok ? "built" : "failed", error: d.error }));
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

  const restart = async () => {
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
  const canUpdate = !dev && !status.source_problem && flow.phase !== "running";
  const hasNews = !!check && (check.behind.length > 0 || check.installed_outdated);

  return (
    <>
      <Row label={`Mosaic ${status.version}`} hint={status.commit ? `Built from commit ${status.commit}` : "Build commit unknown"}>
        {dev ? <span className="badge">Development build</span> : <span className="badge">{status.app_path}</span>}
      </Row>
      <Row
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
          <button className="secondary" title="Use the folder this app was built from" onClick={() => void changeSource(true)}>
            Reset
          </button>
        </div>
      </Row>

      <div className="update-box">
        <p className="settings-note">
          Mosaic updates from its source: it pulls new commits with git, rebuilds with <code>scripts/install.sh</code> and restarts.
          This is the only time Mosaic uses the network, and only when you click.
        </p>
        {dev && <p className="warn-text">This is a development build (pnpm dev); it can't replace itself. Use scripts/install.sh.</p>}
        <div className="button-row">
          <button className="secondary" disabled={checking || !!status.source_problem || flow.phase === "running"} onClick={() => void runCheck()}>
            <RefreshCw size={14} className={checking ? "spin" : ""} /> {checking ? "Checking…" : "Check for updates"}
          </button>
          {flow.phase !== "built" && (
            <button
              className={hasNews ? "primary" : "secondary"}
              disabled={!canUpdate}
              title={check && !hasNews ? "Rebuild the current source anyway" : undefined}
              onClick={() => void update()}
            >
              <Download size={14} /> {check && !hasNews ? "Rebuild anyway" : "Update"}
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
            {check.behind.length > 0 ? (
              <>
                <p>
                  {check.behind.length} new {check.behind.length === 1 ? "commit" : "commits"} on <code>{check.upstream}</code>:
                </p>
                <ul className="commit-list">
                  {check.behind.map((c) => (
                    <li key={c.hash}>
                      <code>{c.hash}</code> {c.subject}
                    </li>
                  ))}
                </ul>
              </>
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

        {flow.phase === "running" && <p className="settings-note">Building… this takes a few minutes. You can keep working meanwhile.</p>}
        {flow.phase === "built" && <p className="ok-text">The new version is built. Restart to switch to it; unsaved notes are saved first.</p>}
        {flow.phase === "failed" && flow.error && <p className="error-text">{flow.error}</p>}
        {flow.log.length > 0 && (
          <details className="update-log" open={flow.phase !== "built"}>
            <summary>Build log</summary>
            <pre ref={logRef}>{flow.log.join("\n")}</pre>
          </details>
        )}
      </div>
    </>
  );
}
