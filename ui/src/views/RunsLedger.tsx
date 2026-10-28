import { RunsTable, type RunSummary } from "../design-system/patterns";
import type { AgentRun, Proposal } from "../ipc/types";
import type { ChatItem } from "../state/chat";
import { appendTranscriptEvent } from "../state/transcript";
import { useUi } from "../state/ui";
import { dayLabel } from "../time";
import { pendingForRun, workflowRunState, runDuration } from "./workflowPresentation";
import "../design-system/patterns.css";
import "./workflowStatus.css";

export function RunsLedger({ runs, pending }: { runs: AgentRun[]; pending: Proposal[] }) {
  const rows: RunSummary[] = [...runs]
    .sort((a, b) => b.started - a.started || b.id - a.id)
    .map((run) => {
      const reviews = pendingForRun(run, pending).length;
      const warnings = (run.transcript?.events ?? [])
        .reduce<ChatItem[]>(appendTranscriptEvent, [])
        .filter((item) => item.kind === "tool" && item.error).length;
      const started = new Date(run.started * 1000);
      const day = dayLabel(started.getTime());
      const date =
        day === "Today" || day === "Yesterday"
          ? day
          : started.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
      return {
        id: String(run.id),
        title: run.title,
        state: workflowRunState(run, reviews > 0),
        trigger: run.trigger || "Manual",
        model: run.model || "Default model",
        started: `${date}, ${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        dateTime: started.toISOString(),
        duration: runDuration(run),
        note: [
          reviews ? `${reviews} pending ${reviews === 1 ? "change" : "changes"}` : "",
          warnings ? `${warnings} tool ${warnings === 1 ? "warning" : "warnings"}` : "",
          run.error,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });
  return <RunsTable label="Workflow runs" runs={rows} onOpenRun={(id) => useUi.getState().openView("run", id)} />;
}
