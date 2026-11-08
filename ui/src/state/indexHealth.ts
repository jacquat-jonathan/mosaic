import { create } from "zustand";
import { api, onIndexHealth } from "../ipc/api";
import type { IndexHealth, VaultInfo } from "../ipc/types";
import { errorMessage } from "../ipc/types";
import { useVault } from "./vault";

export const useIndexHealth = create<{
  vault: VaultInfo | null;
  health: IndexHealth | null;
  requested: boolean;
  error: string | null;
}>(() => ({ vault: null, health: null, requested: false, error: null }));

export async function rebuildIndex() {
  const vault = useVault.getState().vault;
  if (!vault || useIndexHealth.getState().requested) return;
  useIndexHealth.setState({ vault, requested: true, error: null });
  try {
    await api.rebuildIndex(vault.root);
  } catch (error) {
    if (useVault.getState().vault === vault) useIndexHealth.setState({ error: errorMessage(error) });
  } finally {
    if (useVault.getState().vault === vault) useIndexHealth.setState({ requested: false });
  }
}

export async function startIndexHealth(): Promise<() => void> {
  let live = true;
  let version = 0;
  const load = (vault: VaultInfo | null) => {
    const ticket = ++version;
    useIndexHealth.setState({ vault, health: null, requested: false, error: null });
    if (!vault) return;
    void api.indexHealth(vault.root).then(
      (health) => {
        if (live && version === ticket && useVault.getState().vault === vault) {
          useIndexHealth.setState({ health });
        }
      },
      (error) => {
        if (live && version === ticket && useVault.getState().vault === vault) {
          useIndexHealth.setState({ error: errorMessage(error) });
        }
      },
    );
  };
  const offVault = useVault.subscribe((state, previous) => {
    if (state.vault !== previous.vault) load(state.vault);
  });
  const offEvent = await onIndexHealth((event) => {
    const vault = useVault.getState().vault;
    if (!live || !vault || event.root !== vault.root) return;
    version++;
    useIndexHealth.setState({ vault, health: event.health, error: null });
  });
  load(useVault.getState().vault);
  return () => {
    live = false;
    offVault();
    offEvent();
  };
}
