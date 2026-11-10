// Keeps the UI in step with changes made on disk by other tools (AI agents, the CLI, other editors).

import { vaultOperation } from "./state/vaultSession";
import { api, onSettingsChanged, onVaultChanged } from "./ipc/api";
import { useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";
import { loadVaultPreferences, vaultPrefs } from "./state/vaultPreferences";

let treeTimer: ReturnType<typeof setTimeout> | undefined;
let agentTimer: ReturnType<typeof setTimeout> | undefined;

/** Keeps the vault's .claude/skills/ in step with Agents/ (crates/mosaic-core/src/agents.rs). */
export function mirrorAgentsSoon() {
  const current = vaultOperation();
  clearTimeout(agentTimer);
  agentTimer = setTimeout(() => {
    if (current()) void api.mirrorAgents().catch(() => {});
  }, 500);
}

export function startVaultSync(): Promise<() => void> {
  return onVaultChanged(({ paths, root_missing }) => {
    const current = vaultOperation();
    useVault.setState({ offline: root_missing });
    if (root_missing) return;
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => {
      if (current()) void useVault.getState().refresh();
    }, 50);
    if (paths.some((p) => p === vaultPrefs().agents_folder || p.startsWith(`${vaultPrefs().agents_folder}/`)))
      mirrorAgentsSoon();
    const ws = useWorkspace.getState();
    for (const open of Object.keys(ws.buffers)) {
      if (paths.some((p) => open === p || open.startsWith(`${p}/`))) void ws.externalChange(open);
    }
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
