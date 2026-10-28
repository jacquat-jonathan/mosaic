import { useRef, useState } from "react";
import { Eye, FileText, MessageSquare, Play, RotateCcw, Undo2 } from "lucide-react";
import {
  Badge,
  Button,
  ChatComposer,
  ChangeRow,
  Dialog,
  DiffView,
  Notice,
  RunPanel,
  RunsTable,
  StatusLabel,
  TextField,
  ToolActivity,
  TranscriptMessage,
  WorkflowCard,
  type RunState,
  type RunSummary,
} from "./index";

type Announce = { onAnnounce(message: string): void };

export function WorkflowExamples({ onAnnounce }: Announce) {
  const [state, setState] = useState<RunState>("ready");
  const [paused, setPaused] = useState(true);
  const [finished, setFinished] = useState(false);
  return (
    <div className="ds-stack">
      <div className="ds-two-up">
        <WorkflowCard
          title="Daily summary"
          description="Bring today's decisions, open questions, and next actions into one daily brief."
          state={state}
          trigger={{
            kind: "schedule",
            label: state === "paused" ? "Daily at 08:30 · Automatic runs paused" : "Every day at 08:30",
          }}
          input="Today's daily note and its linked notes"
          output="A summary in Drafts/Daily-summary.md"
          reviewPolicy="Can update Drafts/ directly. Other changes wait for your review."
          metadata={[
            { label: "Agent", value: "daily-summary" },
            { label: "Model", value: "Default model" },
            { label: "Direct updates", value: "Drafts/" },
            { label: "Web", value: "No web access" },
          ]}
          lastRun={
            finished
              ? {
                  state: "needs-review",
                  when: "Just now",
                  summary: "A summary update outside Drafts/ is waiting for your review.",
                  action: (
                    <a className="mds-workflow-review-link" href="#activity">
                      Review proposed changes →
                    </a>
                  ),
                }
              : { state: "completed", when: "Today, 08:30", summary: "Read 6 notes and updated the daily brief." }
          }
          actions={
            <>
              <Button
                variant="primary"
                disabled={state === "running"}
                onClick={() => {
                  setState("running");
                  onAnnounce("Sample workflow is running. No agent was started.");
                }}
              >
                <Play />
                Run now
              </Button>
              <Button
                disabled={state === "running"}
                onClick={() => setState(state === "paused" ? (finished ? "needs-review" : "ready") : "paused")}
              >
                {state === "paused" ? "Resume" : "Pause"}
              </Button>
            </>
          }
        />
        <WorkflowCard
          title="Inbox triage"
          description="Keep the inbox organized by suggesting a home and useful tags for each new note."
          state={paused ? "paused" : "ready"}
          trigger={{
            kind: "event",
            label: paused ? "New note in Inbox/ · Automatic runs paused" : "When a note is created in Inbox/",
          }}
          input="New Markdown notes in Inbox/"
          output="Suggested tags and a destination folder"
          reviewPolicy="Every change waits for your review. Notes stay in place until you accept."
          metadata={[
            { label: "Agent", value: "inbox-triage" },
            { label: "Model", value: "Default model" },
            { label: "Direct updates", value: "None · Review every change" },
            { label: "Web", value: "No web access" },
          ]}
          lastRun={{
            state: "needs-review",
            when: "Yesterday, 18:10",
            summary: "Suggested changes are ready for your review.",
            action: (
              <a className="mds-workflow-review-link" href="#activity">
                Review proposed changes →
              </a>
            ),
          }}
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setPaused(!paused);
                  onAnnounce(paused ? "Sample workflow resumed." : "Sample workflow paused.");
                }}
              >
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button onClick={() => onAnnounce("Sample trigger matched a note in Inbox/. No files were read.")}>
                Test trigger…
              </Button>
            </>
          }
        />
      </div>
      <div className="ds-workflow-preview-controls">
        <span className="mds-hint">Preview controls</span>
        {state === "running" && (
          <Button
            variant="secondary"
            onClick={() => {
              setState("needs-review");
              setFinished(true);
              onAnnounce("Sample run finished with a change awaiting review.");
            }}
          >
            Finish preview run
          </Button>
        )}
        <Button
          onClick={() => {
            setState("ready");
            setPaused(true);
            setFinished(false);
          }}
        >
          <RotateCcw />
          Reset workflow examples
        </Button>
      </div>
    </div>
  );
}

