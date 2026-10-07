import type { QueryRow, TaskRow } from "../ipc/types";
export const WORKFLOW_STATES = [
  { id: "new", title: "New" }, { id: "blocked", title: "Blocked" },
  { id: "in-progress", title: "In progress" }, { id: "in-qa", title: "In QA" }, { id: "done", title: "Done" },
] as const;
export type WorkflowState = typeof WORKFLOW_STATES[number]["id"];
export type BoardTask = QueryRow & { task: TaskRow };
export const taskKey = (row: BoardTask) => JSON.stringify([row.path, row.task.line]);
export const workflowState = (task: TaskRow): WorkflowState => task.status === "done" ? "done" : task.workflow ?? "new";
export const taskLabel = (text: string) => text.replace(/\s*<!--\s*mosaic:state=(new|blocked|in-progress|in-qa|done)\s*-->/g, "").trim();
export function annotatedTask(text: string, state: WorkflowState): string {
  const clean = taskLabel(text);
  if (state === "new" || state === "done") return clean;
  const block = /^(.*?)( \^[\w-]+)$/.exec(clean);
  return block ? `${block[1]} <!-- mosaic:state=${state} -->${block[2]}` : `${clean} <!-- mosaic:state=${state} -->`;
}
/** Resolve parents within each note, retaining nested subtasks and incomplete groups. */
export function taskGroups(rows: QueryRow[]): { root: BoardTask; tasks: BoardTask[] }[] {
  const tasks = rows.filter((r): r is BoardTask => !!r.task && ["open", "done"].includes(r.task.status));
  const byKey = new Map(tasks.map(row => [taskKey(row), row]));
  const groups = new Map<string, { root: BoardTask; tasks: BoardTask[] }>();
  for (const row of tasks) {
    let root = row;
    const seen = new Set([taskKey(root)]);
    while (root.task.parent !== null) {
      const parent = byKey.get(JSON.stringify([root.path, root.task.parent]));
      if (!parent || seen.has(taskKey(parent))) break;
      root = parent; seen.add(taskKey(parent));
    }
    const key = taskKey(root);
    const group = groups.get(key) ?? { root, tasks: [] };
    group.tasks.push(row); groups.set(key, group);
  }
  return [...groups.values()].map(g => ({ ...g, tasks: g.tasks.sort((a,b) => a.task.line - b.task.line) }));
}
