// The macOS menu bar (src-tauri/src/menu.rs) is made of registry commands: choosing an item runs the
// command here, and the menu shows the shortcut that applies (Settings › Shortcuts can change it) and
// dims what can't run now.

import { commands, keysFor, type Keys } from "./commands";
import { api, onMenuCommand } from "./ipc/api";
import { MENU_COMMANDS, type MenuItemSync } from "./ipc/bindings";
import { useSettings } from "./state/settings";
import { useVault } from "./state/vault";
import { useVaultPreferences } from "./state/vaultPreferences";
import { useWorkspace } from "./state/workspace";

/** What the menu can run on the Welcome screen, before a vault is open. */
const WITHOUT_VAULT = new Set(["open-vault", "create-vault", "zoom-in", "zoom-out", "zoom-reset"]);

/**
 * The menu accelerator for a shortcut, e.g. "Alt+Shift+Cmd+KeyN". Only ⌘ shortcuts: the menu would take
 * any other key from what the user types.
 */
export function menuAccelerator(keys: Keys | undefined): string | null {
  if (!keys?.meta) return null;
  return [keys.alt && "Alt", keys.shift && "Shift", "Cmd", keys.code].filter(Boolean).join("+");
}

function runnable(id: string) {
  const command = commands().find((c) => c.id === id);
  if (!command) return null;
  if (!useVault.getState().vault && !WITHOUT_VAULT.has(id)) return null;
  return (command.when?.() ?? true) ? command : null;
}

/** Runs a chosen menu item's command, if it can run now (the same checks as its keyboard shortcut). */
export function runMenuCommand(id: string) {
  runnable(id)?.run();
}

/** Each menu command's shortcut and whether it can run now. */
export function menuItems(): MenuItemSync[] {
  return MENU_COMMANDS.map((id) => {
    const command = commands().find((c) => c.id === id);
    return {
      id,
      accelerator: menuAccelerator(command && keysFor(command)),
      enabled: runnable(id) !== null,
    };
  });
}

/**
 * Runs chosen menu items and keeps the menu in step with shortcuts and what can run. In the browser
 * there's no menu: the mock ignores the updates and `mock-menu-command` window events stand in for
 * choosing an item.
 */
export function startMenu(send: (items: MenuItemSync[]) => Promise<unknown> = api.syncMenu): Promise<() => void> {
  let sent = "";
  const sync = () => {
    const items = menuItems();
    const json = JSON.stringify(items);
    if (json === sent) return;
    sent = json;
    send(items).catch(() => {
      sent = ""; // try again on the next change
    });
  };
  sync();
  const stops = [
    useSettings.subscribe(sync),
    useVault.subscribe(sync),
    useWorkspace.subscribe(sync),
    useVaultPreferences.subscribe(sync),
  ];
  return onMenuCommand(runMenuCommand).then((off) => () => {
    off();
    for (const stop of stops) stop();
  });
}
