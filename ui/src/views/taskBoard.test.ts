import { afterEach, expect, test, vi } from "vitest";
import type { QueryRow } from "../ipc/types";
import { taskGroups, workflowState, taskLabel } from "./taskBoardModel";
import { api } from "../ipc/api";
afterEach(() => vi.unstubAllGlobals());
const task = (path: string, line: number, parent: number | null, status: "open" | "done" | "moved" = "open"): QueryRow => ({ path, title: path, modified: 0, tags: [], props: {}, task: { line, parent, text: `Task ${line}`, mark: status === "done" ? "x" : " ", status, due: null, depth: parent ? 1 : 0 } });
test("nested groups stay scoped to their note and retain completed subtasks", () => {
  const groups = taskGroups([task("A.md", 2, null), task("A.md", 3, 2), task("A.md", 4, 3, "done"), task("B.md", 2, null), task("B.md", 3, 2), task("A.md", 5, null, "moved")]);
  expect(groups.map(g => [g.root.path, g.tasks.map(t => t.task.line)])).toEqual([["A.md", [2, 3, 4]], ["B.md", [2, 3]]]);
  expect(taskGroups([task("A.md", 3, 2)])[0].root.task.line).toBe(3);
  expect(workflowState({ ...groups[0].tasks[2].task, workflow: "blocked" })).toBe("done");
});
test("moving a card through the IPC persists Markdown and refuses a stale move", async () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const path = "Board test.md";
  await api.create(path, "# Board\n- [ ] Parent\n    - [ ] Review [[Plan]] ^review\n");
  await api.setTaskWorkflow(path, 3, "Review [[Plan]] ^review", "new", "blocked");
  const row = (await api.query("task:open|done")).rows.find(r => r.path === path && r.task?.line === 3)!;
  expect(row.task?.workflow).toBe("blocked");
  expect(row.task?.parent).toBe(2);
  expect(row.task?.text).toBe("Review [[Plan]] ^review");
  expect((await api.read(path)).content).toContain("    - [ ] Review [[Plan]] <!-- mosaic:state=blocked --> ^review");
  await expect(api.setTaskWorkflow(path, 3, row.task!.text, "new", "done")).rejects.toMatchObject({ code: "conflict" });
  await api.setTaskWorkflow(path, 3, row.task!.text, "blocked", "done");
  await api.setTask(path, 3, row.task!.text, false);
  expect(taskLabel((await api.read(path)).content!)).not.toContain("mosaic:state");
});
