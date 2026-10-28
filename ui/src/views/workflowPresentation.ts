import type { RunState } from "../design-system/patterns";
import type { Agent, AgentRun, Proposal } from "../ipc/types";
import { parentOf } from "../state/vault";

export function pendingForRun(run: AgentRun | undefined, pending: Proposal[]) {
  if (!run) return [];
  return pending.filter((p) => run.proposal_ids?.includes(p.id));
}
export function runState(run: AgentRun, needsReview = false) {
  return run.status === "running"
    ? "Running"
    : run.status === "failed"
      ? "Failed"
      : run.status === "skipped"
        ? "Skipped"
        : needsReview
          ? "Needs review"
          : "Completed";
}
export function runDuration(run: AgentRun) {
  if (run.status === "running") return "In progress";
  if (run.finished === null) return "—";
  const seconds = Math.max(0, Math.round(run.finished - run.started));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export const eventFolder = (event: string) =>
  /^created in\s+(.+)$/i.exec(event.trim())?.[1].replace(/^\/+|\/+$/g, "") ?? null;
export const matchesEventFolder = (path: string, folder: string) =>
  path.toLowerCase().endsWith(".md") && (!folder || path.startsWith(`${folder}/`));
export function workflowTrigger(agent: Agent) {
  const triggers = [...(agent.schedule ? [agent.schedule] : []), ...(agent.on ?? [])];
  return triggers.length ? triggers.join(" · ") : "Manual";
}
export const workflowDeleteTarget = (agent: Agent) => (agent.skill_folder ? parentOf(agent.path) : agent.path);

export function workflowRunState(run: AgentRun, needsReview = false): RunState {
  if (
    run.status === "running" ||
    run.status === "queued" ||
    run.status === "paused" ||
    run.status === "failed" ||
    run.status === "skipped"
  )
    return run.status;
  return needsReview ? "needs-review" : "completed";
}
