import { useId } from "react";
import { RotateCcw } from "lucide-react";
import { Button, IconButton, SettingRow, Switch } from "../design-system/components";
import { DEFAULT_PREFS, useSettings, type Prefs } from "../state/settings";
import { useUi } from "../state/ui";

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
  options?: readonly (readonly [string, string])[];
  min?: number;
  max?: number;
  step?: number;
}) {
  const value = useSettings((state) => state[name]);
  const set = useSettings.getState().set;
  const id = useId();
  return (
    <SettingRow label={label} hint={hint} controlId={id} hintId={`${id}-hint`}>
      {options ? (
        <select
          id={id}
          className="mds-input"
          aria-describedby={hint ? `${id}-hint` : undefined}
          value={String(value)}
          onChange={(event) => set(name, event.target.value as never)}
        >
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      ) : typeof value === "number" ? (
        <div className="preference-range">
          <input
            id={id}
            className="mds-range"
            type="range"
            min={min}
            max={max}
            step={step}
            aria-describedby={hint ? `${id}-hint` : undefined}
            value={value}
            aria-valuetext={`${value} pixels`}
            onChange={(event) => set(name, Number(event.target.value) as never)}
          />
          <output htmlFor={id}>{value} px</output>
        </div>
      ) : (
        <Switch
          id={id}
          label={label}
          aria-describedby={hint ? `${id}-hint` : undefined}
          checked={!!value}
          onCheckedChange={(checked) => set(name, checked as never)}
        />
      )}
      <IconButton label={`Reset ${label}`} onClick={() => set(name, DEFAULT_PREFS[name])}>
        <RotateCcw aria-hidden="true" />
      </IconButton>
    </SettingRow>
  );
}

export function SectionReset({ keys, label }: { keys: (keyof Prefs)[]; label: string }) {
  return (
    <Button
      variant="secondary"
      className="preference-section-reset"
      onClick={(event) => {
        const opener = event.currentTarget;
        void useUi
          .getState()
          .ask({
            title: `Reset ${label}?`,
            body: "Only this app-wide section returns to its defaults. Vault files, templates, permissions and history are unchanged.",
            confirmLabel: "Reset section",
          })
          .then((accepted) => {
            if (accepted) for (const key of keys) useSettings.getState().set(key, DEFAULT_PREFS[key]);
            if (opener.isConnected) opener.focus({ preventScroll: true });
          });
      }}
    >
      Reset {label}…
    </Button>
  );
}
