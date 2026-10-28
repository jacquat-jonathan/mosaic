import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button, IconButton, Notice } from "../design-system/components";
import { WorkflowCard, type RunState } from "../design-system/patterns";
import { api } from "../ipc/api";
import { errorMessage, type Agent, type AgentRun } from "../ipc/types";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { DesignSystemScope } from "./DesignSystemScope";
import { RunsLedger } from "./RunsLedger";
import {
  eventFolder,
  matchesEventFolder,
  pendingForRun,
  workflowDeleteTarget,
  workflowTrigger,
  workflowRunState,
} from "./workflowPresentation";
import { viewPath } from "./specialTabs";
import "../design-system/patterns.css";
import "./workflowList.css";
import "./workflowStatus.css";

function summary(run: AgentRun, reviews: number) {
  if (reviews) return `${reviews} proposed ${reviews === 1 ? "change is" : "changes are"} waiting for review.`;
  const text = (
    run.error ||
    run.answer ||
    (run.status === "running" ? "Waiting for output…" : "Open the run log for details.")
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}
type WorkflowListProps = { agentsOnly?: boolean; name?: string; onEdit?: () => void };
export function WorkflowList({ agentsOnly = false, name, onEdit }: WorkflowListProps) {
  const root = useVault((state) => state.vault?.root);
  return (
    <WorkflowCatalog key={`${root}:${name ?? ""}`} root={root} agentsOnly={agentsOnly} name={name} onEdit={onEdit} />
  );
}
function WorkflowCatalog({
  root,
  agentsOnly,
  name,
  onEdit,
}: WorkflowListProps & { root?: string; agentsOnly: boolean }) {
  const { status, agents, error, refresh } = useAttention();
  const pending = useReview((state) => state.pending);
  const selected = agents.find((agent) => agent.name === name);
  const shown = name ? agents.filter((agent) => agent.name === name) : agents;
  const runs = (status?.runs ?? []).filter((run) => !name || run.agent === name);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusTarget, restoreFocus] = useState<HTMLElement | null>(null);
  const locked = useRef(false);
  const firstAction = useRef<HTMLButtonElement>(null);
  const picker = useUi((state) => state.picker);
  const menu = useUi((state) => state.menu);
  const pickerOpener = useRef<HTMLElement | null>(null);
  const menuOpener = useRef<HTMLElement | null>(null);
  const current = () => !!root && useVault.getState().vault?.root === root;
  useEffect(() => {
    if (!picker && pickerOpener.current) {
      restoreFocus(pickerOpener.current);
      pickerOpener.current = null;
    }
  }, [picker]);
  useEffect(() => {
    if (!menu && !picker && menuOpener.current) {
      restoreFocus(menuOpener.current);
      menuOpener.current = null;
    }
  }, [menu, picker]);
  useEffect(() => {
    if (!busy && !picker && !menu && focusTarget) {
      (focusTarget.isConnected ? focusTarget : firstAction.current)?.focus({ preventScroll: true });
      restoreFocus(null);
    }
  }, [busy, picker, menu, focusTarget]);
  const act = async (work: () => Promise<unknown>, opener?: HTMLElement) => {
    if (locked.current || !current()) return;
    locked.current = true;
    setBusy(true);
    setProblem(null);
    if (opener) restoreFocus(opener);
    try {
      await work();
      if (current()) await refresh();
    } catch (cause) {
      if (current()) setProblem(errorMessage(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const testEvent = (agent: Agent, opener: HTMLElement) => {
    if (locked.current || !current()) return;
    const folders = agent.on.map(eventFolder).filter((folder): folder is string => folder !== null);
    const notes = useVault
      .getState()
      .entries.filter((entry) => !entry.is_dir && folders.some((folder) => matchesEventFolder(entry.path, folder)));
    pickerOpener.current = opener;
    useUi.getState().openPicker({
      placeholder: "Choose an existing note for the test event",
      items: notes.map((note) => ({
        id: note.path,
        label: note.name,
        detail: note.path.includes("/") ? note.path : undefined,
      })),
      hint: notes.length ? "↵ test trigger · esc cancel" : "No matching Markdown notes",
      onPick: (item) =>
        void act(async () => {
          const id = await api.tesseraTestEvent(agent.name, item.id);
          if (current()) useUi.getState().openView("run", String(id));
        }),
    });
  };
  const remove = (agent: Agent, opener: HTMLElement) =>
    act(async () => {
      const accepted = await useUi.getState().ask({
        title: `Delete “${agent.title}”?`,
        body: `${agent.skill_folder ? "Its agent folder" : "Its agent file"} will be moved to the macOS Trash and future automatic runs will stop. Existing run history will be kept.`,
        confirmLabel: "Delete workflow",
        danger: true,
      });
      if (!accepted || !current()) return;
      const live = useAttention.getState().status;
      if (
        live?.agents.some((entry) => entry.name === agent.name && entry.running) ||
        live?.runs.some((run) => run.agent === agent.name && run.status === "running")
      )
        throw new Error("Wait for the current run to finish before deleting this workflow.");
      if (!(await useVault.getState().remove(workflowDeleteTarget(agent)))) return;
      if (!current()) return;
      await api.mirrorAgents();
      if (!current()) return;
      const tab = viewPath("workflow", agent.name),
        workspace = useWorkspace.getState();
      for (const pane of workspace.panes) if (pane.tabs.includes(tab)) workspace.closeTab(pane.id, tab);
    }, opener);
  const latest = new Map<string, AgentRun>();
  for (const run of status?.runs ?? []) {
    const previous = latest.get(run.agent);
    if (!previous || run.started > previous.started || (run.started === previous.started && run.id > previous.id))
      latest.set(run.agent, run);
  }
  return (
    <div className="workspace-page workflow-list-page">
      <DesignSystemScope
        className="workflow-list workflow-status-scope"
        role="group"
        aria-label={name ? "Workflow detail" : agentsOnly ? "Agent library" : "Workflow catalog"}
      >
        <header className="workflow-list-heading">
          <div>
            <h1>
              {selected?.title ??
                (name ? (status ? "Workflow unavailable" : "Workflow") : agentsOnly ? "Agents" : "Workflows")}
            </h1>
            <p className="mds-hint">
              Repeatable work on your vault files. Schedules and events run while Mosaic is open.
            </p>
          </div>
          <Button
            ref={firstAction}
            data-workflow-edit={name ? "true" : undefined}
            variant="secondary"
            disabled={!root || busy || (!!name && !selected)}
            onClick={() => {
              if (!current()) return;
              if (name && selected) onEdit?.();
              else useUi.getState().openView("new-workflow");
            }}
          >
            {name ? "Edit workflow" : "Create workflow"}
          </Button>
          {!name && !agentsOnly && (
            <Button
              disabled={busy || !status || !root}
              onClick={(event) => void act(() => api.tesseraPauseAll(!status?.paused), event.currentTarget)}
            >
              {status?.paused ? "Resume automations" : "Pause automations"}
            </Button>
          )}
        </header>
        {(problem || error) && (
          <Notice tone="error">
            {problem || error}{" "}
            <Button variant="secondary" disabled={busy} onClick={() => void act(async () => {})}>
              Refresh workflows
            </Button>
          </Notice>
        )}
        {busy && (
          <p className="mds-hint workflow-list-note" role="status">
            Updating workflows…
          </p>
        )}
        {status?.paused && (
          <Notice tone="warning">
            All automatic workflows are paused. Manual runs and test triggers are available.
          </Notice>
        )}
        {!root ? (
          <Notice>Open a vault to configure workflows.</Notice>
        ) : !shown.length ? (
          <Notice>
            {status
              ? name
                ? "This workflow is unavailable. Return to the workflow list to choose another."
                : "No workflows yet. Create one to choose an agent, trigger, and folders."
              : error
                ? "Workflows could not be loaded."
                : "Loading workflows…"}
            {name && status && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (current()) useUi.getState().openView("workflows");
                }}
              >
                Back to workflows
              </Button>
            )}
          </Notice>
        ) : (
          <div className="workflow-list-grid">
            {shown.map((agent) => {
              const schedule = status?.agents.find((entry) => entry.name === agent.name),
                last = latest.get(agent.name);
              const running = !!schedule?.running || last?.status === "running",
                automatic = !!agent.schedule || !!agent.on.length;
              const needsReview = (status?.runs ?? []).some(
                (run) => run.agent === agent.name && pendingForRun(run, pending).length > 0,
              );
              const state: RunState = running
                ? "running"
                : schedule?.queued
                  ? "queued"
                  : schedule?.paused || (automatic && status?.paused)
                    ? "paused"
                    : schedule?.error
                      ? "failed"
                      : needsReview
                        ? "needs-review"
                        : last
                          ? workflowRunState(last)
                          : "ready";
              const reviews = pendingForRun(last, pending).length;
              return (
                <WorkflowCard
                  key={agent.name}
                  title={name ? "Workflow configuration" : agent.title}
                  description={agent.description}
                  state={state}
                  onOpen={
                    name
                      ? undefined
                      : () => {
                          if (current()) useUi.getState().openView("workflow", agent.name);
                        }
                  }
                  trigger={{
                    kind: agent.on.length ? "event" : agent.schedule ? "schedule" : "manual",
                    label: workflowTrigger(agent),
                  }}
                  input="Vault files allowed by folder rules"
                  output="Defined in the agent instructions"
                  reviewPolicy={
                    agent.may_change.length
                      ? `May update ${agent.may_change.join(", ")} directly. Other changes require review. Folder rules take precedence.`
                      : "Every change requires review. Folder rules take precedence."
                  }
                  metadata={[
                    { label: "Agent", value: agent.name },
                    { label: "Model", value: agent.model || "Claude Code default" },
                    { label: "May change without review", value: agent.may_change.join(", ") || "None" },
                    { label: "Web", value: agent.web ? "Can use the web" : "No web access" },
                    ...(schedule?.queued ? [{ label: "Queued runs", value: schedule.queued }] : []),
                  ]}
                  notice={schedule?.error ? <Notice tone="error">{schedule.error}</Notice> : undefined}
                  lastRun={
                    last
                      ? {
                          state: workflowRunState(last, reviews > 0),
                          when: new Date(last.started * 1000).toLocaleString(),
                          summary: summary(last, reviews),
                          action: (
                            <Button
                              onClick={() => {
                                if (current()) useUi.getState().openView("run", String(last.id));
                              }}
                            >
                              Open run log
                            </Button>
                          ),
                        }
                      : status
                        ? { when: "Not run yet", summary: "No result recorded yet." }
                        : undefined
                  }
                  actions={
                    <>
                      <Button
                        variant="secondary"
                        disabled={running || busy || !!schedule?.error || !status}
                        onClick={() =>
                          void act(async () => {
                            const id = await api.tesseraRun(agent.name);
                            if (current()) useUi.getState().openView("run", String(id));
                          })
                        }
                      >
                        Run now
                      </Button>
                      {!!agent.on.length && (
                        <Button
                          disabled={running || busy || !!schedule?.error || !status}
                          onClick={(event) => testEvent(agent, event.currentTarget)}
                        >
                          Test trigger…
                        </Button>
                      )}
                      {automatic && (
                        <Button
                          disabled={busy || !status}
                          onClick={(event) =>
                            void act(() => api.tesseraPauseAgent(agent.name, !schedule?.paused), event.currentTarget)
                          }
                        >
                          {schedule?.paused ? "Resume" : "Pause"}
                        </Button>
                      )}
                      <IconButton
                        label={`More actions for ${agent.title}`}
                        disabled={busy}
                        onClick={(event) => {
                          const opener = event.currentTarget,
                            bounds = opener.getBoundingClientRect();
                          menuOpener.current = opener;
                          useUi.getState().showMenu(bounds.left, bounds.bottom, [
                            {
                              label: "Edit workflow",
                              action: () => {
                                if (!current()) return;
                                if (name === agent.name) onEdit?.();
                                else useUi.getState().openView("workflow", agent.name);
                              },
                            },
                            {
                              label: "Edit agent source",
                              action: () => {
                                if (current())
                                  return act(() => useWorkspace.getState().open(agent.path, { newTab: true }));
                              },
                            },
                            ...(agent.on.length
                              ? [{ label: "Test event trigger…", action: () => testEvent(agent, opener) }]
                              : []),
                            { separator: true, label: "" },
                            {
                              label: "Delete workflow…",
                              danger: true,
                              disabled: running,
                              detail: running ? "Wait for the current run to finish" : undefined,
                              action: () => remove(agent, opener),
                            },
                          ]);
                        }}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </IconButton>
                    </>
                  }
                />
              );
            })}
          </div>
        )}
        {!agentsOnly && (
          <p className="mds-hint workflow-list-note">
            Recent run history appears below. Open a run to inspect its complete result.
          </p>
        )}
      </DesignSystemScope>
      {!agentsOnly && (
        <section className="workflow-list-recent" aria-label="Recent runs">
          <h2>Recent runs</h2>
          {runs.length ? (
            <RunsLedger runs={runs} pending={pending} />
          ) : (
            <p className="panel-meta">{status ? "No runs yet." : "Loading runs…"}</p>
          )}
        </section>
      )}
    </div>
  );
}
