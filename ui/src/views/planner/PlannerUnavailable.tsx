import { useState } from "react";
import { Button, Notice } from "../../design-system/components";
import { api } from "../../ipc/api";
import { errorMessage } from "../../ipc/types";
import { useVault } from "../../state/vault";
import { useUi } from "../../state/ui";

const recovering = new Set<string>();

/** Shared by the persistent workspace notice and the disabled planning views. */
export function PlannerUnavailable() {
  const vault = useVault((state) => state.vault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failure = vault?.planner_unavailable;
  if (!vault || !failure) return null;
  const recover = async (restore: boolean) => {
    if (busy || recovering.has(vault.root)) return;
    recovering.add(vault.root);
    setBusy(true);
    setError(null);
    try {
      if (restore) {
        const confirmed = await useUi.getState().ask({
          title: "Restore planner backup?",
          body: "Restore the last valid planner backup? The damaged database will be preserved for recovery. Markdown files will not be changed.",
          confirmLabel: "Restore backup",
          danger: true,
        });
        if (!confirmed || useVault.getState().vault !== vault) return;
        await api.restorePlannerBackup(vault.root);
      }
      if (useVault.getState().vault !== vault) return;
      await useVault.getState().openVault(vault.root, { preserveWorkspace: true });
    } catch (cause) {
      if (useVault.getState().vault === vault) setError(errorMessage(cause));
    } finally {
      recovering.delete(vault.root);
      setBusy(false);
    }
  };
  return (
    <Notice tone="warning" role="alert">
      <span>Planner unavailable. Your notes remain available. {failure.message}</span>
      {failure.code === "planner_newer_schema" && <span>Open this vault with a newer version of Mosaic.</span>}
      <Button disabled={busy} onClick={() => void recover(false)}>
        Retry planner
      </Button>
      {failure.can_restore && (
        <Button disabled={busy} onClick={() => void recover(true)}>
          Restore planner backup
        </Button>
      )}
      {error && <span>{error}</span>}
    </Notice>
  );
}
