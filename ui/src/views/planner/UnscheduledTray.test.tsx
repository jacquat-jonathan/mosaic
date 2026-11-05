// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlannerEpic, PlannerTask } from "../../ipc/types";
import { openTaskGroups } from "./unscheduledTaskModel";
import { TASK_DRAG, UnscheduledTray } from "./UnscheduledTray";

const epic = (id: string, position: number): PlannerEpic => ({
  id,
  title: id,
  description: "",
  color: "#ff4000",
  position,
  revision: 1,
  created_at: "",
  updated_at: "",
  archived_at: null,
  trashed_at: null,
});
const task = (
  id: string,
  position: number,
  parent_id: string | null = null,
  status: PlannerTask["status"] = "new",
): PlannerTask => ({
  id,
  title: id,
  epic_id: "Strategy",
  parent_id,
  status,
  position,
  description: "",
  due_date: null,
  estimate_minutes: null,
  revision: 1,
  created_at: "",
  updated_at: "",
  completed_at: null,
  archived_at: null,
  trashed_at: null,
});
const tasks = [
  task("mobile-api-gateway", 100, "Backend"),
  task("Add the new header", 200, "Mobile"),
  task("Backend", 300, null, "in-progress"),
  task("Mobile", 400, null, "in-progress"),
  task("Test the datatrans integration", 500, "Mobile"),
  task("order-gateway", 600, "Backend"),
  task("Bring EO-A/B tests", 700),
  task("checkout", 800, "Backend"),
  task("Remove unused Feature flags", 900),
];
const epics = [epic("Strategy", 20)];

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 800));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("open task hierarchy", () => {
  it("matches the board's status and sibling order instead of interleaving parents and children by position", () => {
    const [group] = openTaskGroups([...tasks].reverse(), epics, "", "");
    expect(group.count).toBe(9);
    expect(group.sections.map((section) => section.title)).toEqual(["New", "In progress"]);
    expect(group.sections[0].nodes.map((node) => node.task.id)).toEqual([
      "Bring EO-A/B tests",
      "Remove unused Feature flags",
    ]);
    const parents = group.sections[1].nodes;
    expect(parents.map((node) => node.task.id)).toEqual(["Backend", "Mobile"]);
    expect(parents[0].children.map((node) => node.task.id)).toEqual([
      "mobile-api-gateway",
      "order-gateway",
      "checkout",
    ]);
    expect(parents[1].children.map((node) => node.task.id)).toEqual([
      "Add the new header",
      "Test the datatrans integration",
    ]);
  });
  it("uses the saved epic order with Unassigned last", () => {
    const items = [...tasks, { ...task("other", 1), epic_id: "Zebra" }, { ...task("loose", 1), epic_id: null }];
    expect(openTaskGroups(items, [...epics, epic("Zebra", 10)], "", "").map((group) => group.title)).toEqual([
      "Zebra",
      "Strategy",
      "Unassigned",
    ]);
    expect(openTaskGroups(items, epics, "", "__none").map((group) => group.title)).toEqual(["Unassigned"]);
  });
  it("keeps the ancestor path when searching a subtask and the whole branch when searching a parent", () => {
    const [group] = openTaskGroups(tasks, epics, "order-gateway", "");
    expect(group.count).toBe(2);
    expect(group.sections[0].nodes[0].task.id).toBe("Backend");
    expect(group.sections[0].nodes[0].children.map((node) => node.task.id)).toEqual(["order-gateway"]);
    expect(openTaskGroups(tasks, epics, "Backend", "")[0].count).toBe(4);
    expect(openTaskGroups(tasks, epics, "no match", "")).toEqual([]);
  });
  it("keeps nested descendants and open children whose completed parent is absent", () => {
    const nested = [
      ...tasks,
      task("nested", 1, "checkout"),
      task("done", 1, null, "done"),
      task("open child", 2, "done"),
      { ...task("archived", 1), archived_at: "2026-01-01" },
    ];
    const [group] = openTaskGroups(nested, epics, "", "");
    expect(group.sections[0].nodes.some((node) => node.task.id === "open child")).toBe(true);
    expect(
      group.sections.flatMap((section) => section.nodes).some((node) => ["done", "archived"].includes(node.task.id)),
    ).toBe(false);
    expect(group.sections[1].nodes[0].children[2].children[0].task.id).toBe("nested");
  });
  it("renders each parent's subtasks together and schedules or drags the selected child", () => {
    const onSchedule = vi.fn(),
      onDragPreview = vi.fn();
    const { container } = render(
      <UnscheduledTray
        designSystem
        tasks={tasks}
        epics={epics}
        onSchedule={onSchedule}
        onDragPreview={onDragPreview}
      />,
    );
    const backend = screen.getByRole("list", { name: "Subtasks of Backend" });
    expect(
      within(backend)
        .getAllByRole("button")
        .map((button) => button.querySelector("strong")?.textContent),
    ).toEqual(["mobile-api-gateway", "order-gateway", "checkout"]);
    const child = within(backend).getByRole("button", { name: /order-gateway/ });
    fireEvent.click(child);
    expect(onSchedule).toHaveBeenCalledWith(tasks[5]);
    const setData = vi.fn();
    fireEvent.dragStart(child.closest(".unscheduled-task-card")!, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledExactlyOnceWith(TASK_DRAG, "order-gateway");
    expect(onDragPreview).toHaveBeenCalledWith(expect.objectContaining({ label: "order-gateway" }));
    expect([...container.querySelectorAll(".unscheduled-task-card strong")].map((el) => el.textContent)).toEqual([
      "Bring EO-A/B tests",
      "Remove unused Feature flags",
      "Backend",
      "mobile-api-gateway",
      "order-gateway",
      "checkout",
      "Mobile",
      "Add the new header",
      "Test the datatrans integration",
    ]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "checkout" } });
    expect(screen.getByText("Backend")).toBeTruthy();
    expect(screen.queryByText("Mobile")).toBeNull();
  });
});
