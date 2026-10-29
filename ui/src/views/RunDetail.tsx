import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, Notice } from "../design-system/components";
import { RunPanel } from "../design-system/patterns";
import { errorMessage } from "../ipc/types";
import { useAttention } from "../state/attention";
import type { ChatItem } from "../state/chat";
import { useReview } from "../state/review";
import { appendTranscriptEvent } from "../state/transcript";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { DesignSystemScope } from "./DesignSystemScope";
import { TranscriptItem, openTranscriptLink } from "./Transcript";
import { pendingForRun, workflowRunState } from "./workflowPresentation";
import "../design-system/patterns.css";
import "./workflowStatus.css";
import "./runDetail.css";

export function RunDetail({ id, compact = false }: { id: string; compact?: boolean }) {
  const root = useVault((state) => state.vault?.root);
  return <RunView key={`${root}:${id}`} id={id} compact={compact} root={root} />;
}
function RunView({ id, compact, root }: { id: string; compact: boolean; root?: string }) {
  const run = useAttention((state) => state.status?.runs.find((entry) => String(entry.id) === id));
  const pending = useReview((state) => state.pending);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const events = run?.transcript?.events;
  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [events]);
  const recordError = (cause: unknown) => {
    if (useVault.getState().vault?.root === root) setError(errorMessage(cause));
  };
  const openFile = (path: string) => {
    if (useVault.getState().vault?.root !== root) return;
    setError(null);
    void useWorkspace.getState().open(path, { newTab: true }).catch(recordError);
  };
  const proposals = pendingForRun(run, pending);
  const items = (events ?? []).reduce<ChatItem[]>(appendTranscriptEvent, []);
  const warnings = items.filter((item) => item.kind === "tool" && item.error).length;
  return (
    <DesignSystemScope
      className={`${compact ? "context-content" : "workspace-page"} run-detail workflow-status-scope`}
      role="group"
      aria-label="Workflow run"
    >
      {!run ? (
        <Notice>This run is unavailable.</Notice>
      ) : (
        <RunPanel
          title={run.title}
          titleAs={compact ? "h2" : "h1"}
          state={workflowRunState(run, proposals.length > 0)}
          metadata={
            <>
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
            </>
          }
          details={
            <details className="run-details">
              <summary>Run details</summary>
              <dl className="mds-metadata">
                {[
                  ["Trigger", run.trigger || "Manual"],
                  ["Model", run.model || "Claude Code default"],
                  ["Started", new Date(run.started * 1000).toLocaleString()],
                  ...(run.finished ? [["Finished", new Date(run.finished * 1000).toLocaleString()]] : []),
                  ["Attempts", String(run.attempts ?? 1)],
                  ...(run.chain_id ? [["Workflow chain", `Depth ${run.chain_depth ?? 0} · ${run.chain_id}`]] : []),
                  ...(warnings ? [["Tool calls", `${warnings} failed ${warnings === 1 ? "call" : "calls"}`]] : []),
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          }
          logTitle={items.length ? "Run log" : "Result"}
          transcriptProps={{
            className: "run-transcript",
            "aria-label": "Run log",
            role: "region",
            tabIndex: 0,
            ref: log,
            onClick: (event) => {
              if (useVault.getState().vault?.root === root) openTranscriptLink(event, recordError);
            },
            onScroll: () => {
              const el = log.current;
              if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            },
          }}
          outcome={
            <>
              {!!warnings && (
                <span className="run-warning">
                  <TriangleAlert size={15} aria-hidden="true" />
                  {warnings} tool {warnings === 1 ? "warning" : "warnings"}
                </span>
              )}
              <span>{run.changed_paths?.length ?? 0} files changed</span>
              <span>{proposals.length ? `${proposals.length} pending reviews` : "No pending reviews"}</span>
              {!!run.changed_paths?.length && (
                <details className="run-details run-files">
                  <summary>Changed files</summary>
                  <div>
                    {run.changed_paths.map((path) => (
                      <Button variant="secondary" key={path} onClick={() => openFile(path)}>
                        {path}
                      </Button>
                    ))}
                  </div>
                </details>
              )}
              {!!run.changes?.length && !events?.length && (
                <details className="run-details run-files">
                  <summary>Tool activity</summary>
                  <ul>
                    {run.changes.map((change, index) => (
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                </details>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  if (useVault.getState().vault?.root === root) useUi.getState().openView("activity");
                }}
              >
                Open activity and reviews
              </Button>
              {error && <Notice tone="error">{error}</Notice>}
            </>
          }
        >
          {run.transcript?.truncated && <Notice>Only the latest activity is shown; this log was shortened.</Notice>}
          {items.length ? (
            items.map((item, index) => <TranscriptItem key={index} item={item} />)
          ) : (
            <TranscriptItem
              item={{
                kind: run.error ? "error" : "text",
                text:
                  run.error || run.answer || (run.status === "running" ? "Waiting for output…" : "No output recorded."),
              }}
            />
          )}
          {run.status === "running" && items.length > 0 && (
            <p className="mds-hint" role="status">
              Working…
            </p>
          )}
        </RunPanel>
      )}
    </DesignSystemScope>
  );
}
