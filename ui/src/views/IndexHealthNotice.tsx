import { Button, Notice } from "../design-system/components";
import { rebuildIndex, useIndexHealth } from "../state/indexHealth";
import { useVault } from "../state/vault";
import { DesignSystemScope } from "./DesignSystemScope";
import "./workspaceNotices.css";

export function IndexHealthNotice() {
  const vault = useVault((state) => state.vault);
  const { vault: healthVault, health, requested, error } = useIndexHealth();
  if (!vault || healthVault !== vault || (!error && health?.status !== "degraded")) return null;
  return (
    <DesignSystemScope className="workspace-notices" role="region" aria-label="Search indexing status">
      <Notice tone="warning" role="alert">
        <span>
          Search may be out of date. Your notes are still available. Mosaic retries indexing automatically; you can also
          rebuild it now.
          {health?.diagnostic && ` (${health.diagnostic.problem}: ${health.diagnostic.error_code})`}
        </span>
        <Button disabled={requested} onClick={() => void rebuildIndex()}>
          {requested ? "Requesting rebuild…" : "Rebuild search index"}
        </Button>
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
    </DesignSystemScope>
  );
}
