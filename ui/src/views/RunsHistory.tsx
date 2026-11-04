import { useEffect, useState } from "react";
import { Notice } from "../design-system/components";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useVault } from "../state/vault";
import { DesignSystemScope } from "./DesignSystemScope";
import { RunsLedger } from "./RunsLedger";
import "./runsHistory.css";

export function RunsHistory({ name }: { name?: string }) {
  const { status, agents, error } = useAttention();
  const root = useAttention((state) => state.root);
  const unseenFailures = useAttention((state) => state.unseenFailureIds);
  const vaultRoot = useVault((state) => state.vault?.root);
  const [highlighted, setHighlighted] = useState<Set<number>>(() => new Set());
  const pending = useReview((state) => state.pending);
  const selected = agents.find((agent) => agent.name === name);
  const runs = (status?.runs ?? []).filter((run) => !name || run.agent === name);
  useEffect(() => {
    const acknowledge = () => {
      if (!status || root !== vaultRoot || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const visible = new Set(status.runs.filter((run) => !name || run.agent === name).map((run) => run.id));
      const newlySeen = unseenFailures.filter((id) => visible.has(id));
      if (!newlySeen.length) return;
      setHighlighted((previous) => new Set([...previous, ...newlySeen]));
      useAttention.getState().markFailuresSeen(newlySeen);
    };
    acknowledge();
    window.addEventListener("focus", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    return () => {
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
  }, [status, root, vaultRoot, name, unseenFailures]);
  return (
    <DesignSystemScope
      className="workspace-page runs-history workflow-status-scope"
      role="group"
      aria-label="Runs ledger"
    >
      <header className="runs-history-heading">
        <h1>{selected?.title ?? "Runs"}</h1>
        <p className="mds-hint">Workflow history, newest first.</p>
      </header>
      {error && <Notice tone="error">{error}</Notice>}
      {status?.paused && (
        <Notice tone="warning">All automatic workflows are paused. Manual runs and test triggers are available.</Notice>
      )}
      <section aria-label="Run history" aria-busy={!status && !error}>
        {!status ? (
          <Notice>{error ? "Run history could not be loaded." : "Loading runs…"}</Notice>
        ) : (
          <RunsLedger runs={runs} pending={pending} newFailures={highlighted} />
        )}
      </section>
    </DesignSystemScope>
  );
}
