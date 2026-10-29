import { useId, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button, IconButton, Notice, SettingRow, Switch } from "../design-system/components";
import { DEFAULT_PREFS, useSettings } from "../state/settings";
import { DEFAULT_VAULT_PREFS, saveVaultPreferences, useVaultPreferences } from "../state/vaultPreferences";
import { useUi } from "../state/ui";
import { errorMessage } from "../ipc/types";
import { DesignSystemScope } from "./DesignSystemScope";
import "./editorFilesSettings.css";

const EDITOR_PREFERENCES = [
  { name: "spellcheck", label: "Spellcheck", hint: "Underline misspelled words in notes." },
  {
    name: "sourceLineNumbers",
    label: "Source line numbers",
    hint: "Applies to source/code editors, not Markdown live preview.",
  },
  {
    name: "confirmTrash",
    label: "Ask before moving to the Trash",
    hint: "Files always go to the macOS Trash, so they can be restored either way.",
  },
] as const;

function EditorPreference({ name, label, hint }: (typeof EDITOR_PREFERENCES)[number]) {
  const checked = useSettings((s) => s[name]);
  const id = useId();
  return (
    <SettingRow label={label} hint={hint} controlId={id} hintId={`${id}-hint`}>
      <Switch
        id={id}
        label={label}
        aria-describedby={`${id}-hint`}
        checked={checked}
        onCheckedChange={(value) => useSettings.getState().set(name, value)}
      />
      <IconButton label={`Reset ${label}`} onClick={() => useSettings.getState().set(name, DEFAULT_PREFS[name])}>
        <RotateCcw aria-hidden="true" />
      </IconButton>
    </SettingRow>
  );
}

function HtmlPreviewPreference() {
  const { root, value, error: loadError } = useVaultPreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const problem = error ?? loadError;
  const disabled = busy || !root || !!loadError;
  const update = async (checked: boolean) => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      await saveVaultPreferences({ allow_html_scripts: checked });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingRow
        label="Allow scripts in HTML previews"
        hint="Allows scripts by default for HTML files in this vault. Each preview can override this for the current session. Internet access is requested separately and remains blocked by default."
        controlId={id}
        hintId={`${id}-hint`}
      >
        <Switch
          id={id}
          label="Allow scripts in HTML previews"
          aria-describedby={`${id}-hint${problem ? ` ${id}-error` : ""}`}
          checked={value.allow_html_scripts}
          disabled={disabled}
          onCheckedChange={(checked) => void update(checked)}
        />
        <IconButton
          label="Reset Allow scripts in HTML previews"
          disabled={disabled}
          onClick={() => void update(DEFAULT_VAULT_PREFS.allow_html_scripts)}
        >
          <RotateCcw aria-hidden="true" />
        </IconButton>
      </SettingRow>
      {busy && (
        <p className="mds-hint editor-settings-note" role="status">
          Saving HTML preview policy…
        </p>
      )}
      {problem && (
        <div id={`${id}-error`}>
          <Notice tone="error">{problem}</Notice>
        </div>
      )}
    </>
  );
}

export function EditorFilesSettings() {
  const root = useVaultPreferences((s) => s.root);
  return (
    <DesignSystemScope className="editor-files-settings" role="group" aria-label="Editor & files preferences">
      {EDITOR_PREFERENCES.map((preference) => (
        <EditorPreference key={preference.name} {...preference} />
      ))}
      <p className="mds-hint editor-settings-note">HTML preview policy is stored for the open vault.</p>
      <HtmlPreviewPreference key={root} />
      <p className="mds-hint editor-settings-note">
        Daily notes, new note destinations and attachments are configured per vault in Vault folders. Connections and
        agent safety are in the AI workspace.
      </p>
      <Button
        variant="secondary"
        className="editor-section-reset"
        onClick={(event) => {
          const opener = event.currentTarget;
          void useUi
            .getState()
            .ask({
              title: "Reset Editor?",
              body: "Only this app-wide section returns to its defaults. Vault files, templates, permissions and history are unchanged.",
              confirmLabel: "Reset section",
            })
            .then((accepted) => {
              if (accepted)
                for (const { name } of EDITOR_PREFERENCES) useSettings.getState().set(name, DEFAULT_PREFS[name]);
              if (opener.isConnected) opener.focus({ preventScroll: true });
            });
        }}
      >
        Reset Editor…
      </Button>
    </DesignSystemScope>
  );
}
