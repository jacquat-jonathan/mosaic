import { Notice } from "../design-system/components";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { DesignSystemScope } from "./DesignSystemScope";
import { RunsLedger } from "./RunsLedger";
import "./runsHistory.css";

export function RunsHistory({ name }: { name?: string }) {
  const { status, agents, error } = useAttention();
  const pending = useReview((state) => state.pending);
  const selected = agents.find((agent) => agent.name === name);
  const runs = (status?.runs ?? []).filter((run) => !name || run.agent === name);
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
          <RunsLedger runs={runs} pending={pending} />
        )}
      </section>
    </DesignSystemScope>
  );
}