const runs: RunSummary[] = [
  {
    id: "review",
    title: "Daily summary",
    state: "needs-review",
    trigger: "Schedule",
    model: "Default model",
    started: "Today, 08:30",
    dateTime: "2026-10-28T08:30:00+01:00",
    duration: "24s",
    note: "2 pending changes",
  },
  {
    id: "running",
    title: "Inbox triage",
    state: "running",
    trigger: "File created",
    model: "Default model",
    started: "Today, 08:28",
    dateTime: "2026-10-28T08:28:00+01:00",
    duration: "In progress",
    note: "Reading notes",
  },
  {
    id: "done",
    title: "Weekly review",
    state: "completed",
    trigger: "Manual",
    model: "Default model",
    started: "Yesterday, 18:10",
    dateTime: "2026-10-27T18:10:00+01:00",
    duration: "1m 12s",
  },
  {
    id: "failed",
    title: "Project digest",
    state: "failed",
    trigger: "Manual",
    model: "Default model",
    started: "Yesterday, 16:45",
    dateTime: "2026-10-27T16:45:00+01:00",
    duration: "8s",
    note: "Source note unavailable",
  },
  {
    id: "skipped",
    title: "Inbox triage",
    state: "skipped",
    trigger: "File created",
    model: "Default model",
    started: "Yesterday, 15:20",
    dateTime: "2026-10-27T15:20:00+01:00",
    duration: "0s",
    note: "No matching notes",
  },
];

export function RunExamples() {
  const [selected, setSelected] = useState("review");
  const current = runs.find((run) => run.id === selected)!;
  return (
    <div className="ds-stack">
      <div className="ds-status-specimens" aria-label="Workflow and run states">
        {(["ready", "queued", "running", "paused", "completed", "needs-review", "failed", "skipped"] as const).map(
          (state) => (
            <StatusLabel key={state} state={state} />
          ),
        )}
      </div>
      <RunsTable runs={runs} selectedId={selected} onOpenRun={setSelected} />
      <p className="ds-caption">Choose a workflow row to inspect its sample run log.</p>
      <RunPanel
        title={current.title}
        state={current.state}
        metadata={`${current.started} · ${current.trigger} · ${current.model}`}
        outcome={
          <>
            <span>{current.state === "failed" || current.state === "skipped" ? "0" : "2"} files changed</span>
            <span>{current.state === "needs-review" ? "2 pending reviews" : "No pending reviews"}</span>
            {current.state === "needs-review" && (
              <a href="#activity" className="ds-pattern-link">
                Open review example →
              </a>
            )}
          </>
        }
      >
        <ToolActivity
          summary={
            current.state === "failed"
              ? "Read project notes"
              : current.state === "skipped"
                ? "Check workflow trigger"
                : "Read daily notes"
          }
          state={current.state === "failed" ? "failed" : "completed"}
        >
          {current.state === "failed"
            ? "Projects/Overview.md was unavailable. The run stopped before making a change."
            : current.state === "skipped"
              ? "No notes matched this trigger; the workflow was skipped."
              : "Read Daily/2026-10-28.md and its linked notes."}
        </ToolActivity>
        {current.state === "needs-review" && (
          <ToolActivity summary="Proposed a summary update" state="needs-review">
            Waiting for review · Daily/Summary.md
          </ToolActivity>
        )}
        <TranscriptMessage speaker="assistant">
          {current.state === "failed"
            ? "I couldn't read the source note, so no files were changed."
            : current.state === "skipped"
              ? "No notes matched this trigger. There was nothing to change."
              : current.state === "running"
                ? "Reading the inbox and checking where each note belongs…"
                : "Prepared a summary of the notes and grouped the next actions by project."}
        </TranscriptMessage>
        <details className="ds-run-details">
          <summary>Run details</summary>
          <dl className="mds-metadata">
            <div>
              <dt>Trigger</dt>
              <dd>{current.trigger}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{current.duration}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>1</dd>
            </div>
          </dl>
        </details>
      </RunPanel>
      <details className="ds-run-details">
        <summary>Empty runs state</summary>
        <RunsTable runs={[]} onOpenRun={() => {}} />
      </details>
    </div>
  );
}

