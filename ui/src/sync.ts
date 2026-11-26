// Keeps the UI in step with changes made on disk by other tools (AI agents, the CLI, other editors).

import { vaultOperation } from "./state/vaultSession";
import { api, onSettingsChanged, onVaultChanged } from "./ipc/api";
import { parentOf, useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";
import { loadVaultPreferences, useVaultPreferences, vaultPrefs } from "./state/vaultPreferences";
import { isHiddenPath } from "./hidden";
import type { Entry } from "./ipc/types";

let treeTimer: ReturnType<typeof setTimeout> | undefined;
let agentTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
const hiddenFolders = new Set<string>();

/** At most one re-listing of changed hidden folders per second, however busy `.next/` or `.venv/` gets. */
export const HIDDEN_RELIST_MS = 1000;

/**
 * The folders whose hidden children to re-list for changed hidden paths: a hidden entry's parent when
 * that is an ordinary folder (it may have appeared or gone), or a hidden folder the tree shows open
 * (every hidden folder above it expanded). Changes inside a closed hidden folder need no work at all.
 */
export function hiddenFoldersToRelist(paths: string[], hiddenEntries: Entry[], expanded: Set<string>): string[] {
  const folders = new Set(hiddenEntries.filter((e) => e.is_dir).map((e) => e.path));
  const shownOpen = (dir: string) => {
    for (let d = dir; isHiddenPath(d); d = parentOf(d)) if (!folders.has(d) || !expanded.has(d)) return false;
    return true;
  };
  const out = new Set<string>();
  for (const path of paths) {
    const parent = parentOf(path);
    if (shownOpen(parent)) out.add(parent);
  }
  return [...out];
}

function relistHiddenSoon(dirs: string[]) {
  for (const dir of dirs) hiddenFolders.add(dir);
  if (hiddenTimer || !hiddenFolders.size) return;
  const current = vaultOperation();
  hiddenTimer = setTimeout(() => {
    hiddenTimer = undefined;
    const pending = [...hiddenFolders];
    hiddenFolders.clear();
    if (current()) void useVault.getState().refreshHidden(pending);
  }, HIDDEN_RELIST_MS);
}

/** Keeps the vault's .claude/skills/ in step with Agents/ (crates/mosaic-core/src/agents.rs). */
export function mirrorAgentsSoon() {
  const current = vaultOperation();
  clearTimeout(agentTimer);
  agentTimer = setTimeout(() => {
    if (current()) void api.mirrorAgents().catch(() => {});
  }, 500);
}

export function startVaultSync(): Promise<() => void> {
  // Turning "Show hidden files and folders" on or off reloads the tree.
  const stopPrefs = useVaultPreferences.subscribe((next, prev) => {
    if (next.root === prev.root && !!next.value.show_hidden_files !== !!prev.value.show_hidden_files)
      void useVault.getState().refresh();
  });
  return onVaultChanged(({ paths, hidden_paths = [], root_missing }) => {
    const current = vaultOperation();
    useVault.setState({ offline: root_missing });
    if (root_missing) return;
    // Hidden paths never cost a full reload of the tree: only their folders are listed again.
    if (paths.length) {
      clearTimeout(treeTimer);
      treeTimer = setTimeout(() => {
        if (current()) void useVault.getState().refresh();
      }, 50);
    }
    if (hidden_paths.length && vaultPrefs().show_hidden_files) {
      const { hiddenEntries, expanded } = useVault.getState();
      relistHiddenSoon(hiddenFoldersToRelist(hidden_paths, hiddenEntries, expanded));
    }
    if (paths.some((p) => p === vaultPrefs().agents_folder || p.startsWith(`${vaultPrefs().agents_folder}/`)))
      mirrorAgentsSoon();
    const ws = useWorkspace.getState();
    const changed = [...paths, ...hidden_paths];
    for (const open of Object.keys(ws.buffers)) {
      if (changed.some((p) => open === p || open.startsWith(`${p}/`))) void ws.externalChange(open);
    }
  }).then((stop) => () => {
    stop();
    stopPrefs();
  });
}

/** Picks up bookmarks that agents added or removed through the CLI or MCP. */
export function startBookmarkSync(): Promise<() => void> {
  return onSettingsChanged(async () => {
    if (!useVault.getState().vault) return;
    const current = vaultOperation();
    useVault.getState().touched();
    const root = useVault.getState().vault?.root;
    if (root) await loadVaultPreferences(root).catch(() => {});
    if (!current()) return;
    const fresh = await api.bookmarks().catch(() => null);
    if (!current()) return;
    const cur = useVault.getState().bookmarks;
    if (fresh && (fresh.length !== cur.length || fresh.some((p, i) => p !== cur[i])))
      useVault.setState({ bookmarks: fresh });
  });
}
