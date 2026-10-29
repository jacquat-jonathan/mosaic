// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownImportPreview, PlannerEpic, PlannerSummary, PlannerTask } from "../../ipc/types";
import { api } from "../../ipc/api";
import { useUi } from "../../state/ui";
import { useVault } from "../../state/vault";

vi.mock("./TaskEditor", () => ({
  TaskEditor: ({
    task,
    onClose,
    onChanged,
  }: {
    task: PlannerTask;
    onClose(): void;
    onChanged(task: PlannerTask | null): void;
  }) => (
    <aside data-testid="task-editor">
      Editing {task.title}
      <button onClick={onClose}>Close task editor</button>
      <button onClick={() => onChanged(null)}>Changed task</button>
    </aside>
  ),
}));
vi.mock("./EpicEditor", () => ({
  EpicHistoryDialog: ({ epic, onClose }: { epic: PlannerEpic; onClose(): void }) => (
    <section role="dialog">
      <div data-testid="activity">History {epic.id}</div>
      <button aria-label="Close epic history" onClick={onClose}>
        Close
      </button>
    </section>
  ),
  EpicEditor: ({ epic, onClose, onDone }: { epic: PlannerEpic | null; onClose(): void; onDone(): void }) => (
    <aside data-testid="epic-editor">
      {epic ? `Editing ${epic.title}` : "New epic editor"}
      <button onClick={onClose}>Close epic editor</button>
      <button onClick={onDone}>Save epic editor</button>
    </aside>
  ),
}));
vi.mock("./MigrationWizard", () => ({
  MigrationWizard: ({ onCancel, onDone }: { onCancel(): void; onDone(): void }) => (
    <aside data-testid="migration-wizard">
      <button onClick={onCancel}>Cancel import</button>
      <button onClick={onDone}>Finish import</button>
    </aside>
  ),
}));
vi.mock("./ActivityTimeline", () => ({
  ActivityTimeline: ({ id }: { id: string }) => <div data-testid="activity">History {id}</div>,
}));

import { BoardView } from "./BoardView";

const epic = (id: string, position: number, overrides: Partial<PlannerEpic> = {}): PlannerEpic => ({
  id,
  title: `Epic ${id}`,
  description: "",
  color: id === "e1" ? "#f00" : "#0a0",
  position,
  revision: 1,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  archived_at: null,
  trashed_at: null,
  ...overrides,
});

const task = (id: string, status: PlannerTask["status"], overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  id,
  epic_id: "e1",
  parent_id: null,
  title: `Task ${id}`,
  description: `Description ${id}`,
  status,
  due_date: "2026-11-01",
  estimate_minutes: 30,
  position: Number(id.replace(/\D/g, "") || 1) * 1024,
  revision: 1,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  completed_at: status === "done" ? "2026-10-02T00:00:00Z" : null,
  archived_at: null,
  trashed_at: null,
  ...overrides,
});

const activeEpics = [epic("e1", 1024), epic("e2", 2048)];
const activeTasks = [
  task("t1", "new"),
  task("t2", "in-progress", { epic_id: "e2" }),
  task("t3", "done", { epic_id: null }),
  task("t4", "new", { parent_id: "t1", title: "Child open" }),
  task("t5", "done", { parent_id: "t1", title: "Child done" }),
];
const summary: PlannerSummary = {
  schema_version: 1,
  revision: 1,
  epics: 2,
  tasks: 5,
  work_sessions: 0,
  events: 0,
  is_empty: false,
};
const preview: MarkdownImportPreview = {
  planner_revision: 1,
  groups: [],
  candidates: 3,
  selected_by_default: 2,
  duplicates: 0,
};