export function ChatExample({ onAnnounce }: Announce) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [attachments, setAttachments] = useState(["Next steps.md"]);
  const [messages, setMessages] = useState<{ speaker: "user" | "assistant"; text: string }[]>([]);
  return (
    <div className="ds-chat-example">
      <header className="ds-pattern-header">
        <MessageSquare size={17} />
        <strong>Plan tomorrow</strong>
        <Badge>Sample chat</Badge>
      </header>
      <div className="mds-transcript ds-chat-transcript" aria-label="Sample conversation">
        <TranscriptMessage speaker="user">
          Summarize the next steps and suggest what to focus on tomorrow.
        </TranscriptMessage>
        <ToolActivity summary="Read Next steps.md">
          The attached note supplies context for this sample conversation.
        </ToolActivity>
        <TranscriptMessage speaker="assistant">
          The next step is to validate the design system before migrating the interface. Review the typography, icons,
          and interaction states first.
        </TranscriptMessage>
        <ToolActivity summary="Proposed an update to Next steps.md" state="needs-review">
          The change is waiting in Activity & review. Opening this preview does not modify the note.
        </ToolActivity>
        {messages.map((message, index) => (
          <TranscriptMessage key={index} speaker={message.speaker}>
            {message.text}
          </TranscriptMessage>
        ))}
        {busy && (
          <div className="ds-chat-progress" role="status">
            <StatusLabel state="running" />
            <Button
              variant="secondary"
              onClick={() => {
                setBusy(false);
                setMessages((previous) => [
                  ...previous,
                  { speaker: "assistant", text: "Sample response: the summary is ready for your review." },
                ]);
              }}
            >
              Finish preview response
            </Button>
          </div>
        )}
      </div>
      <ChatComposer
        value={value}
        onChange={setValue}
        busy={busy}
        attachments={attachments}
        model={model}
        onModelChange={setModel}
        modelOptions={[
          { value: "", label: "Default model" },
          { value: "sonnet", label: "Sonnet" },
          { value: "opus", label: "Opus" },
          { value: "haiku", label: "Haiku" },
        ]}
        onAttach={() => {
          setAttachments((previous) =>
            previous.includes("Project brief.md") ? previous : [...previous, "Project brief.md"],
          );
          onAnnounce("Attached a sample note to the preview.");
        }}
        onRemoveAttachment={(name) =>
          setAttachments((previous) => previous.filter((attachment) => attachment !== name))
        }
        onSend={() => {
          setMessages((previous) => [...previous, { speaker: "user", text: value.trim() }]);
          setValue("");
          setBusy(true);
        }}
        onStop={() => {
          setBusy(false);
          onAnnounce("Sample response stopped.");
        }}
      />
    </div>
  );
}

const proposals = [
  { id: "summary", name: "Daily summary", path: "Daily/Summary.md", actor: "Daily summary", stale: false },
  { id: "roadmap", name: "Project roadmap", path: "Projects/Roadmap.md", actor: "Inbox triage", stale: true },
] as const;
const diff = [
  { type: "context", text: "## Next actions" },
  { type: "remove", text: "- Explore a shared UI foundation." },
  { type: "add", text: "- Validate the design system before migrating components." },
  { type: "context", text: "" },
] as const;

