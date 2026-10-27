import { useCallback, useEffect, useMemo, useState, type CSSProperties, type DragEvent } from "react";
import { api, inTauri, onPlannerChanged } from "../../ipc/api";
import {
  errorMessage,
  type MarkdownImportPreview,
  type PlannerEpic,
  type PlannerSummary,
  type PlannerTask,
  type PlannerTaskStatus,
} from "../../ipc/types";
import { useUi } from "../../state/ui";
import { useVault } from "../../state/vault";
import { MigrationWizard } from "./MigrationWizard";
import { TaskEditor } from "./TaskEditor";
import { ActivityTimeline } from "./ActivityTimeline";
import { EpicEditor } from "./EpicEditor";
import {
  descendantsFrom,
  PLANNER_STATUSES,
  reorderEpics,
  swimlanes,
  taskChildren,
  taskLifecycles,
} from "./plannerModel";

const DRAG_TYPE = "application/x-mosaic-planner-task";
const EPIC_DRAG_TYPE = "application/x-mosaic-planner-epic";
const DEFAULT_EPIC_COLOR = "#6477d4";
const startedKey = (root: string) => `mosaic:planner-started:${root}`;
const wasStarted = (root: string) => {
  try {
    return localStorage.getItem(startedKey(root)) === "1";
  } catch {
    return false;
  }
};
const markStarted = (root: string) => {
  try {
    localStorage.setItem(startedKey(root), "1");
  } catch {
    /* Private browsing may refuse storage. */
  }
};

