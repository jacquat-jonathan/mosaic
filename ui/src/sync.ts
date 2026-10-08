// Keeps the UI in step with changes made on disk by other tools (AI agents, the CLI, other editors).

import { api, onSettingsChanged, onVaultChanged } from "./ipc/api";
import { useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";

let treeTimer: ReturnType<typeof setTimeout> | undefined;
let agentTimer: ReturnType<typeof setTimeout> | undefined;

/** Keeps the vault's .claude/skills/ in step with Agents/ (crates/mosaic-core/src/agents.rs). */
export function mirrorAgentsSoon() {
  clearTimeout(agentTimer);
  agentTimer = setTimeout(() => void api.mirrorAgents().catch(() => {}), 500);
}

export function startVaultSync(): Promise<() => void> {
  return onVaultChanged(({ paths, root_missing }) => {
    useVault.setState({ offline: root_missing });
    if (root_missing) return;
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => void useVault.getState().refresh(), 50);
    if (paths.some((p) => p === "Agents" || p.startsWith("Agents/"))) mirrorAgentsSoon();
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
    useVault.getState().touched();
    const fresh = await api.bookmarks().catch(() => null);
    const cur = useVault.getState().bookmarks;
    if (fresh && (fresh.length !== cur.length || fresh.some((p, i) => p !== cur[i]))) useVault.setState({ bookmarks: fresh });
  });
}
