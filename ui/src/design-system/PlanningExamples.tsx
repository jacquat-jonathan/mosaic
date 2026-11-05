import { useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Dialog, IconButton, Notice, SegmentedControl, Select, TextField, Toolbar } from "./components";
import {
  BoardCard,
  BoardColumn,
  BoardDropIndicator,
  BoardGrid,
  CalendarChip,
  CalendarChooser,
  CalendarDay,
  CalendarGrid,
  CalendarSessionMenu,
  EpicHeader,
  EpicLane,
  PlannerExportMenu,
  TaskTray,
  TaskTrayGroup,
  TaskTrayItem,
  type CalendarLayer,
} from "./planning";

const statuses = ["New", "Ready", "In progress", "Blocked", "Done"] as const;
type SampleTask = { id: string; epic: string; title: string; description: string; status: number; minutes: number };
const sampleTasks: SampleTask[] = [
  {
    id: "release",
    epic: "Release",
    title: "Prepare Mosaic release",
    description: "Review the notes and prepare the release checklist.",
    status: 2,
    minutes: 60,
  },
  {
    id: "notes",
    epic: "Release",
    title: "Write release notes",
    description: "Summarize the changes for the team.",
    status: 1,
    minutes: 30,
  },
  {
    id: "review",
    epic: "Release",
    title: "Review the final build",
    description: "Waiting for the release candidate.",
    status: 3,
    minutes: 45,
  },
  {
    id: "research",
    epic: "Research",
    title: "Collect planning feedback",
    description: "Gather observations from the latest planning session.",
    status: 0,
    minutes: 30,
  },
  {
    id: "archive",
    epic: "Research",
    title: "Archive previous findings",
    description: "Keep the source notes linked for future reference.",
    status: 4,
    minutes: 15,
  },
];

