import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PlannerEpic, PlannerTask } from "../../ipc/types";
import { isCompactCalendarWidth } from "./calendarModel";

export const TASK_DRAG = "application/x-mosaic-unscheduled-task";
export function UnscheduledTray({
  tasks,
  epics,
  onSchedule,
  designSystem = false,
}: {
  tasks: PlannerTask[];
  epics: PlannerEpic[];
  onSchedule(task: PlannerTask): void;
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
  const shown = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.status !== "done" &&
          !task.archived_at &&
          !task.trashed_at &&
          (!epic || (epic === "__none" ? !task.epic_id : task.epic_id === epic)) &&
          (!search.trim() ||
            `${epicById.get(task.epic_id ?? "")?.title ?? "Unassigned"} ${task.title}`
              .toLowerCase()
              .includes(search.trim().toLowerCase())),
      ),
    [tasks, epic, search, epicById],
  );
  const groups = useMemo(() => {
    const byEpic = new Map<string, PlannerTask[]>();
    for (const task of shown) {
      const key = task.epic_id ?? "__none";
      byEpic.set(key, [...(byEpic.get(key) ?? []), task]);
    }
    return [...byEpic]
      .sort(([left], [right]) => {
        if (left === "__none") return 1;
        if (right === "__none") return -1;
        return (epicById.get(left)?.title ?? "").localeCompare(epicById.get(right)?.title ?? "");
      })
      .map(([id, items]) => ({
        id,
        title: epicById.get(id)?.title ?? "Unassigned",
        color: epicById.get(id)?.color ?? "var(--accent)",
        tasks: items,
      }));
  }, [shown, epicById]);
  const drag = (event: DragEvent, task: PlannerTask) => {
    event.dataTransfer.setData(TASK_DRAG, task.id);
    event.dataTransfer.effectAllowed = "copy";
  };
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
        <span className="panel-meta">{shown.length}</span>
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
                  <span>{group.tasks.length}</span>
                </h4>
                <ul>
                  {group.tasks.map((task) => (
                    <li
                      key={task.id}
                      draggable
                      onDragStart={(event) => drag(event, task)}
                      style={{ "--task-color": group.color } as CSSProperties}
                    >
                      <button className="mds-button" onClick={() => onSchedule(task)}>
                        <strong>{task.title}</strong>
                        <span>
                          {task.estimate_minutes ? `${task.estimate_minutes} min` : "1 hour"}
                          {task.due_date ? ` · due ${task.due_date}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {!shown.length && <p className="panel-meta">All tasks are done.</p>}
        </>
      )}
    </aside>
  );
}
