import { useEffect, useRef } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { TranscriptItem, openTranscriptLink } from "./Transcript";
import { appendTranscriptEvent } from "../state/transcript";
import type { ChatItem } from "../state/chat";
import { pendingForRun, runState } from "./workflowPresentation";
export {
  pendingForRun,
  runState,
  runDuration,
  eventFolder,
  matchesEventFolder,
  workflowTrigger,
  workflowDeleteTarget,
} from "./workflowPresentation";
import { RunsHistory } from "./RunsHistory";
import { WorkflowList } from "./WorkflowList";
import { WorkflowDetail } from "./WorkflowDetail";

export function RunDetail({ id, compact = false }: { id: string; compact?: boolean }) {
  const run = useAttention((s) => s.status?.runs.find((r) => String(r.id) === id));
  const pending = useReview((s) => s.pending);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const events = run?.transcript?.events;
  useEffect(() => {
    follow.current = true;
  }, [id]);
  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [events]);
  if (!run) return <p className="panel-meta">This run is unavailable.</p>;
  const proposals = pendingForRun(run, pending);
  const items = (events ?? []).reduce<ChatItem[]>(appendTranscriptEvent, []);
  const state =
    run.status === "done" || run.status === "successful"
      ? proposals.length
        ? "Needs review"
        : "Completed"
      : runState(run, proposals.length > 0);
  const warnings = items.filter((item) => item.kind === "tool" && item.error).length;
  const Icon =
    run.status === "running"
      ? LoaderCircle
      : run.status === "failed" || run.status === "skipped"
        ? CircleAlert
        : CheckCircle2;
  return (
    <div className={`${compact ? "context-content" : "workspace-page"} run-detail`}>
      <header className="run-heading">
        <h2>{run.title}</h2>
        <span className={`run-status ${run.status}`}>
          <Icon size={15} className={run.status === "running" ? "spin" : undefined} />
          {state}
        </span>
      </header>
      <div className="run-meta">
        <time dateTime={new Date(run.started * 1000).toISOString()}>
          {new Date(run.started * 1000).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        <span>{run.trigger || "Manual run"}</span>
        <span>{run.model || "Default model"}</span>
        {run.late && <span>Started late</span>}
      </div>
      <details className="run-details">
        <summary>Run details</summary>
        <dl>
          <dt>Trigger</dt>
          <dd>{run.trigger || "Manual"}</dd>
          <dt>Model</dt>
          <dd>{run.model || "Claude Code default"}</dd>
          <dt>Started</dt>
          <dd>{new Date(run.started * 1000).toLocaleString()}</dd>
          {run.finished && (
            <>
              <dt>Finished</dt>
              <dd>{new Date(run.finished * 1000).toLocaleString()}</dd>
            </>
          )}
          <dt>Attempts</dt>
          <dd>{run.attempts ?? 1}</dd>
          {run.chain_id && (
            <>
              <dt>Workflow chain</dt>
              <dd>
                Depth {run.chain_depth ?? 0} · {run.chain_id}
              </dd>
            </>
          )}
          {!!warnings && (
            <>
              <dt>Tool calls</dt>
              <dd>
                {warnings} failed {warnings === 1 ? "call" : "calls"}
              </dd>
            </>
          )}
        </dl>
      </details>
      <h3>{items.length ? "Run log" : "Result"}</h3>
      {run.transcript?.truncated && (
        <p className="panel-meta">Only the latest activity is shown; this log was shortened.</p>
      )}
      <div
        className="run-transcript"
        aria-label="Run log"
        tabIndex={0}
        ref={log}
        onClick={openTranscriptLink}
        onScroll={() => {
          const el = log.current;
          if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length ? (
          items.map((item, i) => <TranscriptItem key={i} item={item} />)
        ) : (
          <TranscriptItem
            item={{
              kind: run.error ? "error" : "text",
              text:
                run.error || run.answer || (run.status === "running" ? "Waiting for output…" : "No output recorded."),
            }}
          />
        )}
        {run.status === "running" && items.length > 0 && <p className="chat-thinking">Working…</p>}
      </div>
      <footer className="run-outcome">
        {!!warnings && (
          <span className="run-warning">
            <TriangleAlert size={14} />
            {warnings} tool {warnings === 1 ? "warning" : "warnings"}
          </span>
        )}
        <span>{run.changed_paths?.length ?? 0} files changed</span>
        <span>{proposals.length ? `${proposals.length} pending reviews` : "No pending reviews"}</span>
      </footer>
      {!!run.changed_paths?.length && (
        <details className="run-details">
          <summary>Changed files</summary>
          <div className="run-files">
            {run.changed_paths.map((path) => (
              <button key={path} onClick={() => void useWorkspace.getState().open(path, { newTab: true })}>
                {path}
              </button>
            ))}
          </div>
        </details>
      )}
      {!!run.changes?.length && !events?.length && (
        <details className="run-details">
          <summary>Tool activity</summary>
          <ul>
            {run.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}
      <button className="run-review-link" onClick={() => useUi.getState().openView("activity")}>
        Open activity and reviews
      </button>
    </div>
  );
}
export function Workflows(props: { name?: string; runsOnly?: boolean; agentsOnly?: boolean }) {
  return props.runsOnly ? (
    <RunsHistory name={props.name} />
  ) : props.name ? (
    <WorkflowDetail name={props.name} />
  ) : (
    <WorkflowList agentsOnly={props.agentsOnly} />
  );
}

export { WorkflowContext } from "./WorkflowDetail";

export { WorkflowForm, workflowContent } from "./WorkflowForm";
