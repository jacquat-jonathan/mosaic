import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react";
import { api } from "../ipc/api";
import { errorMessage, type Agent } from "../ipc/types";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { viewPath } from "./specialTabs";
import { TranscriptItem, openTranscriptLink } from "./Transcript";
import { appendTranscriptEvent } from "../state/transcript";
import type { ChatItem } from "../state/chat";
import {
  pendingForRun,
  runState,
  eventFolder,
  matchesEventFolder,
  workflowTrigger,
  workflowDeleteTarget,
} from "./workflowPresentation";
export {
  pendingForRun,
  runState,
  runDuration,
  eventFolder,
  matchesEventFolder,
  workflowTrigger,
  workflowDeleteTarget,
} from "./workflowPresentation";
import { RunsLedger } from "./RunsLedger";
import { WorkflowList } from "./WorkflowList";
import { WorkflowForm } from "./WorkflowForm";

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
export function WorkflowContext({ name }: { name: string }) {
  const agent = useAttention((s) => s.agents.find((a) => a.name === name));
  const status = useAttention((s) => s.status);
  const scheduled = status?.agents.find((a) => a.name === name);
  const latest = status?.runs.find((r) => r.agent === name);
  const pending = useReview((s) => s.pending);
  if (!agent) return <p className="panel-meta">Workflow unavailable.</p>;
  const needsReview = status?.runs.some((r) => r.agent === name && pendingForRun(r, pending).length);
  const automatic = !!agent.schedule || !!agent.on?.length;
  const state =
    scheduled?.running || latest?.status === "running"
      ? "Running"
      : scheduled?.queued
        ? "Queued"
        : scheduled?.paused || (automatic && status?.paused)
          ? "Paused"
          : scheduled?.error
            ? "Failed"
            : needsReview
              ? "Needs review"
              : latest
                ? runState(latest)
                : "Ready";
  return (
    <div className="context-content">
      <h3>{agent.title}</h3>
      <dl>
        <dt>Agent</dt>
        <dd>{agent.name}</dd>
        <dt>Trigger</dt>
        <dd>{workflowTrigger(agent)}</dd>
        <dt>Model</dt>
        <dd>{agent.model || "Claude Code default"}</dd>
        <dt>Allowed folders</dt>
        <dd>{agent.may_change.join(", ") || "All changes require review"}</dd>
        <dt>Web</dt>
        <dd>{agent.web ? "Can use the web" : "No web access"}</dd>
        <dt>Status</dt>
        <dd>{state}</dd>
      </dl>
      <button onClick={() => void useWorkspace.getState().open(agent.path, { newTab: true })}>Edit source</button>
    </div>
  );
}
function LegacyWorkflows({
  name,
  runsOnly = false,
  agentsOnly = false,
}: {
  name?: string;
  runsOnly?: boolean;
  agentsOnly?: boolean;
}) {
  const { status, agents, error, refresh } = useAttention();
  const pending = useReview((s) => s.pending);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const selected = agents.find((a) => a.name === name);
  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setProblem(null);
    try {
      await work();
      await refresh();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const testEvent = (agent: Agent) => {
    const folders = (agent.on ?? []).map(eventFolder).filter((f): f is string => f !== null);
    const notes = useVault
      .getState()
      .entries.filter((e) => !e.is_dir && folders.some((folder) => matchesEventFolder(e.path, folder)));
    useUi.getState().openPicker({
      placeholder: "Choose an existing note for the test event",
      items: notes.map((n) => ({ id: n.path, label: n.name, detail: n.path.includes("/") ? n.path : undefined })),
      hint: notes.length ? "↵ test trigger · esc cancel" : "No matching Markdown notes",
      onPick: (item) =>
        void act(agent.name, async () => {
          const id = await api.tesseraTestEvent(agent.name, item.id);
          useUi.getState().openView("run", String(id));
        }),
    });
  };
  const removeWorkflow = async (agent: Agent) => {
    const target = workflowDeleteTarget(agent);
    const ok = await useUi.getState().ask({
      title: `Delete “${agent.title}”?`,
      body: `${agent.skill_folder ? "Its agent folder" : "Its agent file"} will be moved to the macOS Trash and future automatic runs will stop. Existing run history will be kept.`,
      confirmLabel: "Delete workflow",
      danger: true,
    });
    if (!ok) return;
    setBusy(agent.name);
    setProblem(null);
    try {
      if (!(await useVault.getState().remove(target))) return;
      await api.mirrorAgents();
      await refresh();
      const tab = viewPath("workflow", agent.name);
      const ws = useWorkspace.getState();
      for (const pane of ws.panes) if (pane.tabs.includes(tab)) ws.closeTab(pane.id, tab);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  if (editing && selected)
    return (
      <WorkflowForm
        agent={selected}
        onDone={() => {
          setEditing(false);
          void refresh();
        }}
      />
    );
  const shown = name ? agents.filter((a) => a.name === name) : agents;
  const runs = (status?.runs ?? []).filter((r) => !name || r.agent === name);
  return (
    <div className="workspace-page">
      <header className="workspace-heading">
        <div>
          <h1>{selected?.title ?? (runsOnly ? "Runs" : agentsOnly ? "Agents" : "Workflows")}</h1>
          <p>
            {runsOnly
              ? "Workflow history, newest first."
              : "Repeatable work on your vault files. Schedules and events run while Mosaic is open."}
          </p>
        </div>
        {!runsOnly && (
          <button
            className="primary"
            onClick={() => (selected ? setEditing(true) : useUi.getState().openView("new-workflow"))}
          >
            {selected ? "Edit workflow" : "Create workflow"}
          </button>
        )}
        {!name && !agentsOnly && !runsOnly && (
          <button
            disabled={!!busy || !status}
            onClick={() => void act("all", () => api.tesseraPauseAll(!status?.paused))}
          >
            {status?.paused ? "Resume automations" : "Pause automations"}
          </button>
        )}
      </header>
      {(problem || error) && (
        <p className="error-text" role="alert">
          {problem || error}
        </p>
      )}
      {status?.paused && (
        <p className="notice warn">All automatic workflows are paused. Manual runs and test triggers are available.</p>
      )}
      {!runsOnly && (
        <div className="workflow-grid">
          {shown.map((a) => {
            const schedule = status?.agents.find((x) => x.name === a.name);
            const latest = status?.runs.find((r) => r.agent === a.name);
            const running = schedule?.running || latest?.status === "running";
            const automatic = !!a.schedule || !!a.on?.length;
            const needsReview =
              status?.runs.filter((r) => r.agent === a.name).some((r) => pendingForRun(r, pending).length) ?? false;
            const state = running
              ? "Running"
              : schedule?.queued
                ? `Queued · ${schedule.queued}`
                : schedule?.paused || (automatic && status?.paused)
                  ? "Paused"
                  : schedule?.error
                    ? "Failed"
                    : needsReview
                      ? "Needs review"
                      : latest
                        ? runState(latest)
                        : "Ready";
            return (
              <article className="workflow-card" key={a.name}>
                <header>
                  <button className="workflow-title" onClick={() => useUi.getState().openView("workflow", a.name)}>
                    {a.title}
                  </button>
                  <span className="state-label">{state}</span>
                </header>
                <p>{a.description}</p>
                <dl>
                  <dt>Agent</dt>
                  <dd>{a.name}</dd>
                  <dt>Trigger</dt>
                  <dd>{workflowTrigger(a)}</dd>
                  <dt>Model</dt>
                  <dd>{a.model || "Claude Code default"}</dd>
                  <dt>May change without review</dt>
                  <dd>{a.may_change.join(", ") || "None — review every change"}</dd>
                  <dt>Web</dt>
                  <dd>{a.web ? "Can use the web" : "No web access"}</dd>
                </dl>
                {schedule?.error && <p className="error-text">{schedule.error}</p>}
                {latest && (
                  <button onClick={() => useUi.getState().openView("run", String(latest.id))}>
                    Last run: {runState(latest, needsReview)} · {new Date(latest.started * 1000).toLocaleString()}
                  </button>
                )}
                <footer>
                  <button
                    className="primary"
                    disabled={running || !!busy || !!schedule?.error}
                    onClick={() =>
                      void act(a.name, async () => {
                        const id = await api.tesseraRun(a.name);
                        useUi.getState().openView("run", String(id));
                      })
                    }
                  >
                    Run now
                  </button>
                  {!!a.on?.length && (
                    <button disabled={running || !!busy || !!schedule?.error} onClick={() => testEvent(a)}>
                      Test trigger…
                    </button>
                  )}
                  {automatic && (
                    <button
                      disabled={!!busy}
                      onClick={() => void act(a.name, () => api.tesseraPauseAgent(a.name, !schedule?.paused))}
                    >
                      {schedule?.paused ? "Resume" : "Pause"}
                    </button>
                  )}
                  <button
                    aria-label={`More actions for ${a.title}`}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      useUi.getState().showMenu(r.left, r.bottom, [
                        {
                          label: "Edit workflow",
                          action: () => {
                            useUi.getState().openView("workflow", a.name);
                            if (name === a.name) setEditing(true);
                          },
                        },
                        {
                          label: "Edit agent source",
                          action: () => void useWorkspace.getState().open(a.path, { newTab: true }),
                        },
                        ...(a.on?.length ? [{ label: "Test event trigger…", action: () => testEvent(a) }] : []),
                        { separator: true, label: "" },
                        {
                          label: "Delete workflow…",
                          danger: true,
                          disabled: !!running,
                          detail: running ? "Wait for the current run to finish" : undefined,
                          action: () => void removeWorkflow(a),
                        },
                      ]);
                    }}
                  >
                    ⋯
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {!runsOnly && !shown.length && (
        <p className="panel-meta">
          {status ? "No workflows yet. Create one to choose an agent, trigger, and folders." : "Loading workflows…"}
        </p>
      )}
      {!agentsOnly && (
        <section aria-label={runsOnly ? "Run history" : "Recent runs"}>
          {!runsOnly && <h2>Recent runs</h2>}
          {!runs.length ? (
            <p className="panel-meta">{status ? "No runs yet." : "Loading runs…"}</p>
          ) : (
            <RunsLedger runs={runs} pending={pending} />
          )}
        </section>
      )}
    </div>
  );
}

export function Workflows(props: { name?: string; runsOnly?: boolean; agentsOnly?: boolean }) {
  return props.name || props.runsOnly ? <LegacyWorkflows {...props} /> : <WorkflowList agentsOnly={props.agentsOnly} />;
}

export { WorkflowForm, workflowContent } from "./WorkflowForm";