export function BoardView() {
  const root = useVault((state) => state.vault?.root) ?? "";
  const [summary, setSummary] = useState<PlannerSummary | null>(null),
    [epics, setEpics] = useState<PlannerEpic[]>([]),
    [tasks, setTasks] = useState<PlannerTask[]>([]),
    [preview, setPreview] = useState<MarkdownImportPreview | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    [statusFilter, setStatusFilter] = useState<PlannerTaskStatus | "">(""),
    [epicFilter, setEpicFilter] = useState(""),
    [lifecycle, setLifecycle] = useState<"active" | "archived" | "trash">("active");
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [historyEpic, setHistoryEpic] = useState<PlannerEpic | null>(null),
    [epicEditor, setEpicEditor] = useState<PlannerEpic | "new" | null>(null),
    [draggedId, setDraggedId] = useState<string | null>(null),
    [draggedEpicId, setDraggedEpicId] = useState<string | null>(null),
    [epicDropTarget, setEpicDropTarget] = useState<string | null | undefined>(undefined),
    [epicsBusy, setEpicsBusy] = useState(false),
    [dropTarget, setDropTarget] = useState<string | null>(null),
    [collapsed, setCollapsed] = useState(new Set<string>()),
    [busy, setBusy] = useState(new Set<string>()),
    [dismissed, setDismissed] = useState(false),
    [wizard, setWizard] = useState(false);
  const load = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    try {
      const historical = lifecycle !== "active",
        trashed = lifecycle === "trash",
        [nextSummary, rawEpics, rawTasks] = await Promise.all([
          api.plannerSummary(),
          api.plannerEpics(historical, trashed),
          api.plannerTasks(historical, trashed),
        ]),
        taskLifecycle = taskLifecycles(rawTasks, rawEpics),
        nextTasks = rawTasks.filter((item) => taskLifecycle.get(item.id) === lifecycle),
        nextEpics = rawEpics.filter(
          (item) =>
            (lifecycle === "active"
              ? !item.archived_at && !item.trashed_at
              : lifecycle === "archived"
                ? !!item.archived_at && !item.trashed_at
                : !!item.trashed_at) || nextTasks.some((task) => task.epic_id === item.id),
        );
      if (root !== useVault.getState().vault?.root) return;
      setSummary(nextSummary);
      setEpics(nextEpics);
      setTasks(nextTasks);
      setSelectedId((current) => (nextTasks.some((item) => item.id === current) ? current : null));
      setError(null);
      if (nextSummary.is_empty) {
        const nextPreview = await api.plannerMigrationPreview();
        if (root === useVault.getState().vault?.root) setPreview(nextPreview);
      } else setPreview(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [root, lifecycle]);
  useEffect(() => {
    setSelectedId(null);
    setDismissed(false);
    setWizard(false);
    void load();
  }, [load]);
  useEffect(() => {
    let off: (() => void) | undefined;
    void onPlannerChanged((change) => {
      if (change.root === root) void load();
    }).then((unsubscribe) => {
      off = unsubscribe;
    });
    return () => off?.();
  }, [root, load]);
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const allLanes = useMemo(() => swimlanes(epics, tasks), [epics, tasks]);
  const hierarchy = useMemo(() => taskChildren(tasks), [tasks]);
  const lanes = allLanes
    .filter((lane) => !epicFilter || (epicFilter === "__unassigned" ? lane.id === null : lane.id === epicFilter))
    .map((lane) => ({
      ...lane,
      tasks: lane.tasks.filter((task) => {
        const needle = search.trim().toLowerCase();
        if (!statusFilter && !needle) return true;
        const family = [task, ...descendantsFrom(hierarchy, task.id)];
        return (
          (!statusFilter || family.some((item) => item.status === statusFilter)) &&
          (!needle || family.some((item) => `${item.title}\n${item.description}`.toLowerCase().includes(needle)))
        );
      }),
    }));
  const setTaskBusy = (id: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const moveEpic = async (movedId: string, beforeId: string | null) => {
    if (lifecycle !== "active" || epicFilter || epicsBusy) return;
    const next = reorderEpics(epics, movedId, beforeId),
      changed = next.filter((item) => epics.find((epic) => epic.id === item.id)?.position !== item.position);
    if (!changed.length) return;
    setEpicsBusy(true);
    setError(null);
    try {
      for (const epic of changed) {
        const current = epics.find((item) => item.id === epic.id)!;
        await api.updatePlannerEpic(epic.id, { expected_revision: current.revision, position: epic.position });
      }
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
      await load();
    } finally {
      setEpicsBusy(false);
      setDraggedEpicId(null);
      setEpicDropTarget(undefined);
    }
  };
  const futurePolicy = async (taskId: string) => {
    const now = new Date(),
      today = now.toISOString().slice(0, 10),
      future = (await api.plannerWorkSessions(taskId, false)).filter((session) =>
        session.all_day ? session.start_value > today : session.start_value > now.toISOString(),
      );
    if (!future.length) return "cancel" as const;
    if (
      await useUi.getState().ask({
        title: "Cancel future work sessions?",
        body: `${future.length} future session${future.length === 1 ? "" : "s"} can be cancelled now.`,
        confirmLabel: "Cancel sessions",
      })
    )
      return "cancel" as const;
    if (
      await useUi.getState().ask({
        title: "Keep future work sessions?",
        body: "They will remain visible after this task is completed.",
        confirmLabel: "Keep sessions",
      })
    )
      return "keep" as const;
    return null;
  };
  const act = async (
    task: PlannerTask,
    epicId: string | null,
    status: PlannerTaskStatus,
    requestedPosition?: number,
  ) => {
    if (busy.has(task.id) || task.archived_at) return;
    setTaskBusy(task.id, true);
    setError(null);
    try {
      let current = task;
      const position =
        requestedPosition ??
        Math.max(
          0,
          ...tasks
            .filter(
              (item) =>
                item.id !== task.id &&
                item.epic_id === epicId &&
                item.parent_id === task.parent_id &&
                item.status === status,
            )
            .map((item) => item.position),
        ) + 1024;
      if (current.status === "done" && status !== "done")
        current = await api.reopenPlannerTask(current.id, current.revision);
      if (current.epic_id !== epicId || (status !== "done" && current.status !== status))
        current = await api.movePlannerTask(current.id, {
          expected_revision: current.revision,
          epic_id: epicId,
          parent_id: current.parent_id,
          status: status === "done" ? current.status : status,
          position,
        });
      if (status === "done" && current.status !== "done") {
        const open = tasks.some((item) => item.parent_id === current.id && item.status !== "done" && !item.archived_at);
        if (
          open &&
          !(await useUi.getState().ask({
            title: "Complete task with unfinished subtasks?",
            body: "The subtasks will remain incomplete.",
            confirmLabel: "Complete task",
          }))
        )
          return;
        const policy = await futurePolicy(current.id);
        if (!policy) return;
        current = await api.completePlannerTask(current.id, current.revision, open, policy);
      }
      setSelectedId(current.id);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setTaskBusy(task.id, false);
      setDraggedId(null);
      setDropTarget(null);
    }
  };
  const createTask = async (epicId: string | null) => {
    const title = await useUi.getState().askText({ title: "New task", value: "", placeholder: "What needs doing?" });
    if (!title?.trim()) return;
    try {
      const task = await api.createPlannerTask({
        epic_id: epicId,
        parent_id: null,
        title: title.trim(),
        description: "",
        status: "new",
        due_date: null,
        estimate_minutes: null,
      });
      markStarted(root);
      setSelectedId(task.id);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const archiveEpic = async (epic: PlannerEpic) => {
    if (
      !(await useUi.getState().ask({
        title: "Archive epic?",
        body: "Its tasks stay linked to it and remain recoverable.",
        confirmLabel: "Archive",
      }))
    )
      return;
    try {
      await api.archivePlannerEpic(epic.id, epic.revision);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const trashEpic = async (epic: PlannerEpic) => {
    if (
      !(await useUi.getState().ask({
        title: "Delete epic?",
        body: "It will move to Deleted and remain recoverable.",
        confirmLabel: "Delete",
      }))
    )
      return;
    try {
      await api.trashPlannerEpic(epic.id, epic.revision);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const openMigration = async () => {
    setError(null);
    try {
      setPreview(await api.plannerMigrationPreview());
      setWizard(true);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const exportPlan = async (format: "json" | "csv") => {
    try {
      if (inTauri) {
        const { save } = await import("@tauri-apps/plugin-dialog"),
          path = await save({
            title: `Export planner as ${format.toUpperCase()}`,
            defaultPath: `mosaic-plan.${format}`,
            filters: [{ name: format.toUpperCase(), extensions: [format] }],
          });
        if (path) await api.exportPlannerFile(format, path);
      } else {
        const content = await api.exportPlanner(format),
          url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/csv" })),
          link = document.createElement("a");
        link.href = url;
        link.download = `mosaic-plan.${format}`;
        link.click();
        URL.revokeObjectURL(url);
      }
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const onboarding = summary?.is_empty && !!preview?.candidates && !wasStarted(root) && !dismissed;
  if (onboarding && !wizard)
    return (
      <div className="workspace-page planner-onboarding">
        <h1>Plan your work in Mosaic</h1>
        <p>
          Board and Calendar use independent planner tasks. Your existing Markdown checkboxes stay exactly where they
          are.
        </p>
        <div className="planner-onboarding-actions">
          <button
            onClick={() => {
              markStarted(root);
              setDismissed(true);
            }}
          >
            Start empty
          </button>
          <button className="primary" onClick={() => setWizard(true)}>
            Preview import
          </button>
          <button onClick={() => setDismissed(true)}>Later</button>
        </div>
        <p className="panel-meta">
          {preview.candidates} Markdown tasks are available to preview. Nothing is imported without confirmation.
        </p>
      </div>
    );
  if (wizard && preview)
    return (
      <div className="workspace-page">
        <MigrationWizard
          preview={preview}
          onCancel={() => setWizard(false)}
          onDone={() => {
            markStarted(root);
            setWizard(false);
            void load();
          }}
        />
      </div>
    );
  return (
    <div className={`workspace-page planner-board-page ${selected ? "with-editor" : ""}`}>
      <main className="planner-board" aria-busy={loading}>
        <header className="board-toolbar">
          <h1>Board</h1>
          {lifecycle === "active" && (
            <>
              <button className="primary" onClick={() => void createTask(null)}>
                New task
              </button>
              <button onClick={() => setEpicEditor("new")}>New epic</button>
              <button onClick={() => void openMigration()}>Import Markdown tasks…</button>
            </>
          )}
          <input
            type="search"
            aria-label="Search planner tasks"
            placeholder="Search tasks…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Filter by epic"
            value={epicFilter}
            onChange={(event) => setEpicFilter(event.target.value)}
          >
            <option value="">All epics</option>
            {epics.map((epic) => (
              <option value={epic.id} key={epic.id}>
                {epic.title}
              </option>
            ))}
            <option value="__unassigned">Unassigned</option>
          </select>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as PlannerTaskStatus | "")}
          >
            <option value="">All statuses</option>
            {PLANNER_STATUSES.map((item) => (
              <option value={item.id} key={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Planner lifecycle view"
            title="Deleted items remain recoverable and can be restored."
            value={lifecycle}
            onChange={(event) => setLifecycle(event.target.value as typeof lifecycle)}
          >
            <option value="active">Active</option>
            <option value="archived">Archive</option>
            <option value="trash">Deleted</option>
          </select>
          <details className="planner-export">
            <summary>Export</summary>
            <div>
              <button onClick={() => void exportPlan("json")}>JSON export</button>
              <button onClick={() => void exportPlan("csv")}>CSV table</button>
            </div>
          </details>
        </header>
        {error && <p className="error-text">{error}</p>}
        {loading && !summary && <p>Loading planner…</p>}
        <div className="board-scroll">
          <div className="board-grid planner-grid">
            <div className="board-headings">
              {PLANNER_STATUSES.map((status) => (
                <h2 key={status.id}>
                  {status.title}
                  <span className="panel-meta">
                    {tasks.filter((task) => task.status === status.id && !task.parent_id).length}
                  </span>
                </h2>
              ))}
            </div>
            {lanes.map((lane) => {
              const key = lane.id ?? "__unassigned",
                closed = collapsed.has(key),
                orderedEpics = [...epics].sort((a, b) => a.position - b.position),
                epicIndex = lane.id ? orderedEpics.findIndex((item) => item.id === lane.id) : -1,
                epicInView =
                  lane.epic &&
                  (lifecycle === "active"
                    ? !lane.epic.archived_at && !lane.epic.trashed_at
                    : lifecycle === "archived"
                      ? !!lane.epic.archived_at && !lane.epic.trashed_at
                      : !!lane.epic.trashed_at);
              return (
                <section
                  className={`planner-lane ${lane.epic?.archived_at ? "archived" : ""} ${epicDropTarget === lane.id ? "epic-drop-target" : ""}`}
                  key={key}
                  style={{ "--epic-color": lane.color ?? "var(--border)" } as CSSProperties}
                  onDragOver={(event) => {
                    if (
                      lifecycle === "active" &&
                      !epicFilter &&
                      draggedEpicId &&
                      event.dataTransfer.types.includes(EPIC_DRAG_TYPE)
                    ) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setEpicDropTarget(lane.id);
                    }
                  }}
                  onDrop={(event) => {
                    const movedId = event.dataTransfer.getData(EPIC_DRAG_TYPE);
                    if (!movedId) return;
                    event.preventDefault();
                    event.stopPropagation();
                    void moveEpic(movedId, lane.id);
                  }}
                >
                  <header className="planner-lane-title">
                    <button
                      aria-expanded={!closed}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    >
                      {closed ? "▸" : "▾"}
                    </button>
                    <strong>{lane.title}</strong>
                    <span className="panel-meta">{lane.tasks.length} tasks</span>
                    {lifecycle === "active" && lane.epic && (
                      <>
                        <span
                          className="planner-lane-drag"
                          draggable={!epicFilter && !epicsBusy}
                          aria-hidden="true"
                          title={epicFilter ? "Clear the epic filter to reorder epics" : "Drag to reorder epic"}
                          onDragStart={(event) => {
                            event.dataTransfer.setData(EPIC_DRAG_TYPE, lane.epic!.id);
                            event.dataTransfer.effectAllowed = "move";
                            setDraggedEpicId(lane.epic!.id);
                          }}
                          onDragEnd={() => {
                            setDraggedEpicId(null);
                            setEpicDropTarget(undefined);
                          }}
                        >
                          ⠿
                        </span>
                        <button
                          aria-label={`Move ${lane.title} up`}
                          title="Move epic up"
                          disabled={!!epicFilter || epicsBusy || epicIndex <= 0}
                          onClick={() => void moveEpic(lane.epic!.id, orderedEpics[epicIndex - 1]?.id ?? null)}
                        >
                          ↑
                        </button>
                        <button
                          aria-label={`Move ${lane.title} down`}
                          title="Move epic down"
                          disabled={!!epicFilter || epicsBusy || epicIndex < 0 || epicIndex >= orderedEpics.length - 1}
                          onClick={() => void moveEpic(lane.epic!.id, orderedEpics[epicIndex + 2]?.id ?? null)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    {lifecycle === "active" && <button onClick={() => void createTask(lane.id)}>+ Task</button>}
                    {epicInView && (
                      <>
                        <button onClick={() => setHistoryEpic(lane.epic!)}>History</button>
                        {lifecycle === "active" && <button onClick={() => setEpicEditor(lane.epic!)}>Edit</button>}
                        {lane.epic!.trashed_at ? (
                          <button
                            onClick={() =>
                              void api.restorePlannerEpic(lane.epic!.id, lane.epic!.revision).then(
                                () => load(),
                                (e) => setError(errorMessage(e)),
                              )
                            }
                          >
                            Restore
                          </button>
                        ) : lane.epic!.archived_at ? (
                          <>
                            <button
                              onClick={() =>
                                void api.restorePlannerEpic(lane.epic!.id, lane.epic!.revision).then(
                                  () => load(),
                                  (e) => setError(errorMessage(e)),
                                )
                              }
                            >
                              Restore
                            </button>
                            <button onClick={() => void trashEpic(lane.epic!)}>Delete</button>
                          </>
                        ) : (
                          <button onClick={() => void archiveEpic(lane.epic!)}>Archive</button>
                        )}
                      </>
                    )}
                  </header>
                  {!closed && (
                    <div className="board-lane">
                      {PLANNER_STATUSES.map((status) => {
                        const target = `${key}:${status.id}`;
                        return (
                          <div
                            className={`board-column ${dropTarget === target ? "drop-target" : ""}`}
                            key={status.id}
                            aria-label={`${lane.title}: ${status.title}`}
                            onDragOver={(event) => {
                              if (draggedId && event.dataTransfer.types.includes(DRAG_TYPE)) {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                setDropTarget(target);
                              }
                            }}
                            onDragLeave={(event) => {
                              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                                setDropTarget(null);
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const task = tasks.find((item) => item.id === event.dataTransfer.getData(DRAG_TYPE));
                              if (task) void act(task, lane.id, status.id);
                            }}
                          >
                            {lane.tasks
                              .filter((task) => task.status === status.id)
                              .map((task) => (
                                <TaskCard
                                  key={task.id}
                                  task={task}
                                  allTasks={tasks}
                                  hierarchy={hierarchy}
                                  busy={busy.has(task.id)}
                                  selected={selectedId === task.id}
                                  onSelect={setSelectedId}
                                  onToggleDone={(child) =>
                                    void act(child, child.epic_id, child.status === "done" ? "new" : "done")
                                  }
                                  onDropBefore={(target, dragged) => {
                                    const siblings = tasks
                                      .filter(
                                        (item) =>
                                          item.id !== dragged.id &&
                                          item.epic_id === target.epic_id &&
                                          item.parent_id === target.parent_id &&
                                          item.status === target.status,
                                      )
                                      .sort((a, b) => a.position - b.position);
                                    const index = siblings.findIndex((item) => item.id === target.id),
                                      previous = index > 0 ? siblings[index - 1] : null;
                                    const position = previous
                                      ? Math.floor((previous.position + target.position) / 2)
                                      : target.position - 1024;
                                    void act(dragged, target.epic_id, target.status, position);
                                  }}
                                  onDragStart={(event) => {
                                    event.dataTransfer.setData(DRAG_TYPE, task.id);
                                    event.dataTransfer.effectAllowed = "move";
                                    setDraggedId(task.id);
                                  }}
                                />
                              ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
        {lifecycle === "active" && summary && !tasks.length && !loading && (
          <p className="planner-empty">
            No planner tasks yet. Create one or{" "}
            <button onClick={() => void openMigration()}>import Markdown tasks</button>.
          </p>
        )}
        {lifecycle !== "active" && !tasks.length && !epics.length && !loading && (
          <p className="planner-empty">No {lifecycle === "archived" ? "archived" : "deleted"} planner items.</p>
        )}
      </main>
      {selected && (
        <TaskEditor
          task={selected}
          epics={epics}
          tasks={tasks}
          onClose={() => setSelectedId(null)}
          onReload={() => void load()}
          onChanged={(task) => {
            setSelectedId(task?.id ?? null);
            void load();
          }}
        />
      )}
      {epicEditor && (
        <EpicEditor
          epic={epicEditor === "new" ? null : epicEditor}
          defaultColor={DEFAULT_EPIC_COLOR}
          onClose={() => setEpicEditor(null)}
          onDone={() => {
            if (epicEditor === "new") markStarted(root);
            setEpicEditor(null);
            void load();
          }}
        />
      )}
      {historyEpic && (
        <div className="modal-backdrop" onMouseDown={() => setHistoryEpic(null)}>
          <section
            className="modal planner-history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="epic-history-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2 id="epic-history-title">{historyEpic.title} history</h2>
              <button aria-label="Close epic history" onClick={() => setHistoryEpic(null)}>
                ×
              </button>
            </header>
            <ActivityTimeline kind="epic" id={historyEpic.id} revision={historyEpic.revision} defaultOpen />
          </section>
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  allTasks,
  hierarchy,
  busy,
  selected,
  onSelect,
  onToggleDone,
  onDropBefore,
  onDragStart,
}: {
  task: PlannerTask;
  allTasks: PlannerTask[];
  hierarchy: Map<string, PlannerTask[]>;
  busy: boolean;
  selected: boolean;
  onSelect(id: string): void;
  onToggleDone(task: PlannerTask): void;
  onDropBefore(target: PlannerTask, dragged: PlannerTask): void;
  onDragStart(event: DragEvent): void;
}) {
  const nested = descendantsFrom(hierarchy, task.id),
    progress = { done: nested.filter((item) => item.status === "done").length, total: nested.length };
  const historical = !!task.archived_at || !!task.trashed_at;
  return (
    <article
      className={`board-card planner-card ${selected ? "selected" : ""} ${historical ? "archived" : ""}`}
      draggable={!busy && !historical}
      onDragStart={onDragStart}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(DRAG_TYPE)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        const dragged = allTasks.find((item) => item.id === event.dataTransfer.getData(DRAG_TYPE));
        if (dragged && dragged.id !== task.id) onDropBefore(task, dragged);
      }}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button,input")) onSelect(task.id);
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(task.id);
        }
      }}
    >
      <div className="planner-card-title">
        <strong>{task.title}</strong>
        {task.parent_id && <span className="panel-meta">Subtask</span>}
      </div>
      {task.description && <p>{task.description}</p>}
      <div className="planner-card-meta">
        {task.due_date && <span>Due {task.due_date}</span>}
        {task.estimate_minutes !== null && <span>{task.estimate_minutes} min</span>}
        {progress.total > 0 && (
          <span>
            {progress.done}/{progress.total} subtasks
          </span>
        )}
        {task.trashed_at ? <span>Deleted</span> : task.archived_at && <span>Archived</span>}
      </div>
      {nested.length > 0 && (
        <ul className="planner-subtasks">
          {nested.map((child) => (
            <li key={child.id} style={{ paddingLeft: Math.max(0, child.parent_id === task.id ? 0 : 12) }}>
              <input
                type="checkbox"
                checked={child.status === "done"}
                disabled={busy || historical}
                aria-label={`Mark ${child.title} ${child.status === "done" ? "not done" : "done"}`}
                onChange={() => onToggleDone(child)}
              />
              <button onClick={() => onSelect(child.id)}>{child.title}</button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
