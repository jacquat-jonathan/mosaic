import { useId, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button, IconButton, Notice, SettingRow } from "../design-system/components";
import { dailyPath } from "../daily";
import { errorMessage } from "../ipc/types";
import { useVault } from "../state/vault";
import {
  DEFAULT_VAULT_PREFS,
  loadVaultPreferences,
  saveVaultPreferences,
  useVaultPreferences,
} from "../state/vaultPreferences";
import { DesignSystemScope } from "./DesignSystemScope";
import { AppPreference, SectionReset } from "./PreferenceControls";
import "./preferenceSettings.css";

const VAULT_CHOICES = [
  {
    name: "daily_format",
    label: "Daily file name",
    hint: "Unambiguous patterns only. Existing ISO notes still work; duplicate dates require repair. No files are renamed.",
    options: [
      ["YYYY-MM-DD", "YYYY-MM-DD"],
      ["DD-MM-YYYY", "DD-MM-YYYY"],
      ["YYYYMMDD", "YYYYMMDD"],
    ],
  },
  {
    name: "link_style",
    label: "New link syntax",
    hint: "Only new Mosaic-generated links change. Both styles remain readable.",
    options: [
      ["wiki", "Wiki [[title]]"],
      ["markdown", "Markdown [title](path)"],
    ],
  },
] as const;

function VaultChoices({ root }: { root: string | null }) {
  const { value, error: loadError } = useVaultPreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const id = useId();
  const problem = error ?? loadError;
  const current = () =>
    !!root && useVault.getState().vault?.root === root && useVaultPreferences.getState().root === root;
  const disabled = busy || !current() || !!loadError;
  const update = async (name: "daily_format" | "link_style", next: string) => {
    if (pending.current || !current() || useVaultPreferences.getState().error) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveVaultPreferences({ [name]: next });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      {VAULT_CHOICES.map(({ name, label, hint, options }) => (
        <div key={name}>
          <SettingRow label={label} hint={hint} controlId={`${id}-${name}`} hintId={`${id}-${name}-hint`}>
            <select
              id={`${id}-${name}`}
              className="mds-input"
              value={value[name]}
              disabled={disabled}
              aria-describedby={`${id}-${name}-hint${problem ? ` ${id}-error` : ""}`}
              onChange={(event) => void update(name, event.target.value)}
            >
              {options.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <IconButton
              label={`Reset ${label}`}
              disabled={disabled}
              onClick={() => void update(name, DEFAULT_VAULT_PREFS[name])}
            >
              <RotateCcw aria-hidden="true" />
            </IconButton>
          </SettingRow>
          {name === "daily_format" && (
            <p className="mds-hint preference-note">
              Preview: <code>{dailyPath(value.daily_folder, new Date(2026, 9, 8), value.daily_format)}</code>
            </p>
          )}
        </div>
      ))}
      {busy && (
        <p className="mds-hint preference-note" role="status">
          Saving vault preferences…
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
      {!root && <Notice>Open a vault to configure daily file names and link syntax.</Notice>}
    </>
  );
}

export function CalendarLinksSettings() {
  const root = useVault((state) => state.vault?.root ?? null);
  return (
    <DesignSystemScope className="preference-settings" role="group" aria-label="Calendar & links preferences">
      <p className="mds-hint preference-note">
        Week start and link opening apply app-wide. File names and generated syntax belong to the open vault.
      </p>
      <AppPreference
        name="weekStart"
        label="Week starts on"
        options={[
          ["monday", "Monday"],
          ["sunday", "Sunday"],
        ]}
      />
      <VaultChoices key={root} root={root} />
      <AppPreference
        name="openLinksNewTab"
        label="Open note links in a new tab"
        hint="Explicit new-tab modifiers and commands take precedence. External links still open in your browser."
      />
      <SectionReset keys={["weekStart", "openLinksNewTab"]} label="Calendar app preferences" />
    </DesignSystemScope>
  );
}