const stubLoads = () => {
  vi.spyOn(api, "plannerSummary").mockResolvedValue(summary);
  vi.spyOn(api, "plannerEpics").mockImplementation(async (historical, trashed) => {
    if (!historical) return activeEpics;
    return trashed
      ? [epic("deleted", 1, { archived_at: "2026-10-02", trashed_at: "2026-10-03" })]
      : [epic("archived", 1, { archived_at: "2026-10-02" })];
  });
  vi.spyOn(api, "plannerTasks").mockImplementation(async (historical, trashed) => {
    if (!historical) return activeTasks;
    return trashed
      ? [task("deleted-task", "new", { epic_id: "deleted", archived_at: "2026-10-02", trashed_at: "2026-10-03" })]
      : [task("archived-task", "new", { epic_id: "archived", archived_at: "2026-10-02" })];
  });
  vi.spyOn(api, "plannerMigrationPreview").mockResolvedValue(preview);
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:test"),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  useVault.setState({ vault: { root: "/vault", name: "Vault" } });
  useUi.setState({ confirm: null, prompt: null });
  stubLoads();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("planner board", () => {
  it("loads lanes, filters, collapses, selects and edits parent and child task cards", async () => {
    render(<BoardView />);
    await screen.findByText("Task t1");
    expect(screen.getByText("1/2 subtasks")).toBeTruthy();
    expect(screen.getAllByText("Due 2026-11-01").length).toBeGreaterThan(0);
    const card = screen.getByText("Task t1").closest("article")!;
    fireEvent.click(card);
    expect(screen.getByTestId("task-editor").textContent).toContain("Task t1");
    fireEvent.click(screen.getByRole("button", { name: "Close task editor" }));
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Child open" }));
    expect(screen.getByTestId("task-editor").textContent).toContain("Child open");
    fireEvent.click(screen.getByRole("button", { name: "Changed task" }));

    const search = screen.getByLabelText("Search planner tasks");
    await userEvent.type(search, "Description t2");
    expect(screen.queryByText("Task t1")).toBeNull();
    await userEvent.clear(search);
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "done" } });
    fireEvent.change(screen.getByLabelText("Filter by epic"), { target: { value: "__unassigned" } });
    expect(screen.getByText("Task t3")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter by epic"), { target: { value: "e1" } });
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "" } });

    const collapse = screen.getAllByRole("button", { expanded: true })[0];
    fireEvent.click(collapse);
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(collapse);
  });

  it("creates tasks and epics and opens history", async () => {
    const askText = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(" ").mockResolvedValueOnce(" New item ");
    useUi.setState({ askText });
    const createTask = vi
      .spyOn(api, "createPlannerTask")
      .mockResolvedValue(task("new-task", "new", { title: "New item" }));
    render(<BoardView />);
    await screen.findByText("Task t1");
    const newTask = screen.getByRole("button", { name: "New task" });
    fireEvent.click(newTask);
    fireEvent.click(newTask);
    fireEvent.click(newTask);
    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "New item", epic_id: null })),
    );
    fireEvent.click(screen.getByRole("button", { name: "New epic" }));
    expect(screen.getByTestId("epic-editor")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close epic editor" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save epic editor" }));
    fireEvent.click(screen.getAllByRole("button", { name: "History" })[0]);
    expect(screen.getByTestId("activity")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Close epic history" }));
  });

  it("opens, cancels and completes Markdown imports", async () => {
    const user = userEvent.setup();
    render(<BoardView />);
    await screen.findByText("Task t1");

    await user.click(screen.getByRole("button", { name: "Import Markdown tasks…" }));
    await waitFor(() => expect(api.plannerMigrationPreview).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Cancel import" }));

    await user.click(screen.getByRole("button", { name: "Import Markdown tasks…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish import" }));
    await screen.findByText("Task t1");
  });

  it("moves and completes tasks through drag, subtask toggles and future-session decisions", async () => {
    const move = vi.spyOn(api, "movePlannerTask").mockImplementation(async (_id, input) => {
      const current = activeTasks.find((item) => item.id === _id)!;
      return {
        ...current,
        epic_id: input.epic_id === undefined ? current.epic_id : input.epic_id,
        status: input.status,
        position: input.position,
        revision: 2,
      };
    });
    const reopen = vi.spyOn(api, "reopenPlannerTask").mockImplementation(async (id) => ({
      ...activeTasks.find((item) => item.id === id)!,
      status: "new",
      revision: 2,
    }));
    const complete = vi.spyOn(api, "completePlannerTask").mockImplementation(async (id) => ({
      ...activeTasks.find((item) => item.id === id)!,
      status: "done",
      revision: 2,
    }));
    vi.spyOn(api, "plannerWorkSessions").mockResolvedValue([
      {
        id: "future",
        task_id: "t1",
        all_day: true,
        start_value: "2099-01-01",
        end_value: "2099-01-02",
        timezone: "UTC",
        state: "planned",
        revision: 1,
        created_at: "",
        updated_at: "",
      },
    ]);
    const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    useUi.setState({ ask });
    render(<BoardView />);
    await screen.findByText("Task t1");

    fireEvent.click(screen.getByLabelText("Mark Child open done"));
    await waitFor(() => expect(complete).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText("Mark Child done not done"));
    await waitFor(() => expect(reopen).toHaveBeenCalled());

    const source = screen.getByText("Task t2").closest("article")!;
    const data = new Map<string, string>();
    const dt = {
      types: ["application/x-mosaic-planner-task"],
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };
    fireEvent.dragStart(source, { dataTransfer: dt });
    const targetColumn = screen.getByLabelText("Epic e1: Blocked");
    fireEvent.dragOver(targetColumn, { dataTransfer: dt });
    fireEvent.drop(targetColumn, { dataTransfer: dt });
    await waitFor(() => expect(move).toHaveBeenCalled());
    fireEvent.dragLeave(targetColumn, { dataTransfer: dt, relatedTarget: document.body });

    data.set("application/x-mosaic-planner-task", "t2");
    fireEvent.dragOver(screen.getByText("Task t1").closest("article")!, { dataTransfer: dt });
    fireEvent.drop(screen.getByText("Task t1").closest("article")!, { dataTransfer: dt });
    await waitFor(() => expect(move.mock.calls.length).toBeGreaterThan(1));
  });

  it("reorders, archives, restores and deletes epics across lifecycle views", async () => {
    const update = vi.spyOn(api, "updatePlannerEpic").mockImplementation(async (id, input) => ({
      ...activeEpics.find((item) => item.id === id)!,
      position: input.position ?? 0,
      revision: 2,
    }));
    const archive = vi.spyOn(api, "archivePlannerEpic").mockResolvedValue(epic("e1", 1, { archived_at: "x" }));
    const trash = vi
      .spyOn(api, "trashPlannerEpic")
      .mockResolvedValue(epic("archived", 1, { archived_at: "x", trashed_at: "y" }));
    const restore = vi.spyOn(api, "restorePlannerEpic").mockResolvedValue(epic("restored", 1));
    useUi.setState({ ask: vi.fn().mockResolvedValue(true) });
    render(<BoardView />);
    await screen.findByText("Task t1");
    fireEvent.click(screen.getByLabelText("Move Epic e2 up"));
    await waitFor(() => expect(update).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);
    await waitFor(() => expect(archive).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Planner lifecycle view"), { target: { value: "archived" } });
    await screen.findByText("Task archived-task");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(trash).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Planner lifecycle view"), { target: { value: "trash" } });
    await screen.findByText("Task deleted-task");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  });

  it("exports both formats and renders the empty planner onboarding choices", async () => {
    vi.spyOn(api, "exportPlanner").mockImplementation(async (format) => (format === "json" ? "{}" : "a,b"));
    render(<BoardView />);
    await screen.findByText("Task t1");
    fireEvent.click(screen.getByRole("button", { name: "JSON export" }));
    fireEvent.click(screen.getByRole("button", { name: "CSV table" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
    cleanup();

    vi.spyOn(api, "plannerSummary").mockResolvedValue({ ...summary, epics: 0, tasks: 0, is_empty: true });
    vi.spyOn(api, "plannerEpics").mockResolvedValue([]);
    vi.spyOn(api, "plannerTasks").mockResolvedValue([]);
    localStorage.clear();
    render(<BoardView />);
    await screen.findByText("Plan your work in Mosaic");
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    expect(screen.getByTestId("migration-wizard")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(await screen.findByRole("button", { name: "New task" })).toBeTruthy();
  });
  it("ignores older lifecycle loads and offers retry after failure", async () => {
    let finish!: (value: PlannerTask[]) => void;
    vi.spyOn(api, "plannerTasks")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([task("archived-task", "new", { epic_id: "archived", archived_at: "x" })]);
    render(<BoardView />);
    fireEvent.change(screen.getByLabelText("Planner lifecycle view"), { target: { value: "archived" } });
    await screen.findByText("Task archived-task");
    finish(activeTasks);
    await waitFor(() => expect(screen.queryByText("Task t1")).toBeNull());
    cleanup();
    vi.spyOn(api, "plannerSummary").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(summary);
    render(<BoardView />);
    expect(await screen.findByText("offline")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("offline")).toBeNull());
  });
  it("cancelled or late task-name prompts cannot create a task in another vault", async () => {
    let finish!: (value: string | null) => void;
    useUi.setState({
      askText: vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const create = vi.spyOn(api, "createPlannerTask");
    render(<BoardView />);
    await screen.findByText("Task t1");
    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    useVault.setState({ vault: { root: "/other", name: "Other" } });
    finish("Late task");
    await waitFor(() => expect(create).not.toHaveBeenCalled());
  });
});
