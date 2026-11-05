import { useEffect, useRef, useState } from "react";
import { Button, Notice } from "../design-system/components";
import { StatusLabel, type RunState } from "../design-system/patterns";
import { errorMessage } from "../ipc/types";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { DesignSystemScope } from "./DesignSystemScope";
import { WorkflowForm } from "./WorkflowForm";
import { WorkflowList } from "./WorkflowList";
import { pendingForRun, workflowRunState, workflowTrigger } from "./workflowPresentation";
import "./workflowDetail.css";
import "./workflowStatus.css";

export function WorkflowDetail({ name }: { name: string }) {
  const root = useVault((state) => state.vault?.root);
  return <SelectedWorkflow key={`${root}:${name}`} name={name} />;
}
function SelectedWorkflow({ name }: { name: string }) {
  const agent = useAttention((state) => state.agents.find((entry) => entry.name === name));
  const [editing, setEditing] = useState(false);
  const [restoreEdit, setRestoreEdit] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing && restoreEdit) {
      shell.current?.querySelector<HTMLButtonElement>('[data-workflow-edit="true"]')?.focus({ preventScroll: true });
      setRestoreEdit(false);
    }
  }, [editing, restoreEdit]);
  return (
    <div className="workflow-detail-shell" ref={shell}>
      {editing && agent ? (
        <WorkflowForm
          agent={agent}
          onDone={() => {
            setEditing(false);
            setRestoreEdit(true);
          }}
        />
      ) : (
        <WorkflowList name={name} onEdit={() => setEditing(true)} />
      )}
    </div>
  );
}

export function WorkflowContext({ name }: { name: string }) {
  const root = useVault((state) => state.vault?.root);
  return <Context key={`${root}:${name}`} name={name} root={root} />;
}
function Context({ name, root }: { name: string; root?: string }) {
  const agent = useAttention((state) => state.agents.find((entry) => entry.name === name));
  const status = useAttention((state) => state.status);
  const pending = useReview((state) => state.pending);
  const [error, setError] = useState<string | null>(null);
  const schedule = status?.agents.find((entry) => entry.name === name);
  const latest = status?.runs
    .filter((run) => run.agent === name)
    .sort((left, right) => right.started - left.started || right.id - left.id)[0];
  const needsReview = status?.runs.some((run) => run.agent === name && pendingForRun(run, pending).length > 0);
  const state: RunState =
    schedule?.running || latest?.status === "running"
      ? "running"
      : schedule?.queued
        ? "queued"
        : schedule?.paused || ((agent?.schedule || agent?.on.length) && status?.paused)
          ? "paused"
          : schedule?.error
            ? "failed"
            : needsReview
              ? "needs-review"
              : latest
                ? workflowRunState(latest)
                : "ready";
  return (
    <DesignSystemScope
      className="context-content workflow-context workflow-status-scope"
      role="group"
      aria-label="Workflow context"
    >
      {!agent || !root ? (
        <Notice>Workflow unavailable.</Notice>
      ) : (
        <>
          <h3>{agent.title}</h3>
          <dl className="mds-metadata">
            {[
              ["Agent", agent.name],
              ["Trigger", workflowTrigger(agent)],
              ["Model", agent.model || "Claude Code default"],
              ["Allowed folders", agent.may_change.join(", ") || "All changes require review"],
              ["Web", agent.web ? "Can use the web" : "No web access"],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            <div>
              <dt>Status</dt>
              <dd>
                <StatusLabel state={state} />
              </dd>
            </div>
          </dl>
          {schedule?.error && <Notice tone="error">{schedule.error}</Notice>}
          <Button
            variant="secondary"
            onClick={() => {
              if (useVault.getState().vault?.root !== root) return;
              setError(null);
              void useWorkspace
                .getState()
                .open(agent.path, { newTab: true })
                .catch((cause) => setError(errorMessage(cause)));
            }}
          >
            Edit source
          </Button>
          {error && <Notice tone="error">{error}</Notice>}
        </>
      )}
    </DesignSystemScope>
  );
}
