import { CheckCircle2, CircleAlert, Clock3, LoaderCircle } from "lucide-react";
import type { AgentRun, Proposal } from "../ipc/types";
import type { ChatItem } from "../state/chat";
import { appendTranscriptEvent } from "../state/transcript";
import { useUi } from "../state/ui";
import { dayLabel } from "../time";
import { pendingForRun, runState, runDuration } from "./workflowPresentation";

export function RunsLedger({ runs, pending }: { runs: AgentRun[]; pending: Proposal[] }) {
  return (
    <div className="runs-ledger">
      <table className="run-ledger-table" aria-label="Workflow runs">
        <thead>
          <tr>
            <th scope="col">Workflow</th>
            <th scope="col">Status</th>
            <th scope="col" className="run-ledger-started">
              Started
            </th>
            <th scope="col" className="run-ledger-duration">
              Duration
            </th>
          </tr>
        </thead>
        <tbody>
          {[...runs]
            .sort((a, b) => b.started - a.started || b.id - a.id)
            .map((r) => {
              const reviews = pendingForRun(r, pending).length;
              const warnings = (r.transcript?.events ?? [])
                .reduce<ChatItem[]>(appendTranscriptEvent, [])
                .filter((item) => item.kind === "tool" && item.error).length;
              const state = runState(r, reviews > 0);
              const tone =
                r.status === "running"
                  ? "running"
                  : r.status === "failed"
                    ? "failed"
                    : r.status === "skipped" || reviews
                      ? "review"
                      : r.status;
              const Icon =
                r.status === "running"
                  ? LoaderCircle
                  : r.status === "failed" || r.status === "skipped"
                    ? CircleAlert
                    : reviews
                      ? Clock3
                      : CheckCircle2;
              const started = new Date(r.started * 1000);
              const day = dayLabel(started.getTime());
              const date =
                day === "Today" || day === "Yesterday"
                  ? day
                  : started.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
              const stamp = `${date}, ${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
              return (
                <tr key={r.id}>
                  <td>
                    <button className="run-ledger-title" onClick={() => useUi.getState().openView("run", String(r.id))}>
                      {r.title}
                    </button>
                    <small>
                      {r.trigger || "Manual"} · {r.model || "Default model"}
                    </small>
                    <time className="run-mobile-started" dateTime={started.toISOString()}>
                      {stamp}
                    </time>
                  </td>
                  <td>
                    <span className={`ledger-status ${tone}`}>
                      <Icon size={14} aria-hidden="true" className={r.status === "running" ? "spin" : undefined} />
                      {state}
                    </span>
                    <div className="run-ledger-notes">
                      {!!reviews && (
                        <small>
                          {reviews} pending {reviews === 1 ? "change" : "changes"}
                        </small>
                      )}
                      {!!warnings && (
                        <small>
                          {warnings} tool {warnings === 1 ? "warning" : "warnings"}
                        </small>
                      )}
                      {r.error && (
                        <small className="run-ledger-error" title={r.error}>
                          {r.error}
                        </small>
                      )}
                    </div>
                    <small className="run-mobile-duration">{runDuration(r)}</small>
                  </td>
                  <td className="run-ledger-started">
                    <time dateTime={started.toISOString()}>{stamp}</time>
                  </td>
                  <td className="run-ledger-duration">{runDuration(r)}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