export function BoardExample({ onAnnounce }: { onAnnounce(message: string): void }) {
  const [tasks, setTasks] = useState(sampleTasks);
  const [epics, setEpics] = useState(["Release", "Research"]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState(false);
  const [subtaskDone, setSubtaskDone] = useState(false);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const taskInput = useRef<HTMLInputElement>(null);
  const createReturn = useRef<HTMLElement | null>(null);
  const taskSequence = useRef(0);
  const taskForm = useId();
  const [draggedEpic, setDraggedEpic] = useState<string | null>(null);
  const [epicDrop, setEpicDrop] = useState<{ title: string; position: "before" | "after" } | null>(null);
  const epicDragType = "application/x-mosaic-design-system-epic";
  const taskDragType = "application/x-mosaic-design-system-task";
  const [draggedTask, setDraggedTask] = useState<string | null>(null);
  const [taskDrop, setTaskDrop] = useState<{ epic: string; status: number } | null>(null);
  const cardId = (id: string) => `${taskForm}-card-${id}`;
  const addTask = () => {
    if (!creatingIn || !taskTitle.trim()) return;
    const id = `preview-task-${++taskSequence.current}`;
    setTasks((current) => [
      ...current,
      { id, epic: creatingIn, title: taskTitle.trim(), description: "", status: 0, minutes: 30 },
    ]);
    setCollapsed((current) => current.filter((title) => title !== creatingIn));
    setSearch("");
    setStatus("");
    setSelected(id);
    setCreatingIn(null);
    onAnnounce(`Created ${taskTitle.trim()} in ${creatingIn}.`);
  };
  const shown = tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(search.trim().toLowerCase()) && (!status || String(task.status) === status),
  );
  const moveTask = (id: string, epic: string, value: number) => {
    const task = tasks.find((item) => item.id === id);
    if (!task || (task.epic === epic && task.status === value)) return;
    setTasks((current) => current.map((item) => (item.id === id ? { ...item, epic, status: value } : item)));
    setSelected(id);
    setStatus("");
    requestAnimationFrame(() =>
      document.getElementById(cardId(id))?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
    onAnnounce(`${task.title} moved to ${statuses[value]} in ${epic}.`);
  };
  return (
    <div className="ds-planning-example" data-density={density}>
      <div className="ds-planning-demo-controls">
        <SegmentedControl<"comfortable" | "compact">
          label="Board preview density"
          value={density}
          onChange={setDensity}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
        <Button onClick={() => setDropPreview(!dropPreview)} aria-pressed={dropPreview}>
          Show drop target
        </Button>
        <Button
          onClick={() => {
            setTasks(sampleTasks);
            setEpics(["Release", "Research"]);
            setCollapsed([]);
            setSelected(null);
            setSearch("");
            setStatus("");
            setDropPreview(false);
            setSubtaskDone(false);
            setDraggedTask(null);
            setTaskDrop(null);
            onAnnounce("Board preview reset.");
          }}
        >
          Reset board preview
        </Button>
      </div>
      <div className="mds-planning-preview" data-density={density}>
        <Toolbar label="Board preview controls">
          <TextField
            label="Search board tasks"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select label="Board status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            {statuses.map((title, index) => (
              <option key={title} value={index}>
                {title}
              </option>
            ))}
          </Select>
          <PlannerExportMenu
            onExport={(format) => onAnnounce(`${format.toUpperCase()} export selected in the board preview.`)}
          />
        </Toolbar>
        {selected && (
          <Notice>
            Selected: {tasks.find((task) => task.id === selected)?.title}. Drag the card to another column to change its
            status.
          </Notice>
        )}
        {epics.map((epic, epicIndex) => {
          const expanded = !collapsed.includes(epic);
          const reorder = (direction: number) => {
            setEpics((current) => {
              const next = [...current];
              [next[epicIndex], next[epicIndex + direction]] = [next[epicIndex + direction], next[epicIndex]];
              return next;
            });
            onAnnounce(`${epic} moved ${direction < 0 ? "up" : "down"}.`);
          };
          return (
            <EpicLane
              key={epic}
              title={epic}
              draggable
              dragging={draggedEpic === epic}
              dropPosition={epicDrop?.title === epic ? epicDrop.position : undefined}
              onDragStart={(event) => {
                event.dataTransfer.setData(epicDragType, epic);
                event.dataTransfer.effectAllowed = "move";
                setDraggedEpic(epic);
              }}
              onDragEnd={() => {
                setDraggedEpic(null);
                setEpicDrop(null);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(epicDragType) || draggedEpic === epic) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const bounds = event.currentTarget.getBoundingClientRect();
                setEpicDrop({
                  title: epic,
                  position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
                });
              }}
              onDrop={(event) => {
                const source = event.dataTransfer.getData(epicDragType);
                if (!epics.includes(source) || source === epic) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                const after = event.clientY >= bounds.top + bounds.height / 2;
                setEpics((current) => {
                  const next = current.filter((title) => title !== source);
                  next.splice(next.indexOf(epic) + (after ? 1 : 0), 0, source);
                  return next;
                });
                setDraggedEpic(null);
                setEpicDrop(null);
                onAnnounce(`${source} moved ${after ? "after" : "before"} ${epic}.`);
              }}
            >
              <EpicHeader
                title={epic}
                count={shown.filter((task) => task.epic === epic).length}
                color={epic === "Release" ? "var(--mds-accent)" : "var(--mds-success)"}
                expanded={expanded}
                onExpandedChange={(next) =>
                  setCollapsed((current) => (next ? current.filter((name) => name !== epic) : [...current, epic]))
                }
                onMoveUp={epicIndex > 0 ? () => reorder(-1) : undefined}
                onMoveDown={epicIndex < epics.length - 1 ? () => reorder(1) : undefined}
                onCreateTask={() => {
                  createReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setTaskTitle("");
                  setCreatingIn(epic);
                }}
              />
              {expanded && (
                <BoardGrid label={`${epic} board columns`}>
                  {statuses.map((title, index) => {
                    const columnTasks = shown.filter((task) => task.epic === epic && task.status === index);
                    return (
                      <BoardColumn
                        key={title}
                        title={title}
                        count={columnTasks.length}
                        dropTarget={
                          (dropPreview && index === 0) || (taskDrop?.epic === epic && taskDrop.status === index)
                        }
                        onDragOver={(event) => {
                          if (!event.dataTransfer.types.includes(taskDragType)) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = "move";
                          setTaskDrop({ epic, status: index });
                        }}
                        onDragLeave={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTaskDrop(null);
                        }}
                        onDrop={(event) => {
                          if (!event.dataTransfer.types.includes(taskDragType)) return;
                          event.preventDefault();
                          event.stopPropagation();
                          moveTask(event.dataTransfer.getData(taskDragType), epic, index);
                          setDraggedTask(null);
                          setTaskDrop(null);
                        }}
                      >
                        {columnTasks.map((task) => (
                          <BoardCard
                            key={task.id}
                            id={cardId(task.id)}
                            title={task.title}
                            description={task.description}
                            selected={selected === task.id}
                            onOpen={() => {
                              setSelected(task.id);
                              onAnnounce(`Selected ${task.title}.`);
                            }}
                            metadata={`${task.minutes} min`}
                            draggable
                            dragging={draggedTask === task.id}
                            onDragStart={(event) => {
                              event.dataTransfer.setData(taskDragType, task.id);
                              event.dataTransfer.effectAllowed = "move";
                              setDraggedTask(task.id);
                            }}
                            onDragEnd={() => {
                              setDraggedTask(null);
                              setTaskDrop(null);
                            }}
                            onKeyDown={(event) => {
                              if (
                                !event.altKey ||
                                !["ArrowLeft", "ArrowRight"].includes(event.key) ||
                                !(event.target as HTMLElement).closest(".mds-board-card-title")
                              )
                                return;
                              event.preventDefault();
                              event.stopPropagation();
                              const next = task.status + (event.key === "ArrowLeft" ? -1 : 1);
                              if (next >= 0 && next < statuses.length) moveTask(task.id, epic, next);
                            }}
                          >
                            {task.id === "release" && (
                              <label className="ds-planning-check">
                                <input
                                  type="checkbox"
                                  checked={subtaskDone}
                                  onChange={(event) => setSubtaskDone(event.target.checked)}
                                />
                                Review checklist {subtaskDone ? "1/1" : "0/1"}
                              </label>
                            )}
                          </BoardCard>
                        ))}
                        {!columnTasks.length && (
                          <BoardDropIndicator
                            active={
                              (dropPreview && index === 0) || (taskDrop?.epic === epic && taskDrop.status === index)
                            }
                            label={
                              (dropPreview && index === 0) || (taskDrop?.epic === epic && taskDrop.status === index)
                                ? "Drop task here"
                                : "No tasks"
                            }
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
      <p className="ds-caption">
        Use + Task to create within an epic. Drag cards between columns to change their status, or focus a card title
        and press Alt+Left/Right. Drag an epic’s header or background to reorder it. All changes stay in this preview.
      </p>
      <Dialog
        open={creatingIn !== null}
        title={`New task in ${creatingIn ?? "epic"}`}
        description="The new task will be added to this epic in the preview."
        onClose={() => setCreatingIn(null)}
        initialFocusRef={taskInput}
        returnFocusRef={createReturn}
        actions={
          <>
            <Button onClick={() => setCreatingIn(null)}>Cancel</Button>
            <Button variant="secondary" type="submit" form={taskForm} disabled={!taskTitle.trim()}>
              Add task
            </Button>
          </>
        }
      >
        <form
          id={taskForm}
          onSubmit={(event) => {
            event.preventDefault();
            addTask();
          }}
        >
          <TextField
            ref={taskInput}
            label="Task title"
            value={taskTitle}
            onChange={(event) => setTaskTitle(event.target.value)}
          />
        </form>
      </Dialog>
    </div>
  );
}

type CalendarMode = "month" | "week" | "day";
type SampleEvent = {
  id: string;
  day: string;
  title: string;
  time: string;
  kind: "event" | "session" | "due";
  layer: string;
  taskId?: string;
};
const initialEvents: SampleEvent[] = [
  { id: "planning", day: "2026-10-29", title: "Release planning", time: "09:00–09:30", kind: "event", layer: "events" },
  {
    id: "writing",
    taskId: "notes",
    day: "2026-10-29",
    title: "Write release notes",
    time: "10:00–10:30",
    kind: "session",
    layer: "sessions",
  },
  { id: "deadline", day: "2026-10-30", title: "Release checklist", time: "All day", kind: "due", layer: "due" },
  { id: "team", day: "2026-10-28", title: "Team calendar", time: "14:00–15:00", kind: "event", layer: "team" },
];
const initialLayers: CalendarLayer[] = [
  { id: "events", label: "Local events", visible: true },
  { id: "sessions", label: "Work sessions", visible: true, color: "var(--mds-success)" },
  { id: "due", label: "Due dates", visible: true, color: "var(--mds-danger)" },
  { id: "team", label: "Team calendar", visible: true, readOnly: true, color: "var(--mds-review)" },
];
const iso = (date: Date) => date.toISOString().slice(0, 10);
const atDay = (day: string) => new Date(`${day}T12:00:00Z`);
const addDays = (day: string, amount: number) => {
  const date = atDay(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return iso(date);
};
const dateLabel = (day: string, options: Intl.DateTimeFormatOptions) =>
  atDay(day).toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });

export function CalendarExample({ onAnnounce }: { onAnnounce(message: string): void }) {
  const [mode, setMode] = useState<CalendarMode>("week");
  const [anchor, setAnchor] = useState("2026-10-29");
  const [events, setEvents] = useState(initialEvents);
  const [layers, setLayers] = useState(initialLayers);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [epic, setEpic] = useState("");
  const [scheduled, setScheduled] = useState<string[]>(["notes"]);
  const calendarFocus = useRef<HTMLButtonElement>(null);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const days = useMemo(() => {
    if (mode === "day") return [anchor];
    const date = atDay(anchor);
    if (mode === "week") {
      const monday = addDays(anchor, -((date.getUTCDay() + 6) % 7));
      return Array.from({ length: 5 }, (_, index) => addDays(monday, index));
    }
    const first = `${anchor.slice(0, 7)}-01`;
    const start = addDays(first, -((atDay(first).getUTCDay() + 6) % 7));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const cells = Math.ceil((((atDay(first).getUTCDay() + 6) % 7) + end) / 7) * 7;
    return Array.from({ length: cells }, (_, index) => addDays(start, index));
  }, [anchor, mode]);
  const openTasks = sampleTasks.filter(
    (task) =>
      task.status !== 4 &&
      !scheduled.includes(task.id) &&
      (!epic || task.epic === epic) &&
      task.title.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const selectedEvent = events.find((event) => event.id === selected);
  const step = (direction: number) => {
    if (mode !== "month") setAnchor(addDays(anchor, direction * (mode === "week" ? 7 : 1)));
    else {
      const date = atDay(`${anchor.slice(0, 7)}-01`);
      date.setUTCMonth(date.getUTCMonth() + direction);
      setAnchor(iso(date));
    }
    setSelected(null);
  };
  const schedule = (task: SampleTask) => {
    setScheduled((current) => [...current, task.id]);
    setEvents((current) => [
      ...current,
      {
        id: `task-${task.id}`,
        taskId: task.id,
        day: anchor,
        title: task.title,
        time: "11:00–12:00",
        kind: "session",
        layer: "sessions",
      },
    ]);
    setLayers((current) => current.map((layer) => (layer.id === "sessions" ? { ...layer, visible: true } : layer)));
    onAnnounce(`Scheduled ${task.title} on ${anchor} in the preview.`);
  };
  return (
    <div className="ds-planning-example">
      <div className="ds-planning-demo-controls">
        <SegmentedControl<"comfortable" | "compact">
          label="Calendar preview density"
          value={density}
          onChange={setDensity}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
        <Button
          onClick={() => {
            setEvents(initialEvents);
            setLayers(initialLayers);
            setSelected(null);
            setScheduled(["notes"]);
            setAnchor("2026-10-29");
            setMode("week");
            setCollapsed(false);
            setSearch("");
            setEpic("");
            onAnnounce("Calendar preview reset.");
          }}
        >
          Reset calendar preview
        </Button>
      </div>
      <div className="mds-planning-preview" data-density={density}>
        <Toolbar label="Calendar preview controls">
          <IconButton label="Previous preview period" onClick={() => step(-1)}>
            <ChevronLeft />
          </IconButton>
          <IconButton label="Next preview period" onClick={() => step(1)}>
            <ChevronRight />
          </IconButton>
          <Button ref={calendarFocus} onClick={() => setAnchor("2026-10-29")}>
            Today
          </Button>
          <strong>{dateLabel(anchor, { month: "long", year: "numeric" })}</strong>
          <CalendarChooser
            layers={layers}
            onVisibilityChange={(id, visible) =>
              setLayers((current) => current.map((layer) => (layer.id === id ? { ...layer, visible } : layer)))
            }
            actions={
              <Button onClick={() => onAnnounce("Subscription management selected in the preview.")}>
                Manage subscriptions…
              </Button>
            }
          />
          <SegmentedControl<CalendarMode>
            label="Calendar preview view"
            value={mode}
            onChange={setMode}
            options={[
              { value: "month", label: "Month" },
              { value: "week", label: "Week" },
              { value: "day", label: "Day" },
            ]}
          />
        </Toolbar>
        <div className="ds-calendar-preview-layout">
          <div className="ds-calendar-preview-main">
            <CalendarGrid label={`${mode} calendar preview`} columns={mode === "month" ? 7 : mode === "week" ? 5 : 1}>
              {days.map((day) => (
                <CalendarDay
                  key={day}
                  label={dateLabel(day, { weekday: "long", day: "numeric", month: "long" })}
                  date={dateLabel(day, { weekday: "short", day: "numeric" })}
                  today={day === "2026-10-29"}
                  selected={day === anchor}
                  onOpen={() => {
                    setAnchor(day);
                    setMode("day");
                    setSelected(null);
                  }}
                >
                  {events
                    .filter(
                      (event) => event.day === day && layers.some((layer) => layer.id === event.layer && layer.visible),
                    )
                    .map((event) => (
                      <CalendarChip
                        key={event.id}
                        title={event.title}
                        time={event.time}
                        kind={event.kind}
                        color={layers.find((layer) => layer.id === event.layer)?.color}
                        readOnly={event.layer === "team"}
                        selected={selected === event.id}
                        onOpen={() => {
                          setSelected(event.id);
                          onAnnounce(`Selected ${event.title}.`);
                        }}
                      />
                    ))}
                </CalendarDay>
              ))}
            </CalendarGrid>
            {selectedEvent && (
              <div className="ds-calendar-selection">
                <Notice>
                  {selectedEvent.title} · {selectedEvent.time}
                  {selectedEvent.layer === "team" ? " · Read only" : ""}
                </Notice>
                {selectedEvent.kind === "session" && (
                  <CalendarSessionMenu
                    onEdit={() => onAnnounce(`Edit ${selectedEvent.title} selected in the preview.`)}
                    onUnschedule={() => {
                      setEvents((current) => current.filter((event) => event.id !== selectedEvent.id));
                      setSelected(null);
                      setScheduled((current) => current.filter((id) => id !== selectedEvent.taskId));
                      requestAnimationFrame(() => calendarFocus.current?.focus());
                      onAnnounce(`${selectedEvent.title} unscheduled in the preview.`);
                    }}
                  />
                )}
              </div>
            )}
          </div>
          <TaskTray
            count={openTasks.length}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            filters={
              <>
                <TextField
                  label="Search open preview tasks"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Select label="Open task epic" value={epic} onChange={(event) => setEpic(event.target.value)}>
                  <option value="">All epics</option>
                  <option>Release</option>
                  <option>Research</option>
                </Select>
              </>
            }
          >
            {["Release", "Research"].map((name) => {
              const tasks = openTasks.filter((task) => task.epic === name);
              return tasks.length ? (
                <TaskTrayGroup
                  key={name}
                  title={name}
                  count={tasks.length}
                  color={name === "Release" ? "var(--mds-accent)" : "var(--mds-success)"}
                >
                  {tasks.map((task) => (
                    <TaskTrayItem
                      key={task.id}
                      title={task.title}
                      metadata={`${task.minutes} min`}
                      onSchedule={() => schedule(task)}
                    />
                  ))}
                </TaskTrayGroup>
              ) : null;
            })}
            {!openTasks.length && <p className="mds-hint">No open tasks match these filters.</p>}
          </TaskTray>
        </div>
      </div>
      <div className="ds-planning-specimens" role="group" aria-label="Calendar chip states">
        <CalendarChip
          title="Selected event"
          time="09:00–09:30"
          selected
          onOpen={() => onAnnounce("Selected event specimen.")}
        />
        <CalendarChip
          title="Team event"
          time="All day"
          readOnly
          onOpen={() => onAnnounce("Read-only event specimen.")}
        />
        <CalendarChip title="Unavailable session" kind="session" disabled onOpen={() => {}} />
        <CalendarChip title="Release deadline" kind="due" onOpen={() => onAnnounce("Due-date specimen.")} />
      </div>
      <p className="ds-caption">
        Calendar filters, day cells, event/session/due-date chips, session actions and the open-task tray. Select a day
        or schedule a task; all changes stay in this sample.
      </p>
    </div>
  );
}
