import { useId, useRef, useState } from "react";
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
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const problem = error ?? loadError;
  const disabled = busy || !root || !!loadError;
  const update = async (name: "allow_html_scripts" | "allow_html_internet", checked: boolean) => {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveVaultPreferences({ [name]: checked });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      {(
        [
          {
            name: "allow_html_scripts",
            label: "Allow scripts in HTML previews",
            hint: "Run scripts by default for HTML files in this vault. Internet access has its own setting below. Each preview can override scripts for the current session.",
          },
          {
            name: "allow_html_internet",
            label: "Allow internet in HTML previews",
            hint: "Load each HTML page’s listed external sites without asking. Each preview can block internet access for the current session. Scripts have their own setting above.",
          },
        ] as const
      ).map(({ name, label, hint }) => (
        <SettingRow key={name} label={label} hint={hint} controlId={`${id}-${name}`} hintId={`${id}-${name}-hint`}>
          <Switch
            id={`${id}-${name}`}
            label={label}
            aria-describedby={`${id}-${name}-hint${problem ? ` ${id}-error` : ""}`}
            checked={value[name]}
            disabled={disabled}
            onCheckedChange={(checked) => void update(name, checked)}
          />
          <IconButton
            label={`Reset ${label}`}
            disabled={disabled}
            onClick={() => void update(name, DEFAULT_VAULT_PREFS[name])}
          >
            <RotateCcw aria-hidden="true" />
          </IconButton>
        </SettingRow>
      ))}
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
      <h3 className="editor-settings-heading">Editing & files</h3>
      {EDITOR_PREFERENCES.map((preference) => (
        <EditorPreference key={preference.name} {...preference} />
      ))}
      <h3 className="editor-settings-heading">HTML previews</h3>
      <p className="mds-hint">These defaults belong to the open vault. Both are off by default.</p>
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