export function ActivityExample({ onAnnounce }: Announce) {
  const [decisions, setDecisions] = useState<Record<string, "accepted" | "rejected">>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const proposal = proposals.find((item) => item.id === selected);
  const pending = proposals.filter((item) => !decisions[item.id]);
  const decide = (decision: "accepted" | "rejected") => {
    if (!selected) return;
    setDecisions({ ...decisions, [selected]: decision });
    setSelected(null);
    onAnnounce(
      `Sample proposal ${decision}.${reason.trim() && decision === "rejected" ? ` Reason: ${reason.trim()}` : ""} No vault files were changed.`,
    );
  };
  return (
    <div className="ds-activity-example">
      <header className="ds-pattern-header">
        <strong>Activity & review</strong>
        <Badge>Sample data</Badge>
      </header>
      <section aria-label="Waiting for your review preview">
        <h3>
          Waiting for your review <Badge>{pending.length}</Badge>
        </h3>
        {pending.map((item) => (
          <ChangeRow key={item.id} {...item} action="Edited" time="2 min ago">
            <Button
              variant="primary"
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setSelected(item.id);
                setRejecting(false);
                setReason("");
                setConfirmed(false);
              }}
            >
              <Eye />
              Review
            </Button>
          </ChangeRow>
        ))}
        {!pending.length && (
          <p className="mds-pattern-empty">You're all caught up. No changes are waiting for review.</p>
        )}
      </section>
      <section aria-label="Applied changes preview">
        <h3>Applied changes</h3>
        {proposals
          .filter((item) => decisions[item.id] === "accepted")
          .map((item) => (
            <ChangeRow key={item.id} {...item} action="Accepted" time="Just now">
              <Button
                variant="secondary"
                onClick={() => {
                  const next = { ...decisions };
                  delete next[item.id];
                  setDecisions(next);
                  onAnnounce("Sample acceptance undone.");
                }}
              >
                <Undo2 />
                Undo
              </Button>
            </ChangeRow>
          ))}
        <ChangeRow
          name="Meeting notes"
          path="Meetings/Weekly.md"
          actor="Writing assistant"
          action={undone ? "Undone" : "Edited"}
          time="10 min ago"
        >
          <Button onClick={() => onAnnounce("Sample file: Meetings/Weekly.md")}>
            <FileText />
            Open
          </Button>
          <Button
            variant="secondary"
            disabled={undone}
            onClick={() => {
              setUndone(true);
              onAnnounce("Sample change undone. No file was changed.");
            }}
          >
            <Undo2 />
            {undone ? "Undone" : "Undo"}
          </Button>
        </ChangeRow>
      </section>
      <div className="ds-example-footer">
        <span className="mds-hint">Review, acceptance, rejection, and undo operate on sample data.</span>
        <Button
          onClick={() => {
            setDecisions({});
            setUndone(false);
          }}
        >
          Reset review example
        </Button>
      </div>
      <Dialog
        open={!!proposal}
        size="wide"
        title={`Review changes to ${proposal?.name ?? "note"}`}
        description={`${proposal?.actor ?? "Agent"} proposes an edit to ${proposal?.path ?? "a note"}.`}
        returnFocusRef={trigger}
        onClose={() => setSelected(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setSelected(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => (rejecting ? decide("rejected") : setRejecting(true))}>
              {rejecting ? "Confirm rejection" : "Reject…"}
            </Button>
            <Button variant="primary" disabled={!!proposal?.stale && !confirmed} onClick={() => decide("accepted")}>
              Accept change
            </Button>
          </>
        }
      >
        {proposal?.stale && (
          <Notice tone="warning">The file changed after this proposal. Review the difference before accepting.</Notice>
        )}
        <DiffView lines={diff} />
        {proposal?.stale && (
          <label className="ds-confirm-change">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I
            reviewed the changes made since this proposal.
          </label>
        )}
        {rejecting && (
          <TextField
            autoFocus
            label="Reason for rejection"
            hint="Optional feedback for the agent."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Dialog>
    </div>
  );
}
