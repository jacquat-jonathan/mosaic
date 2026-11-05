import { useEffect, useId, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button, IconButton, Notice, SettingRow } from "../design-system/components";
import { errorMessage } from "../ipc/types";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { loadVaultPreferences, saveVaultPreferences, useVaultPreferences } from "../state/vaultPreferences";
import { DesignSystemScope } from "./DesignSystemScope";
import { AppPreference, SectionReset } from "./PreferenceControls";
import "./preferenceSettings.css";

function StartupNote({ root }: { root: string | null }) {
  const { value, error: loadError } = useVaultPreferences();
  const entries = useVault((state) => state.entries);
  const picker = useUi((state) => state.picker);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusTarget, restoreFocus] = useState<HTMLElement | null>(null);
  const pickerOpener = useRef<HTMLElement | null>(null);
  const pending = useRef(false);
  const id = useId();
  const current = () =>
    !!root && useVault.getState().vault?.root === root && useVaultPreferences.getState().root === root;
  const disabled = busy || !current() || !!loadError;
  const problem = error ?? loadError;
  const path = value.startup_note;
  const missing = !!path && !entries.some((entry) => entry.path === path && !entry.is_dir);
  useEffect(() => {
    if (!picker && pickerOpener.current) {
      restoreFocus(pickerOpener.current);
      pickerOpener.current = null;
    }
  }, [picker]);
  useEffect(() => {
    if (!busy && !picker && focusTarget) {
      if (focusTarget.isConnected) focusTarget.focus({ preventScroll: true });
      restoreFocus(null);
    }
  }, [busy, picker, focusTarget]);
  const update = async (path: string) => {
    if (pending.current || !current() || useVaultPreferences.getState().error) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveVaultPreferences({ startup_note: path });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <SettingRow
        label="Startup note"
        hint="Vault-specific. Missing notes fall back to your restored workspace."
        controlId={id}
        hintId={`${id}-hint`}
      >
        <Button
          id={id}
          className="preference-path"
          variant="secondary"
          aria-label="Startup note"
          disabled={disabled}
          aria-describedby={`${id}-hint${missing ? ` ${id}-missing` : ""}${problem ? ` ${id}-error` : ""}`}
          onClick={(event) => {
            pickerOpener.current = event.currentTarget;
            useUi.getState().openPicker({
              placeholder: "Choose startup note",
              items: [
                { id: "", label: "None" },
                ...entries
                  .filter((entry) => !entry.is_dir && entry.path.endsWith(".md"))
                  .map((entry) => ({ id: entry.path, label: entry.path })),
              ],
              onPick: (item) => void update(item.id),
            });
          }}
        >
          {path || "None"}…
        </Button>
        <IconButton
          label="Reset Startup note"
          disabled={disabled}
          onClick={(event) => {
            restoreFocus(event.currentTarget);
            void update("");
          }}
        >
          <RotateCcw aria-hidden="true" />
        </IconButton>
      </SettingRow>
      {missing && (
        <div id={`${id}-missing`}>
          <Notice tone="warning">
            Missing: <code>{path}</code>. Choose a replacement. Your restored workspace will be used until this note is
            available.
          </Notice>
        </div>
      )}
      {busy && (
        <p className="mds-hint preference-note" role="status">
          Saving startup note…
        </p>
      )}
      {problem && (
        <div id={`${id}-error`}>
          <Notice tone="error">
            {problem}
            {loadError && root && (
              <>
                {" "}
                <Button variant="secondary" onClick={() => void loadVaultPreferences(root)}>
                  Retry vault preferences
                </Button>
              </>
            )}
          </Notice>
        </div>
      )}
      {!root && <Notice>Open a vault to choose its startup note.</Notice>}
    </>
  );
}

export function WorkspaceSettings() {
  const startup = useSettings((state) => state.startup);
  const root = useVault((state) => state.vault?.root ?? null);
  return (
    <DesignSystemScope className="preference-settings" role="group" aria-label="Workspace preferences">
      <p className="mds-hint preference-note">
        App-wide · Sidebar defaults apply to fresh layouts, not to an already restored or resized workspace.
      </p>
      <AppPreference
        name="startup"
        label="Startup destination"
        options={[
          ["restore", "Restore previous workspace"],
          ["today", "Plan Today"],
          ["note", "Specific note"],
        ]}
        hint="Restore previous workspace, Plan Today, or a note. Never creates a daily note or runs an agent."
      />
      {startup === "note" && <StartupNote key={root} root={root} />}
      <AppPreference name="sidebarVisible" label="Show left sidebar by default" />
      <AppPreference name="sidebarWidth" label="Default left sidebar width" min={180} max={600} step={10} />
      <AppPreference name="contextVisible" label="Show context panel by default" />
      <AppPreference name="contextWidth" label="Default context panel width" min={180} max={600} step={10} />
      <SectionReset
        keys={["startup", "sidebarVisible", "sidebarWidth", "contextVisible", "contextWidth"]}
        label="Workspace"
      />
    </DesignSystemScope>
  );
}
