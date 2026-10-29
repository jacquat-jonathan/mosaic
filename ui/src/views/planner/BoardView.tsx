import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { Button, Notice, Select, TextField } from "../../design-system/components";
import {
  BoardCard,
  BoardColumn,
  BoardDropIndicator,
  BoardGrid,
  EpicHeader,
  EpicLane,
  PlannerExportMenu,
} from "../../design-system/planning";
import "../../design-system/planning.css";
import { DesignSystemScope } from "../DesignSystemScope";
import "./boardView.css";
import { api, inTauri, onPlannerChanged } from "../../ipc/api";
import {
  errorMessage,
  type PlannerEpic,
  type PlannerSummary,
  type PlannerTask,
  type PlannerTaskStatus,
} from "../../ipc/types";
import { useUi } from "../../state/ui";
import { useVault } from "../../state/vault";
import { TaskEditor } from "./TaskEditor";
import { EpicEditor, EpicHistoryDialog } from "./EpicEditor";
import { treeAutoScrollStep } from "../treeAutoScroll";
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
export function BoardView() {
  const boardId = useId();
  const root = useVault((state) => state.vault?.root) ?? "";
  const [summary, setSummary] = useState<PlannerSummary | null>(null),
    [epics, setEpics] = useState<PlannerEpic[]>([]),
    [tasks, setTasks] = useState<PlannerTask[]>([]);
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
    [busy, setBusy] = useState(new Set<string>());
  const mounted = useRef(true),
    loadVersion = useRef(0);
  const isCurrent = useCallback(() => mounted.current && root === useVault.getState().vault?.root, [root]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadVersion.current++;
    };
  }, []);
  const epicReturn = useRef<HTMLElement | null>(null),
    historyReturn = useRef<HTMLElement | null>(null);
  const retryFocus = useRef(false),
    boardHeading = useRef<HTMLHeadingElement>(null),
    retryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!loading && retryFocus.current) {
      (error ? retryButton.current : boardHeading.current)?.focus();
      retryFocus.current = false;
    }
  }, [loading, error]);
  const boardScrollRef = useRef<HTMLDivElement>(null),
    epicScrollFrame = useRef<number | null>(null),
    epicScrollStep = useRef(0);
  const stopEpicAutoScroll = () => {
    epicScrollStep.current = 0;
    if (epicScrollFrame.current !== null) cancelAnimationFrame(epicScrollFrame.current);
    epicScrollFrame.current = null;
  };
  const epicAutoScrollFrame = () => {
    epicScrollFrame.current = null;
    const board = boardScrollRef.current,
      step = epicScrollStep.current;
    if (!board || step === 0) return;
    const before = board.scrollTop;
    board.scrollTop += step;
    if (board.scrollTop === before) return;
    epicScrollFrame.current = requestAnimationFrame(epicAutoScrollFrame);
  };
  const updateEpicAutoScroll = (clientY: number) => {
    const board = boardScrollRef.current;
    if (!board) return;
    const bounds = board.getBoundingClientRect();
    epicScrollStep.current = treeAutoScrollStep(clientY, bounds.top, bounds.bottom);
    if (epicScrollStep.current === 0) return stopEpicAutoScroll();
    if (epicScrollFrame.current === null) epicScrollFrame.current = requestAnimationFrame(epicAutoScrollFrame);
  };
  useEffect(
    () => () => {
      epicScrollStep.current = 0;
      if (epicScrollFrame.current !== null) cancelAnimationFrame(epicScrollFrame.current);
      epicScrollFrame.current = null;
    },
    [],
  );
  const load = useCallback(async () => {
    if (!root || !isCurrent()) return;
    const version = ++loadVersion.current;
    const valid = () => isCurrent() && version === loadVersion.current;
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
      if (!valid()) return;
      setSummary(nextSummary);
      setEpics(nextEpics);
      setTasks(nextTasks);
      setSelectedId((current) => (nextTasks.some((item) => item.id === current) ? current : null));
      setError(null);
    } catch (e) {
      if (valid()) setError(errorMessage(e));
    } finally {
      if (valid()) setLoading(false);
    }
  }, [root, lifecycle, isCurrent]);
  useEffect(() => {
    setSelectedId(null);
    void load();
  }, [load]);
  useEffect(() => {
    let off: (() => void) | undefined;
    let live = true;
    void onPlannerChanged((change) => {
      if (change.root === root) void load();
    }).then((unsubscribe) => {
      if (live) off = unsubscribe;
      else unsubscribe();
    });
    return () => {
      live = false;
      off?.();
    };
  }, [root, load]);
  const focusTask = (id: string) =>
    requestAnimationFrame(() => {
      const target = [...(boardScrollRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find(
        (element) => element.dataset.taskId === id,
      );
      (target ?? boardHeading.current)?.focus();
    });
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
    if (!isCurrent() || lifecycle !== "active" || epicFilter || epicsBusy) return;
    const next = reorderEpics(epics, movedId, beforeId),
      changed = next.filter((item) => epics.find((epic) => epic.id === item.id)?.position !== item.position);
    if (!changed.length) return;
    setEpicsBusy(true);
    setError(null);
    try {
      for (const epic of changed) {
        if (!isCurrent()) return;
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
    if (!isCurrent()) return null;
    if (!future.length) return "cancel" as const;
    if (
      await useUi.getState().ask({
        title: "Cancel future work sessions?",
        body: `${future.length} future session${future.length === 1 ? "" : "s"} can be cancelled now.`,
        confirmLabel: "Cancel sessions",
      })
    )
      return "cancel" as const;
    if (!isCurrent()) return null;
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
    if (!isCurrent() || busy.has(task.id) || task.archived_at) return;
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
      if (!mounted.current || root !== useVault.getState().vault?.root) return;
      if (
        current.epic_id !== epicId ||
        (status !== "done" && current.status !== status) ||
        requestedPosition !== undefined
      )
        current = await api.movePlannerTask(current.id, {
          expected_revision: current.revision,
          epic_id: epicId,
          parent_id: current.parent_id,
          status: status === "done" ? current.status : status,
          position,
        });
      if (!mounted.current || root !== useVault.getState().vault?.root) return;
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
        if (!mounted.current || root !== useVault.getState().vault?.root) return;
        const policy = await futurePolicy(current.id);
        if (!policy || !mounted.current || root !== useVault.getState().vault?.root) return;
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
    const epicTitle = epics.find((item) => item.id === epicId)?.title;
    const title = await useUi.getState().askText({
      title: epicTitle ? `New task in ${epicTitle}` : "New task",
      value: "",
      placeholder: "What needs doing?",
    });
    if (!title?.trim() || !isCurrent()) return;
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
      if (!isCurrent()) return;
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(epicId ?? "__unassigned");
        return next;
      });
      setSearch("");
      setStatusFilter("");
      setEpicFilter("");
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
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      await api.trashPlannerEpic(epic.id, epic.revision);
      await load();
    } catch (e) {
      setError(errorMessage(e));
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
        if (path && isCurrent()) await api.exportPlannerFile(format, path);
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
  return (
    <div className={`workspace-page planner-board-page ${selected ? "with-editor" : ""}`}>
      <DesignSystemScope
        id={boardId}
        as="main"
        className="planner-board board-design"
        aria-label="Task board"
        aria-busy={loading}
      >
        <header className="board-header">
          <div className="board-toolbar">
            <h1 ref={boardHeading} tabIndex={-1}>
              Board
            </h1>
            <div className="board-actions" role="group" aria-label="Board actions">
              {lifecycle === "active" && (
                <>
                  <Button variant="secondary" onClick={() => void createTask(null)}>
                    New task
                  </Button>
                  <Button
                    onClick={(event) => {
                      epicReturn.current = event.currentTarget;
                      setEpicEditor("new");
                    }}
                  >
                    New epic
                  </Button>
                </>
              )}
              <PlannerExportMenu label="Export" onExport={(format) => void exportPlan(format)} />
            </div>
          </div>
          <div className="board-filters" role="group" aria-label="Board filters">
            <TextField
              label="Search planner tasks"
              type="search"
              aria-label="Search planner tasks"
              placeholder="Search tasks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select label="Filter by epic" value={epicFilter} onChange={(event) => setEpicFilter(event.target.value)}>
              <option value="">All epics</option>
              {epics.map((epic) => (
                <option value={epic.id} key={epic.id}>
                  {epic.title}
                </option>
              ))}
              <option value="__unassigned">Unassigned</option>
            </Select>
            <Select
              label="Filter by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as PlannerTaskStatus | "")}
            >
              <option value="">All statuses</option>
              {PLANNER_STATUSES.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
            </Select>
            <Select
              label="Planner lifecycle view"
              title="Deleted items remain recoverable and can be restored."
              value={lifecycle}
              onChange={(event) => setLifecycle(event.target.value as typeof lifecycle)}
            >
              <option value="active">Active</option>
              <option value="archived">Archive</option>
              <option value="trash">Deleted</option>
            </Select>
          </div>
        </header>
        {error && (
          <Notice tone="error">
            {error}
            <Button
              ref={retryButton}
              variant="secondary"
              onClick={() => {
                retryFocus.current = true;
                void load();
              }}
            >
              Retry
            </Button>
          </Notice>
        )}
        {loading && !summary && (
          <p className="mds-hint" role="status">
            Loading planner…
          </p>
        )}
        <div
          ref={boardScrollRef}
          className="board-scroll"
          role="region"
          aria-label="Board lanes"
          tabIndex={0}
          onDragOverCapture={(event) => {
            if (draggedEpicId && event.dataTransfer.types.includes(EPIC_DRAG_TYPE)) updateEpicAutoScroll(event.clientY);
            else stopEpicAutoScroll();
          }}
          onDragLeaveCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopEpicAutoScroll();
          }}
          onDropCapture={stopEpicAutoScroll}
          onDragEnd={stopEpicAutoScroll}
        >
          <div className="board-grid planner-grid">
            {lanes.map((lane, laneIndex) => {
              const key = lane.id ?? "__unassigned",
                closed = collapsed.has(key),
                orderedEpics = [...epics].sort((a, b) => a.position - b.position),
                epicIndex = lane.id ? orderedEpics.findIndex((item) => item.id === lane.id) : -1,
                nextLaneId = lanes[laneIndex + 1]?.id ?? null,
                epicInView =
                  lane.epic &&
                  (lifecycle === "active"
                    ? !lane.epic.archived_at && !lane.epic.trashed_at
                    : lifecycle === "archived"
                      ? !!lane.epic.archived_at && !lane.epic.trashed_at
                      : !!lane.epic.trashed_at);
              return (
                <EpicLane
                  key={key}
                  title={lane.title}
                  draggable={lifecycle === "active" && !!lane.epic && !epicFilter && !epicsBusy}
                  dragging={!!draggedEpicId && draggedEpicId === lane.id}
                  dropPosition={
                    epicDropTarget === lane.id
                      ? "before"
                      : epicDropTarget === nextLaneId && draggedEpicId !== lane.id
                        ? "after"
                        : undefined
                  }
                  onDragStart={(event) => {
                    if (!lane.epic) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(EPIC_DRAG_TYPE, lane.epic.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDraggedEpicId(lane.epic.id);
                  }}
                  onDragEnd={() => {
                    setDraggedEpicId(null);
                    setEpicDropTarget(undefined);
                  }}
                  onDragOver={(event) => {
                    if (draggedEpicId && event.dataTransfer.types.includes(EPIC_DRAG_TYPE)) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setEpicDropTarget(event.clientY < bounds.top + bounds.height / 2 ? lane.id : nextLaneId);
                    }
                  }}
                  onDrop={(event) => {
                    const movedId = event.dataTransfer.getData(EPIC_DRAG_TYPE);
                    if (!movedId) return;
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect(),
                      beforeId = event.clientY < bounds.top + bounds.height / 2 ? lane.id : nextLaneId;
                    void moveEpic(movedId, beforeId);
                  }}
                >
                  <EpicHeader
                    title={lane.title}
                    count={lane.tasks.length}
                    color={lane.color ?? "var(--mds-border)"}
                    headingLevel={2}
                    expanded={!closed}
                    onExpandedChange={(expanded) =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (expanded) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                    onCreateTask={lifecycle === "active" ? () => void createTask(lane.id) : undefined}
                    reorderDisabled={!!epicFilter || epicsBusy}
                    onMoveUp={
                      lifecycle === "active" && lane.epic && epicIndex > 0
                        ? () => void moveEpic(lane.epic!.id, orderedEpics[epicIndex - 1]?.id ?? null)
                        : undefined
                    }
                    onMoveDown={
                      lifecycle === "active" && lane.epic && epicIndex < orderedEpics.length - 1
                        ? () => void moveEpic(lane.epic!.id, orderedEpics[epicIndex + 2]?.id ?? null)
                        : undefined
                    }
                    actions={
                      epicInView ? (
                        <>
                          <Button
                            onClick={(event) => {
                              historyReturn.current = event.currentTarget;
                              setHistoryEpic(lane.epic!);
                            }}
                          >
                            History
                          </Button>
                          {lifecycle === "active" && (
                            <Button
                              onClick={(event) => {
                                epicReturn.current = event.currentTarget;
                                setEpicEditor(lane.epic!);
                              }}
                            >
                              Edit
                            </Button>
                          )}
                          {lane.epic!.trashed_at ? (
                            <Button
                              onClick={() =>
                                void api.restorePlannerEpic(lane.epic!.id, lane.epic!.revision).then(
                                  () => load(),
                                  (e) => setError(errorMessage(e)),
                                )
                              }
                            >
                              Restore
                            </Button>
                          ) : lane.epic!.archived_at ? (
                            <>
                              <Button
                                onClick={() =>
                                  void api.restorePlannerEpic(lane.epic!.id, lane.epic!.revision).then(
                                    () => load(),
                                    (e) => setError(errorMessage(e)),
                                  )
                                }
                              >
                                Restore
                              </Button>
                              <Button onClick={() => void trashEpic(lane.epic!)}>Delete</Button>
                            </>
                          ) : (
                            <Button onClick={() => void archiveEpic(lane.epic!)}>Archive</Button>
                          )}
                        </>
                      ) : undefined
                    }
                  />
                  {!closed && (
                    <BoardGrid label={`${lane.title} tasks`}>
                      {PLANNER_STATUSES.map((status) => {
                        const target = `${key}:${status.id}`;
                        return (
                          <BoardColumn
                            key={status.id}
                            title={status.title}
                            label={`${lane.title}: ${status.title}`}
                            headingLevel={3}
                            count={lane.tasks.filter((task) => task.status === status.id).length}
                            dropTarget={dropTarget === target}
                            onDragOver={(event) => {
                              if (lifecycle === "active" && draggedId && event.dataTransfer.types.includes(DRAG_TYPE)) {
                                event.preventDefault();
                                event.stopPropagation();
                                event.dataTransfer.dropEffect = "move";
                                setDropTarget(target);
                              }
                            }}
                            onDragLeave={(event) => {
                              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                                setDropTarget(null);
                            }}
                            onDrop={(event) => {
                              if (lifecycle !== "active" || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
                              event.preventDefault();
                              event.stopPropagation();
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
                                  readOnly={lifecycle !== "active"}
                                  dragging={draggedId === task.id}
                                  onDragEnd={() => {
                                    setDraggedId(null);
                                    setDropTarget(null);
                                  }}
                                  onMoveStatus={(nextStatus) => void act(task, task.epic_id, nextStatus)}
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
                            {!lane.tasks.some((task) => task.status === status.id) && (
                              <BoardDropIndicator
                                active={dropTarget === target}
                                label={dropTarget === target ? "Drop task here" : "No tasks"}
                              />
                            )}
                          </BoardColumn>
                        );
                      })}
                    </BoardGrid>
                  )}
                </EpicLane>
              );
            })}
          </div>
        </div>
        {lifecycle === "active" && summary && !tasks.length && !loading && (
          <p className="planner-empty">No planner tasks yet. Use New task or add one inside an epic.</p>
        )}
        {lifecycle !== "active" && !tasks.length && !epics.length && !loading && (
          <p className="planner-empty">No {lifecycle === "archived" ? "archived" : "deleted"} planner items.</p>
        )}
      </DesignSystemScope>
      {selected && (
        <TaskEditor
          key={`${root}/${selected.id}`}
          task={selected}
          epics={epics}
          tasks={tasks}
          onClose={() => {
            setSelectedId(null);
            focusTask(selected.id);
          }}
          onReload={() => void load()}
          onChanged={(task) => {
            setSelectedId(task?.id ?? null);
            if (!task) focusTask("");
            void load();
          }}
        />
      )}
      {epicEditor && (
        <EpicEditor
          key={epicEditor === "new" ? "new" : epicEditor.id}
          returnFocusRef={epicReturn}
          epic={epicEditor === "new" ? null : epicEditor}
          defaultColor={DEFAULT_EPIC_COLOR}
          onClose={() => setEpicEditor(null)}
          onDone={() => {
            setEpicEditor(null);
            void load();
          }}
        />
      )}
      {historyEpic && (
        <EpicHistoryDialog epic={historyEpic} onClose={() => setHistoryEpic(null)} returnFocusRef={historyReturn} />
      )}
    </div>
  );
}

function TaskCard({
  task,
  allTasks,
  hierarchy,
  busy,
  readOnly,
  dragging,
  selected,
  onSelect,
  onToggleDone,
  onDropBefore,
  onDragStart,
  onDragEnd,
  onMoveStatus,
}: {
  task: PlannerTask;
  allTasks: PlannerTask[];
  hierarchy: Map<string, PlannerTask[]>;
  busy: boolean;
  readOnly: boolean;
  dragging: boolean;
  selected: boolean;
  onSelect(id: string): void;
  onToggleDone(task: PlannerTask): void;
  onDropBefore(target: PlannerTask, dragged: PlannerTask): void;
  onDragStart(event: DragEvent): void;
  onDragEnd(): void;
  onMoveStatus(status: PlannerTaskStatus): void;
}) {
  const nested = descendantsFrom(hierarchy, task.id),
    progress = { done: nested.filter((item) => item.status === "done").length, total: nested.length };
  const historical = readOnly || !!task.archived_at || !!task.trashed_at;
  return (
    <BoardCard
      title={task.title}
      description={task.description || undefined}
      selected={selected}
      disabled={busy}
      draggable={!busy && !historical}
      dragging={dragging}
      onOpen={() => onSelect(task.id)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!historical && event.dataTransfer.types.includes(DRAG_TYPE)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        if (historical || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        const dragged = allTasks.find((item) => item.id === event.dataTransfer.getData(DRAG_TYPE));
        if (dragged && dragged.id !== task.id) onDropBefore(task, dragged);
      }}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button,input")) onSelect(task.id);
      }}
      data-task-id={task.id}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect(task.id);
        }
        if (
          !historical &&
          !busy &&
          event.altKey &&
          ["ArrowLeft", "ArrowRight"].includes(event.key) &&
          (event.target === event.currentTarget || (event.target as HTMLElement).closest(".mds-board-card-title"))
        ) {
          event.preventDefault();
          event.stopPropagation();
          const index = PLANNER_STATUSES.findIndex((status) => status.id === task.status);
          const next = PLANNER_STATUSES[index + (event.key === "ArrowLeft" ? -1 : 1)];
          if (next) onMoveStatus(next.id);
        }
      }}
      metadata={
        task.due_date || task.estimate_minutes !== null || progress.total > 0 || historical ? (
          <div className="board-task-metadata">
            {task.due_date && <span>Due {task.due_date}</span>}
            {task.estimate_minutes !== null && <span>{task.estimate_minutes} min</span>}
            {progress.total > 0 && (
              <span>
                {progress.done}/{progress.total} subtasks
              </span>
            )}
            {task.trashed_at ? <span>Deleted</span> : historical && <span>Archived</span>}
          </div>
        ) : undefined
      }
    >
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
              <Button data-task-id={child.id} onClick={() => onSelect(child.id)}>
                {child.title}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </BoardCard>
  );
}
