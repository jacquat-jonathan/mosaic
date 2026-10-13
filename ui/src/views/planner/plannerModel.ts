import type { PlannerEpic, PlannerTask, PlannerTaskStatus } from "../../ipc/types";

export const PLANNER_STATUSES: { id: PlannerTaskStatus; title: string }[] = [
  { id: "new", title: "New" },
  { id: "blocked", title: "Blocked" },
  { id: "in-progress", title: "In progress" },
  { id: "in-qa", title: "In QA" },
  { id: "done", title: "Done" },
];

export interface Swimlane {
  id: string | null;
  title: string;
  color: string | null;
  epic: PlannerEpic | null;
  tasks: PlannerTask[];
}

export function descendants(tasks: PlannerTask[], parentId: string): PlannerTask[] {
  const out: PlannerTask[] = [];
  const visit = (id: string) => {
    for (const task of tasks.filter(item => item.parent_id === id)) {
      out.push(task);
      visit(task.id);
    }
  };
  visit(parentId);
  return out;
}

export function swimlanes(epics: PlannerEpic[], tasks: PlannerTask[]): Swimlane[] {
  const active: Swimlane[] = epics
    .filter(epic => !epic.trashed_at)
    .sort((a, b) => a.position - b.position)
    .map(epic => ({
      id: epic.id,
      title: epic.title,
      color: epic.color,
      epic,
      tasks: tasks.filter(task => task.epic_id === epic.id && task.parent_id === null),
    }));
  active.push({
    id: null,
    title: "Unassigned",
    color: null,
    epic: null,
    tasks: tasks.filter(task => task.epic_id === null && task.parent_id === null),
  });
  return active;
}

export function subtaskProgress(tasks: PlannerTask[], parentId: string): { done: number; total: number } {
  const nested = descendants(tasks, parentId);
  return { done: nested.filter(task => task.status === "done").length, total: nested.length };
}

