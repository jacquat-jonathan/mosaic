import { useId, type CSSProperties, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Button, IconButton, SegmentedControl, SettingRow, SettingsGroup } from "../design-system/components";
import { DEFAULT_PREFS, NOTE_SIZE_MAX, NOTE_SIZE_MIN, useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { DesignSystemScope } from "./DesignSystemScope";
import { COLOR_THEMES } from "../colorThemes";
import "./appearanceSettings.css";

const APPEARANCE_KEYS = [
  "theme",
  "colorTheme",
  "noteSize",
  "noteWidth",
  "noteFont",
  "codeFont",
  "lineSpacing",
  "headingScale",
  "accent",
  "uiScale",
  "density",
] as const;
type AppearanceKey = (typeof APPEARANCE_KEYS)[number];
type ControlProps = { id: string; "aria-describedby"?: string };

function AppearanceRow({
  name,
  label,
  hint,
  grouped = false,
  children,
}: {
  name: AppearanceKey;
  label: string;
  hint?: string;
  grouped?: boolean;
  children(props: ControlProps): ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <SettingRow label={label} hint={hint} controlId={grouped ? undefined : id} hintId={hintId}>
      {children({ id, "aria-describedby": hintId })}
      <IconButton label={`Reset ${label}`} onClick={() => useSettings.getState().set(name, DEFAULT_PREFS[name])}>
        <RotateCcw aria-hidden="true" />
      </IconButton>
    </SettingRow>
  );
}

function RangePreference({
  name,
  label,
  hint,
  min,
  max,
  step = 1,
}: {
  name: "noteSize" | "lineSpacing" | "headingScale" | "uiScale";
  label: string;
  hint?: string;
  min: number;
  max: number;
  step?: number;
}) {
  const value = useSettings((s) => s[name]);
  const text =
    name === "noteSize" ? `${value}px` : name === "lineSpacing" ? String(value) : `${Math.round(value * 100)}%`;
  return (
    <AppearanceRow name={name} label={label} hint={hint}>
      {(control) => (
        <div className="appearance-range">
          <input
            {...control}
            className="mds-range"
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            aria-valuetext={text}
            onChange={(event) => useSettings.getState().set(name, Number(event.target.value))}
          />
          <output htmlFor={control.id}>{text}</output>
        </div>
      )}
    </AppearanceRow>
  );
}

function ColorThemePicker() {
  const selected = useSettings((state) => state.colorTheme);
  const id = useId();
  return (
    <section className="color-theme-setting" aria-labelledby={`${id}-label`}>
      <div className="color-theme-heading">
        <h3 id={`${id}-label`}>Color theme</h3>
        <IconButton
          label="Reset Color theme"
          onClick={() => useSettings.getState().set("colorTheme", DEFAULT_PREFS.colorTheme)}
        >
          <RotateCcw aria-hidden="true" />
        </IconButton>
      </div>
      <p className="mds-hint" id={`${id}-hint`}>
        Each palette has light and dark colors. System follows macOS.
      </p>
      <div className="color-theme-options" role="radiogroup" aria-label="Color theme" aria-describedby={`${id}-hint`}>
        {COLOR_THEMES.map((palette) => (
          <label key={palette.id} className="color-theme-option" data-selected={selected === palette.id}>
            <input
              type="radio"
              name={id}
              value={palette.id}
              aria-label={palette.name}
              checked={selected === palette.id}
              onChange={() => useSettings.getState().set("colorTheme", palette.id)}
            />
            <span className="color-theme-swatches" aria-hidden="true">
              {(["light", "dark"] as const).map((mode) => (
                <span
                  key={mode}
                  className="color-theme-swatch"
                  style={
                    {
                      "--swatch-bg": palette[mode].bg,
                      "--swatch-side": palette[mode].side,
                      "--swatch-text": palette[mode].text,
                      "--swatch-accent": palette[mode].accent,
                    } as CSSProperties
                  }
                >
                  <span />
                  <i />
                  <i />
                  <b />
                </span>
              ))}
            </span>
            <strong>{palette.name}</strong>
            <small>{palette.description}</small>
          </label>
        ))}
      </div>
    </section>
  );
}

export function AppearanceSettings() {
  const s = useSettings();
  return (
    <DesignSystemScope className="appearance-settings" role="group" aria-label="Appearance preferences">
      <SettingsGroup title="Theme" description="App-wide · Color mode, palette and accent">
        <AppearanceRow
          name="theme"
          label="Theme"
          hint="System follows macOS. Open diagrams, canvases and drawings switch colours right away."
          grouped
        >
          {(control) => (
            <SegmentedControl
              {...control}
              label="Theme"
              value={s.theme}
              onChange={(value) => s.set("theme", value)}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          )}
        </AppearanceRow>
        <ColorThemePicker />
        <AppearanceRow
          name="accent"
          label="Accent color"
          hint="Theme default follows the selected palette. Custom colors apply to every palette."
        >
          {(control) => (
            <select
              {...control}
              className="mds-input"
              value={s.accent}
              onChange={(event) => s.set("accent", event.target.value as typeof s.accent)}
            >
              <option value="theme">Theme default</option>
              <option value="blue">Blue</option>
              <option value="green">Green</option>
              <option value="violet">Violet</option>
              <option value="amber">Amber</option>
            </select>
          )}
        </AppearanceRow>
      </SettingsGroup>
      <SettingsGroup title="Reading" description="App-wide · Note typography and width">
        <RangePreference
          name="noteSize"
          label="Note text size"
          hint="Text size in Markdown notes."
          min={NOTE_SIZE_MIN}
          max={NOTE_SIZE_MAX}
        />
        <AppearanceRow
          name="noteWidth"
          label="Note width"
          hint="How wide the text of a note gets. Full uses the whole pane; the others keep lines comfortable to read."
          grouped
        >
          {(control) => (
            <SegmentedControl
              {...control}
              label="Note width"
              value={s.noteWidth}
              onChange={(value) => s.set("noteWidth", value)}
              options={[
                { value: "narrow", label: "Narrow" },
                { value: "medium", label: "Medium" },
                { value: "wide", label: "Wide" },
                { value: "full", label: "Full" },
              ]}
            />
          )}
        </AppearanceRow>
        <p className="mds-hint appearance-note">
          App-wide · Fonts stay local. If a font is not installed, Mosaic uses the system fallback.
        </p>
        {(
          [
            ["noteFont", "Note font", "Use system or the name of a locally installed font, such as Georgia."],
            [
              "codeFont",
              "Code font",
              "Separate font for source and code blocks. Use system for the default monospace font.",
            ],
          ] as const
        ).map(([name, label, hint]) => (
          <AppearanceRow key={name} name={name} label={label} hint={hint}>
            {(control) => (
              <input
                {...control}
                className="mds-input"
                value={s[name]}
                onChange={(event) => s.set(name, event.target.value)}
              />
            )}
          </AppearanceRow>
        ))}
        <RangePreference name="lineSpacing" label="Line spacing" min={1.3} max={2.2} step={0.1} />
        <RangePreference name="headingScale" label="Heading scale" min={0.85} max={1.3} step={0.05} />
      </SettingsGroup>
      <SettingsGroup title="Interface" description="App-wide · Control size and spacing">
        <RangePreference name="uiScale" label="Interface scale" min={0.85} max={1.3} step={0.05} />
        <AppearanceRow name="density" label="Interface density">
          {(control) => (
            <select
              {...control}
              className="mds-input"
              value={s.density}
              onChange={(event) => s.set("density", event.target.value as typeof s.density)}
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          )}
        </AppearanceRow>
      </SettingsGroup>
      <div className="appearance-preview" role="group" aria-label="Appearance preview">
        <h1>A clearer workspace</h1>
        <h2>Meeting notes</h2>
        <p>
          Capture ideas, connect your{" "}
          <a href="#" onClick={(event) => event.preventDefault()}>
            project notes
          </a>
          , and decide what comes next.
        </p>
        <label>
          <input type="checkbox" defaultChecked /> Share the next steps
        </label>
        <pre>
          <code>const next = "Make it useful";</code>
        </pre>
      </div>
      <Button
        variant="secondary"
        onClick={(event) => {
          const opener = event.currentTarget;
          void useUi
            .getState()
            .ask({
              title: "Reset Appearance?",
              body: "Only this app-wide section returns to its defaults. Vault files, templates, permissions and history are unchanged.",
              confirmLabel: "Reset section",
            })
            .then((ok) => {
              if (ok) for (const key of APPEARANCE_KEYS) useSettings.getState().set(key, DEFAULT_PREFS[key]);
              if (opener.isConnected) opener.focus({ preventScroll: true });
            });
        }}
      >
        Reset Appearance…
      </Button>
    </DesignSystemScope>
  );
}
