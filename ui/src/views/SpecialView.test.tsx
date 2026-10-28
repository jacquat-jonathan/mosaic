// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { usePlanning } from "../state/planning";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { SpecialView } from "./SpecialView";

vi.mock("./CalendarView", () => ({
  CalendarView: ({ initialMode }: { initialMode?: string }) => <div>calendar:{initialMode}</div>,
}));
vi.mock("./ChatPanel", () => ({ ChatPanel: ({ id }: { id: string }) => <div>chat:{id}</div> }));
vi.mock("./ChatHistory", () => ({ ChatHistoryPage: () => <div>Chats</div> }));
vi.mock("./Workflows", () => ({
  Workflows: ({ name, runsOnly, agentsOnly }: { name?: string; runsOnly?: boolean; agentsOnly?: boolean }) => (
    <div>
      workflows:{name}:{String(runsOnly)}:{String(agentsOnly)}
    </div>
  ),
  WorkflowForm: () => <div>workflow-form</div>,
  RunDetail: ({ id }: { id: string }) => <div>run:{id}</div>,
}));
vi.mock("./ActivityPanel", () => ({ ActivityPanel: () => <div>activity-panel</div> }));
vi.mock("./ConnectAi", () => ({ ConnectAiSection: () => <div>Connections</div> }));
vi.mock("./Settings", () => ({ Settings: () => <div>settings</div> }));
vi.mock("./SearchPanel", () => ({ SearchPanel: () => <div>search</div> }));
vi.mock("./TaskBoard", () => ({ TaskBoard: () => <div>task-board</div> }));

beforeEach(() => {
  useVault.setState({ revision: 0 });
  usePlanning.setState({ views: [{ id: "mine", title: "My planning", query: "task:open tag:mine" }] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("routes every workspace kind to its surface", () => {
  const cases = [
    ["mosaic:calendar", "calendar:"],
    ["mosaic:week", "calendar:week"],
    ["mosaic:today", "calendar:day"],
    ["mosaic:chat/abc", "chat:abc"],
    ["mosaic:chats", "Chats"],
    ["mosaic:agents", "workflows::undefined:true"],
    ["mosaic:workflows", "workflows::undefined:undefined"],
    ["mosaic:workflow/weekly", "workflows:weekly:undefined:undefined"],
    ["mosaic:new-workflow", "workflow-form"],
    ["mosaic:runs", "workflows::true:undefined"],
    ["mosaic:run/42", "run:42"],
    ["mosaic:activity", "Activity & review"],
    ["mosaic:connections", "Connections"],
    ["mosaic:settings", "settings"],
    ["mosaic:search", "search"],
    ["mosaic:board", "task-board"],
    ["mosaic:unknown", "no longer available"],
  ] as const;
  for (const [path, marker] of cases) {
    const view = render(<SpecialView path={path} />);
    expect(screen.getByText(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))).toBeTruthy();
    view.unmount();
  }
});

test("queries task views, toggles tasks and opens their notes", async () => {
  const query = vi.spyOn(api, "query").mockResolvedValue({
    columns: ["status"],
    total: 2,
    rows: [
      {
        path: "Projects/Plan.md",
        title: "Plan",
        modified: 1,
        tags: [],
        props: {},
        task: { workflow: "", line: 3, text: "Ship", status: "open", mark: " ", depth: 0, parent: null, due: null },
      },
    ],
  });
  const setTask = vi
    .spyOn(api, "setTask")
    .mockResolvedValue({ path: "Projects/Plan.md", hash: "updated", review: null });
  const open = vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  render(<SpecialView path="mosaic:query/task%3Aopen" />);
  expect(await screen.findByText("2 results · showing 1")).toBeTruthy();
  await userEvent.click(screen.getByRole("checkbox", { name: "Ship" }));
  await waitFor(() => expect(setTask).toHaveBeenCalledWith("Projects/Plan.md", 3, "Ship", true));
  await userEvent.click(screen.getByRole("button", { name: "Plan" }));
  expect(open).toHaveBeenCalledWith("Projects/Plan.md", { newTab: true });
  expect(query).toHaveBeenCalledWith("task:open");
});

test("covers saved, overdue, project, generic and empty task queries", async () => {
  vi.spyOn(api, "query").mockResolvedValue({ columns: [], rows: [], total: 0 });
  for (const [path, heading] of [
    ["mosaic:planning/mine", "My planning"],
    ["mosaic:overdue", "Overdue"],
    ["mosaic:projects", "Project tasks"],
    ["mosaic:tasks", "Tasks"],
  ]) {
    const view = render(<SpecialView path={path} />);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(await screen.findByText(/No tasks match this view/)).toBeTruthy();
    view.unmount();
  }

  const view = render(<SpecialView path="mosaic:planning/missing" />);
  expect(await screen.findByText("This saved view is unavailable.")).toBeTruthy();
  view.unmount();

  vi.restoreAllMocks();
  vi.spyOn(api, "query").mockRejectedValue(new Error("query failed"));
  render(<SpecialView path="mosaic:tasks" />);
  expect(await screen.findByText("query failed")).toBeTruthy();
});
