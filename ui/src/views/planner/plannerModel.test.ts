import { expect, test } from "vitest";
import type { PlannerEpic, PlannerTask } from "../../ipc/types";
import { descendants, reorderEpics, subtaskProgress, swimlanes, taskLifecycles } from "./plannerModel";

const epic = (id: string, position: number): PlannerEpic => ({
  id,
  title: id,
  description: "",
  color: "blue",
  position,
  revision: 1,
  created_at: "",
  updated_at: "",
  archived_at: null,
  trashed_at: null,
});
const task = (
  id: string,
  epic_id: string | null,
  parent_id: string | null,
  status: PlannerTask["status"] = "new",
): PlannerTask => ({
  id,
  epic_id,
  parent_id,
  title: id,
  description: "",
  status,
  due_date: null,
  estimate_minutes: null,
  position: 1,
  revision: 1,
  created_at: "",
  updated_at: "",
  completed_at: null,
  archived_at: null,
  trashed_at: null,
});

test("epic swimlanes keep nested tasks inside their parent and Unassigned last", () => {
  const tasks = [task("parent", "a", null), task("child", "a", "parent", "done"), task("loose", null, null)];
  const lanes = swimlanes([epic("b", 2), epic("a", 1)], tasks);
  expect(lanes.map((lane) => lane.title)).toEqual(["a", "b", "Unassigned"]);
  expect(lanes[0].tasks.map((item) => item.id)).toEqual(["parent"]);
  expect(lanes[2].tasks.map((item) => item.id)).toEqual(["loose"]);
  expect(descendants(tasks, "parent").map((item) => item.id)).toEqual(["child"]);
  expect(subtaskProgress(tasks, "parent")).toEqual({ done: 1, total: 1 });
});

test("epics can be reordered before another epic or at the end", () => {
  const epics = [epic("c", 30), epic("a", 10), epic("b", 20)];
  expect(reorderEpics(epics, "c", "b").map((item) => [item.id, item.position])).toEqual([
    ["a", 10],
    ["c", 15],
    ["b", 20],
  ]);
  expect(reorderEpics(epics, "a", null).map((item) => item.id)).toEqual(["b", "c", "a"]);
  expect(reorderEpics(epics, "missing", "b").map((item) => item.id)).toEqual(["a", "b", "c"]);
});

test("10k-task board grouping stays within the interactive budget", () => {
  const epics = Array.from({ length: 100 }, (_, index) => epic(`epic-${index}`, index));
  const tasks = Array.from({ length: 10_000 }, (_, index) => ({
    ...task(`task-${index}`, `epic-${index % 100}`, null, index % 5 === 4 ? "done" : "new"),
    position: index,
  }));
  const started = performance.now();
  const lanes = swimlanes(epics, tasks);
  const elapsed = performance.now() - started;
  expect(lanes.reduce((count, lane) => count + lane.tasks.length, 0)).toBe(10_000);
  expect(elapsed).toBeLessThan(1_000);
});

test("tasks inherit archive and trash lifecycle from their parent or epic", () => {
  const archivedEpic = { ...epic("archived-epic", 1), archived_at: "2026-10-13T12:00:00Z" },
    trashedEpic = { ...epic("trashed-epic", 2), trashed_at: "2026-10-13T12:00:00Z" };
  const archivedParent = { ...task("archived-parent", null, null), archived_at: "2026-10-13T12:00:00Z" };
  const tasks = [
    archivedParent,
    task("child", null, archivedParent.id),
    task("epic-child", archivedEpic.id, null),
    task("trash-child", trashedEpic.id, null),
    task("active", null, null),
  ];
  const lifecycle = taskLifecycles(tasks, [archivedEpic, trashedEpic]);
  expect(Object.fromEntries(lifecycle)).toMatchObject({
    "archived-parent": "archived",
    child: "archived",
    "epic-child": "archived",
    "trash-child": "trash",
    active: "active",
  });
});
