import { APP_THEME_TOKENS } from "../design-system/appTheme";
import "../design-system/tokens.css";
import "../design-system/controls.css";
/** App-owned DOM chrome inside CodeMirror/static Markdown. CSS aliases follow live app
 * preferences without a subscription for every widget; document renderers keep their fonts. */
export function editorScope<T extends HTMLElement>(element: T): T {
  element.classList.add("mosaic-ds", "editor-controls");
  element.style.colorScheme = "inherit";
  for (const [token, value] of Object.entries(APP_THEME_TOKENS)) element.style.setProperty(token, value);
  return element;
}
export function editorButton<T extends HTMLButtonElement>(button: T): T {
  button.type = "button";
  button.classList.add("mds-button", "mds-button--quiet");
  return button;
}
