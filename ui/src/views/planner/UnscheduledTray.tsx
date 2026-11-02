import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PlannerEpic, PlannerTask } from "../../ipc/types";
import { isCompactCalendarWidth } from "./calendarModel";
import { openTaskGroups, type OpenTaskNode } from "./unscheduledTaskModel";

export type TaskDragPreview = { label: string; color: string; grabOffsetPx: number };
export const TASK_DRAG = "application/x-mosaic-unscheduled-task";
export function UnscheduledTray({
  tasks,
  epics,
  onSchedule,
  onDragPreview,
  designSystem = false,
}: {
  tasks: PlannerTask[];
  epics: PlannerEpic[];
  onSchedule(task: PlannerTask): void;
  onDragPreview?(preview: TaskDragPreview | null): void;
  designSystem?: boolean;
}) {
  const trayRef = useRef<HTMLElement>(null);
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false),
    [compact, setCompact] = useState(false),
    [compactExpanded, setCompactExpanded] = useState(false),
    [search, setSearch] = useState(""),
    [epic, setEpic] = useState("");
  useEffect(() => {
    const container = trayRef.current?.parentElement;
    if (!container || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => setCompact(isCompactCalendarWidth(width));
    update(container.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (compact) setCompactExpanded(false);
  }, [compact]);
  const collapsed = compact ? !compactExpanded : manuallyCollapsed;
  const epicById = useMemo(() => new Map(epics.map((item) => [item.id, item])), [epics]);
  const groups = useMemo(() => openTaskGroups(tasks, epics, search, epic), [tasks, epics, search, epic]);
  const shownCount = groups.reduce((sum, group) => sum + group.count, 0);
  const drag = (event: DragEvent, task: PlannerTask) => {
    event.dataTransfer.setData(TASK_DRAG, task.id);
    event.dataTransfer.effectAllowed = "copy";
    onDragPreview?.({
      label: task.title,
      color: epicById.get(task.epic_id ?? "")?.color ?? "var(--accent)",
      grabOffsetPx: Math.max(0, event.clientY - event.currentTarget.getBoundingClientRect().top),
    });
  };
  const renderTask = (node: OpenTaskNode) => (
    <li key={node.task.id}>
      <div
        className="unscheduled-task-card"
        data-task-id={node.task.id}
        draggable
        onDragStart={(event) => {
          event.stopPropagation();
          drag(event, node.task);
        }}
        onDragEnd={() => onDragPreview?.(null)}
      >
        <button className="mds-button" onClick={() => onSchedule(node.task)}>
          <strong>{node.task.title}</strong>
          <span>
            {node.task.estimate_minutes ? `${node.task.estimate_minutes} min` : "1 hour"}
            {node.task.due_date ? ` · due ${node.task.due_date}` : ""}
          </span>
        </button>
      </div>
      {node.children.length > 0 && (
        <ul className="unscheduled-subtasks" aria-label={`Subtasks of ${node.task.title}`}>
          {node.children.map(renderTask)}
        </ul>
      )}
    </li>
  );
  const toggle = () => (compact ? setCompactExpanded((value) => !value) : setManuallyCollapsed((value) => !value));
  return (
    <aside ref={trayRef} className={`unscheduled-tray ${compact ? "compact" : ""} ${collapsed ? "collapsed" : ""}`}>
      <header>
        <button
          className="mds-button mds-icon-button"
          aria-label={collapsed ? "Show open tasks" : "Hide open tasks"}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {designSystem ? collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} /> : collapsed ? "▸" : "▾"}
        </button>
        <h3>Open tasks</h3>
        <span className="panel-meta">{shownCount}</span>
      </header>
      {!collapsed && (
        <>
          <div className="unscheduled-filters">
            <input
              className="mds-input"
              type="search"
              aria-label="Search open tasks"
              placeholder="Search tasks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              className="mds-input"
              aria-label="Filter open tasks by epic"
              value={epic}
              onChange={(event) => setEpic(event.target.value)}
            >
              <option value="">All epics</option>
              <option value="__none">Unassigned</option>
              {epics.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>
          <div className="unscheduled-groups">
            {groups.map((group) => (
              <section key={group.id}>
                <h4>
                  <i style={{ background: group.color }} />
                  {group.title}
                  <span>{group.count}</span>
                </h4>
                {group.sections.map((status) => (
                  <div
                    className="unscheduled-status"
                    key={status.id}
                    style={{ "--task-color": group.color } as CSSProperties}
                  >
                    <h5>{status.title}</h5>
                    <ul aria-label={`${group.title}: ${status.title}`}>{status.nodes.map(renderTask)}</ul>
                  </div>
                ))}
              </section>
            ))}
          </div>
          {!shownCount && <p className="panel-meta">All tasks are done.</p>}
        </>
      )}
    </aside>
  );
}
