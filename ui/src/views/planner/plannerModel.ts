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

export type PlannerLifecycle = "active" | "archived" | "trash";

export function taskLifecycles(tasks: PlannerTask[], epics: PlannerEpic[]): Map<string, PlannerLifecycle> {
  const byId = new Map(tasks.map((task) => [task.id, task])),
    epicById = new Map(epics.map((epic) => [epic.id, epic])),
    resolved = new Map<string, PlannerLifecycle>(),
    resolving = new Set<string>();
  const lifecycle = (id: string): PlannerLifecycle => {
    const known = resolved.get(id);
    if (known) return known;
    const task = byId.get(id);
    if (!task) return "active";
    if (resolving.has(id)) return "active";
    resolving.add(id);
    const taskEpic = epicById.get(task.epic_id ?? "");
    let value: PlannerLifecycle =
      task.trashed_at || taskEpic?.trashed_at
        ? "trash"
        : task.archived_at || taskEpic?.archived_at
          ? "archived"
          : "active";
    if (task.parent_id) {
      const parent = lifecycle(task.parent_id);
      if (parent === "trash" || (parent === "archived" && value === "active")) value = parent;
    }
    resolving.delete(id);
    resolved.set(id, value);
    return value;
  };
  for (const task of tasks) lifecycle(task.id);
  return resolved;
}

export function taskChildren(tasks: PlannerTask[]): Map<string, PlannerTask[]> {
  const children = new Map<string, PlannerTask[]>();
  for (const task of tasks) {
    if (!task.parent_id) continue;
    const siblings = children.get(task.parent_id) ?? [];
    siblings.push(task);
    children.set(task.parent_id, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.position - b.position);
  return children;
}

export function descendantsFrom(children: Map<string, PlannerTask[]>, parentId: string): PlannerTask[] {
  const out: PlannerTask[] = [];
  const pending = [...(children.get(parentId) ?? [])].reverse();
  while (pending.length) {
    const task = pending.pop()!;
    out.push(task);
    const nested = children.get(task.id);
    if (nested) for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index]);
  }
  return out;
}

export function descendants(tasks: PlannerTask[], parentId: string): PlannerTask[] {
  return descendantsFrom(taskChildren(tasks), parentId);
}

export function swimlanes(epics: PlannerEpic[], tasks: PlannerTask[]): Swimlane[] {
  const roots = new Map<string | null, PlannerTask[]>();
  for (const task of tasks) {
    if (task.parent_id !== null) continue;
    const siblings = roots.get(task.epic_id) ?? [];
    siblings.push(task);
    roots.set(task.epic_id, siblings);
  }
  for (const siblings of roots.values()) siblings.sort((a, b) => a.position - b.position);
  const active: Swimlane[] = [...epics]
    .sort((a, b) => a.position - b.position)
    .map((epic) => ({
      id: epic.id,
      title: epic.title,
      color: epic.color,
      epic,
      tasks: roots.get(epic.id) ?? [],
    }));
  active.push({
    id: null,
    title: "Unassigned",
    color: null,
    epic: null,
    tasks: roots.get(null) ?? [],
  });
  return active;
}

export function subtaskProgress(tasks: PlannerTask[], parentId: string): { done: number; total: number } {
  const nested = descendants(tasks, parentId);
  return { done: nested.filter((task) => task.status === "done").length, total: nested.length };
}
