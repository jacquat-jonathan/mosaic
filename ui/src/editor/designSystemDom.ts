import "../design-system/tokens.css";
import "../design-system/controls.css";
/** App-owned DOM chrome inside CodeMirror/static Markdown. CSS aliases follow live app
 * preferences without a subscription for every widget; document renderers keep their fonts. */
export function editorScope<T extends HTMLElement>(element: T): T {
  element.classList.add("mosaic-ds", "editor-controls");
  element.style.colorScheme = "inherit";
  for (const [token, app] of Object.entries({
    surface: "bg",
    "surface-subtle": "bg-side",
    "surface-hover": "bg-hover",
    "surface-selected": "bg-active",
    text: "fg",
    "text-muted": "muted",
    "text-faint": "faint",
    border: "border",
    accent: "accent",
    danger: "danger",
    "warning-surface": "warn-bg",
    "error-surface": "err-bg",
    "shadow-floating": "shadow",
  }))
    element.style.setProperty(`--mds-${token}`, `var(--${app})`);
  return element;
}
export function editorButton<T extends HTMLButtonElement>(button: T): T {
  button.type = "button";
  button.classList.add("mds-button", "mds-button--quiet");
  return button;
}
