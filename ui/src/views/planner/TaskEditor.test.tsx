// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import type { PlannerEpic, PlannerTask, PlannerWorkSession } from "../../ipc/types";
import { useUi } from "../../state/ui";
import { TaskEditor } from "./TaskEditor";

vi.mock("./ActivityTimeline", () => ({ ActivityTimeline: () => <div data-testid="activity-timeline" /> }));

const task = (overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  id: "task-1",
  epic_id: "epic-1",
  parent_id: null,
  title: "Ship release",
  description: "Check every platform",
  status: "in-progress",
  due_date: null,
  estimate_minutes: null,
  position: 1024,
  revision: 3,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
  completed_at: null,
  archived_at: null,
  trashed_at: null,
  ...overrides,
});

const epic = (overrides: Partial<PlannerEpic> = {}): PlannerEpic => ({
  id: "epic-1",
  title: "Mosaic",
  description: "",
  color: "#123456",
  position: 1024,
  revision: 1,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
  archived_at: null,
  trashed_at: null,
  ...overrides,
});

const session = (overrides: Partial<PlannerWorkSession> = {}): PlannerWorkSession => ({
  id: "session-1",
  task_id: "task-1",
  all_day: false,
  start_value: "2099-10-28T10:00:00Z",
  end_value: "2099-10-28T11:00:00Z",
  timezone: "Europe/Zurich",
  state: "scheduled",
  revision: 1,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:00:00Z",
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("edits optional fields, saves them, and moves an active task", async () => {
  const user = userEvent.setup();
  const update = vi.spyOn(api, "updatePlannerTask").mockResolvedValue(task({ revision: 4, title: "Release Mosaic" }));
  const move = vi.spyOn(api, "movePlannerTask").mockResolvedValue(task({ revision: 4, status: "blocked" }));
  const changed = vi.fn();
  render(
    <TaskEditor
      task={task()}
      epics={[epic(), epic({ id: "hidden", title: "Archived", archived_at: "2026-10-01" })]}
      tasks={[]}
      onChanged={changed}
      onClose={vi.fn()}
      onReload={vi.fn()}
    />,
  );

  const title = screen.getByLabelText("Title");
  await user.clear(title);
  await user.type(title, "Release Mosaic");
  await user.clear(screen.getByLabelText("Description"));
  await user.type(screen.getByLabelText("Description"), "Verify signing");
  await user.type(screen.getByLabelText("Due date"), "2026-11-02");
  await user.type(screen.getByLabelText("Estimate (minutes)"), "45");
  expect(screen.queryByRole("option", { name: "Archived" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(update).toHaveBeenCalledWith("task-1", {
    expected_revision: 3,
    title: "Release Mosaic",
    description: "Verify signing",
    due_date: "2026-11-02",
    clear_due_date: false,
    estimate_minutes: 45,
    clear_estimate: false,
  });
  await user.selectOptions(screen.getByLabelText("Status"), "blocked");
  await waitFor(() => expect(move).toHaveBeenCalledWith("task-1", expect.objectContaining({ status: "blocked" })));
  expect(changed).toHaveBeenCalledTimes(2);
});

test("confirms unfinished subtasks and keeps future work sessions when completing", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "plannerWorkSessions").mockResolvedValue([
    session(),
    session({ id: "all-day", all_day: true, start_value: "2099-10-29", end_value: "2099-10-30" }),
    session({ id: "past", start_value: "2020-01-01T10:00:00Z", end_value: "2020-01-01T11:00:00Z" }),
  ]);
  const complete = vi.spyOn(api, "completePlannerTask").mockResolvedValue(task({ status: "done", revision: 4 }));
  const ask = vi
    .spyOn(useUi.getState(), "ask")
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  render(
    <TaskEditor
      task={task()}
      epics={[epic()]}
      tasks={[task(), task({ id: "child", parent_id: "task-1", status: "new" })]}
      onChanged={vi.fn()}
      onClose={vi.fn()}
      onReload={vi.fn()}
    />,
  );

  await user.selectOptions(screen.getByLabelText("Status"), "done");
  await waitFor(() => expect(complete).toHaveBeenCalledWith("task-1", 3, true, "keep"));
  expect(ask.mock.calls.map(([request]) => request.title)).toEqual([
    "Complete task with unfinished subtasks?",
    "Cancel future work sessions?",
    "Keep future work sessions?",
  ]);
});

test("creates and promotes subtasks, reorders them, and archives the task", async () => {
  const user = userEvent.setup();
  const child = task({ parent_id: "parent", position: 2048 });
  vi.spyOn(useUi.getState(), "askText").mockResolvedValue("  Verify updater  ");
  vi.spyOn(useUi.getState(), "ask").mockResolvedValue(true);
  const create = vi.spyOn(api, "createPlannerTask").mockResolvedValue(task({ id: "new-child", parent_id: child.id }));
  const move = vi.spyOn(api, "movePlannerTask").mockResolvedValue(task({ parent_id: null, revision: 4 }));
  const archive = vi.spyOn(api, "archivePlannerTask").mockResolvedValue(task({ archived_at: "2026-10-27" }));
  const changed = vi.fn();
  render(
    <TaskEditor task={child} epics={[epic()]} tasks={[]} onChanged={changed} onClose={vi.fn()} onReload={vi.fn()} />,
  );

  expect(screen.getByText(/Revision 3 · Subtask/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Add subtask" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ parent_id: "task-1", title: "Verify updater" })),
  );
  await user.click(screen.getByRole("button", { name: "Promote" }));
  await waitFor(() => expect(move).toHaveBeenCalledWith("task-1", expect.objectContaining({ parent_id: null })));
  await user.click(screen.getByRole("button", { name: "Move task earlier" }));
  await user.click(screen.getByRole("button", { name: "Move task later" }));
  await waitFor(() => expect(move).toHaveBeenCalledTimes(3));
  expect(move.mock.calls[1][1].position).toBe(512);
  expect(move.mock.calls[2][1].position).toBe(3584);
  await user.click(screen.getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(archive).toHaveBeenCalledWith("task-1", 3));
  expect(changed).toHaveBeenCalledWith(null);
});

test("shows revision conflicts and handles archived, deleted, and reopened tasks", async () => {
  const user = userEvent.setup();
  const reload = vi.fn();
  vi.spyOn(api, "updatePlannerTask").mockRejectedValue({
    code: "conflict",
    message: "revision changed",
    current_hash: null,
  });
  const active = render(
    <TaskEditor task={task()} epics={[epic()]} tasks={[]} onChanged={vi.fn()} onClose={vi.fn()} onReload={reload} />,
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("revision changed")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalled();
  active.unmount();
  vi.restoreAllMocks();

  const restore = vi.spyOn(api, "restorePlannerTask").mockResolvedValue(task());
  const trash = vi.spyOn(api, "trashPlannerTask").mockResolvedValue(task({ trashed_at: "2026-10-27" }));
  vi.spyOn(useUi.getState(), "ask").mockResolvedValue(true);
  const archived = render(
    <TaskEditor
      task={task({ archived_at: "2026-10-27" })}
      epics={[epic()]}
      tasks={[]}
      onChanged={vi.fn()}
      onClose={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Title")).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("task-1", 3));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(trash).toHaveBeenCalledWith("task-1", 3));
  archived.unmount();
  vi.restoreAllMocks();

  const reopen = vi.spyOn(api, "reopenPlannerTask").mockResolvedValue(task({ status: "new", revision: 4 }));
  const move = vi.spyOn(api, "movePlannerTask").mockResolvedValue(task({ status: "in-qa", revision: 5 }));
  render(
    <TaskEditor
      task={task({ status: "done", completed_at: "2026-10-27" })}
      epics={[epic()]}
      tasks={[]}
      onChanged={vi.fn()}
      onClose={vi.fn()}
      onReload={vi.fn()}
    />,
  );
  await user.selectOptions(screen.getByLabelText("Status"), "in-qa");
  await waitFor(() => expect(reopen).toHaveBeenCalledWith("task-1", 3));
  expect(move).toHaveBeenCalledWith("task-1", expect.objectContaining({ expected_revision: 4, status: "in-qa" }));
});
