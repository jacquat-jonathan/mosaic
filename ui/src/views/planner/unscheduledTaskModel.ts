import type { PlannerEpic, PlannerTask } from "../../ipc/types";
import { PLANNER_STATUSES, taskChildren } from "./plannerModel";

export type OpenTaskNode = { task: PlannerTask; children: OpenTaskNode[] };

export function openTaskGroups(tasks: PlannerTask[], epics: PlannerEpic[], search: string, epicFilter: string) {
  const query = search.trim().toLowerCase();
  const byEpic = new Map<string | null, PlannerTask[]>();
  for (const task of tasks) {
    if (task.status === "done" || task.archived_at || task.trashed_at) continue;
    if (epicFilter && (epicFilter === "__none" ? task.epic_id !== null : task.epic_id !== epicFilter)) continue;
    const siblings = byEpic.get(task.epic_id) ?? [];
    siblings.push(task);
    byEpic.set(task.epic_id, siblings);
  }
  const epicById = new Map(epics.map((epic) => [epic.id, epic]));
  return [...byEpic]
    .sort(([left], [right]) => {
      if (left === null) return 1;
      if (right === null) return -1;
      return (epicById.get(left)?.position ?? 0) - (epicById.get(right)?.position ?? 0) || left.localeCompare(right);
    })
    .flatMap(([id, items]) => {
      const epic = epicById.get(id ?? ""),
        title = epic?.title ?? "Unassigned";
      const ids = new Set(items.map((task) => task.id)),
        children = taskChildren(items),
        visited = new Set<string>();
      const build = (task: PlannerTask): OpenTaskNode => {
        visited.add(task.id);
        return { task, children: (children.get(task.id) ?? []).filter((child) => !visited.has(child.id)).map(build) };
      };
      const byPosition = (a: PlannerTask, b: PlannerTask) => a.position - b.position || a.id.localeCompare(b.id);
      const roots = items
        .filter((task) => !task.parent_id || !ids.has(task.parent_id))
        .sort(byPosition)
        .map(build);
      // Keep open children whose parent is absent (for example a completed parent), and tolerate old malformed trees.
      for (const task of [...items].sort(byPosition)) if (!visited.has(task.id)) roots.push(build(task));
      const filter = (node: OpenTaskNode): OpenTaskNode | null => {
        if (!query || `${title} ${node.task.title}`.toLowerCase().includes(query)) return node;
        const nested = node.children.map(filter).filter((child): child is OpenTaskNode => child !== null);
        return nested.length ? { ...node, children: nested } : null;
      };
      const visible = roots.map(filter).filter((node): node is OpenTaskNode => node !== null);
      const count = (node: OpenTaskNode): number => 1 + node.children.reduce((sum, child) => sum + count(child), 0);
      const sections = PLANNER_STATUSES.flatMap((status) => {
        const nodes = visible.filter((node) => node.task.status === status.id);
        return nodes.length ? [{ ...status, nodes }] : [];
      });
      return visible.length
        ? [
            {
              id: id ?? "__none",
              title,
              color: epic?.color ?? "var(--accent)",
              count: visible.reduce((sum, node) => sum + count(node), 0),
              sections,
            },
          ]
        : [];
    });
}
