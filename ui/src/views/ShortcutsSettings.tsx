import { useEffect, useId, useRef, useState } from "react";
import { Badge, Button, Notice } from "../design-system/components";
import { commands, formatKeys, keysFor, rebind, type Keys } from "../commands";
import { useSettings } from "../state/settings";
import { DesignSystemScope } from "./DesignSystemScope";
import "./shortcutsSettings.css";

const TREE_KEYS = [
  ["⌘-click", "Add or remove a file from the selection"],
  ["⇧-click", "Select a range"],
  ["⌥-click", "Open in a new tab"],
  ["↵", "Rename the selected file"],
  ["⌘⌫", "Move the selection to the Trash"],
  ["⌘A", "Select everything visible"],
  ["esc", "Clear the selection"],
];
export function ShortcutsSettings() {
  const custom = useSettings((state) => state.shortcuts);
  const set = useSettings((state) => state.set);
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const firstButton = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (restoreFocus) {
      firstButton.current?.focus();
      setRestoreFocus(false);
    }
  }, [restoreFocus]);
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        setRecording(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (["Meta", "Shift", "Alt", "Control"].includes(event.key)) return;
      if (event.key === "Escape") return setRecording(null);
      if (event.key === "Backspace" && !event.metaKey) {
        set("shortcuts", rebind(recording, null).shortcuts);
        setNote(null);
        return setRecording(null);
      }
      if (!event.metaKey || event.ctrlKey)
        return setNote("Shortcuts start with ⌘ (add ⇧ or ⌥ if you like). Esc cancels, ⌫ removes the shortcut.");
      const keys: Keys = {
        code: event.code,
        meta: true,
        shift: event.shiftKey || undefined,
        alt: event.altKey || undefined,
      };
      const { shortcuts, tookFrom } = rebind(recording, keys);
      set("shortcuts", shortcuts);
      setNote(tookFrom ? `${formatKeys(keys)} was used by “${tookFrom}”, which now has no shortcut.` : null);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, set]);
  return (
    <DesignSystemScope className="shortcut-settings" role="group" aria-label="Shortcut preferences">
      <p className="mds-hint shortcut-settings-note">
        Choose a shortcut, then press the new keys. Every command can have one.
      </p>
      <p id={hintId} className="mds-hint shortcut-settings-note">
        Use ⌘ with optional ⇧ or ⌥. Esc cancels, ⌫ removes a binding, and Tab leaves capture.
      </p>
      {recording && (
        <Notice>
          Recording a shortcut for {commands().find((command) => command.id === recording)?.label}. Press the new keys.
        </Notice>
      )}
      {note && <Notice tone="warning">{note}</Notice>}
      <table className="shortcut-settings-table" aria-label="Command shortcuts">
        <thead>
          <tr>
            <th scope="col">Command</th>
            <th scope="col">Shortcut</th>
          </tr>
        </thead>
        <tbody>
          {commands().map((command, index) => {
            const keys = keysFor(command),
              changed = custom[command.id] !== undefined;
            return (
              <tr key={command.id}>
                <th scope="row">{command.label}</th>
                <td>
                  <Button
                    ref={index === 0 ? firstButton : undefined}
                    variant="secondary"
                    className="shortcut-binding"
                    aria-label={`Change shortcut for ${command.label}`}
                    aria-pressed={recording === command.id}
                    aria-describedby={hintId}
                    data-recording={recording === command.id || undefined}
                    data-custom={changed || undefined}
                    onBlur={() => setRecording((current) => (current === command.id ? null : current))}
                    onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      setNote(null);
                      setRecording(recording === command.id ? null : command.id);
                    }}
                  >
                    {recording === command.id ? "Press keys…" : keys ? <kbd>{formatKeys(keys)}</kbd> : "None"}
                  </Button>
                  {changed && <Badge>Custom</Badge>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {Object.keys(custom).length > 0 && (
        <Button
          variant="secondary"
          className="shortcut-reset"
          onClick={() => {
            setRecording(null);
            setNote(null);
            set("shortcuts", {});
            setRestoreFocus(true);
          }}
        >
          Reset all shortcuts
        </Button>
      )}
      <h3>In the file tree</h3>
      <table className="shortcut-settings-table" aria-label="File tree shortcuts">
        <tbody>
          {TREE_KEYS.map(([keys, label]) => (
            <tr key={keys}>
              <th scope="row">{label}</th>
              <td>
                <kbd>{keys}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mds-hint shortcut-settings-note">
        Every command, with or without a shortcut, is in the command palette (⌘P).
      </p>
    </DesignSystemScope>
  );
}
