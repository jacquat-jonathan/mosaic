// Keeps the UI in step with changes made on disk by other tools (AI agents, the CLI, other editors).

import { onVaultChanged } from "./ipc/api";
import { useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";

let treeTimer: ReturnType<typeof setTimeout> | undefined;

export function startVaultSync(): Promise<() => void> {
  return onVaultChanged(({ paths, root_missing }) => {
    useVault.setState({ offline: root_missing });
    if (root_missing) return;
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => void useVault.getState().refresh(), 50);
    const ws = useWorkspace.getState();
    for (const open of Object.keys(ws.buffers)) {
      if (paths.some((p) => open === p || open.startsWith(`${p}/`))) void ws.externalChange(open);
    }
  });
}
