import { useMemo } from "react";
import type { DayTask } from "../ipc/types";
import { useWorkspace } from "../state/workspace";
import { progress } from "./calendar";

const noteName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");
export function TaskList({
  tasks,
  onTick,
  showNote = false,
}: {
  tasks: DayTask[];
  onTick(task: DayTask, done: boolean): void;
  showNote?: boolean;
}) {
  const values = useMemo(() => progress(tasks), [tasks]);
  return (
    <ul className="calendar-tasks">
      {tasks.map((task) => {
        const item = values.get(`${task.path}:${task.line}`),
          tickable = task.status === "open" || task.status === "done";
        return (
          <li
            key={`${task.path}:${task.line}`}
            className={`calendar-task status-${task.status}`}
            style={{ paddingLeft: task.depth * 16 }}
          >
            <input
              type="checkbox"
              checked={task.status === "done"}
              disabled={!tickable}
              aria-label={task.text || "Task"}
              onChange={(event) => onTick(task, event.target.checked)}
            />
            <span className="calendar-task-text">
              {task.status === "moved" && "→ "}
              {task.text || "(empty task)"}
              {item && (
                <span className="calendar-progress">
                  {" "}
                  {item.done}/{item.total}
                </span>
              )}
              {showNote && (
                <button
                  className="calendar-note-link"
                  onClick={() => void useWorkspace.getState().open(task.path, { newTab: true })}
                >
                  {noteName(task.path)}
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
