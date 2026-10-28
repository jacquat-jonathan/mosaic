// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRun, Proposal, TesseraStatus } from "../ipc/types";
import { api } from "../ipc/api";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

vi.mock("./FolderChoices", () => ({
  FolderChoices: ({ label, onChange }: { label: string; onChange(value: string[]): void }) => (
    <button type="button" onClick={() => onChange(label.startsWith("Event") ? [""] : ["Projects"])}>
      Choose {label}
    </button>
  ),
}));

import {
  RunDetail,
  WorkflowContext,
  WorkflowForm,
  Workflows,
  runState,
  workflowContent,
  workflowTrigger,
} from "./Workflows";

const agent = (name: string, overrides: Partial<Agent> = {}): Agent => ({
  name,
  title: `Agent ${name}`,
  description: `Description ${name}`,
  path: `Agents/${name}.md`,
  skill_folder: false,
  schedule: null,
  on: [],
  model: null,
  may_change: [],
  web: false,
  instructions: `Do the ${name} work`,
  ...overrides,
});

const run = (id: number, owner: string, status: string, overrides: Partial<AgentRun> = {}): AgentRun => ({
  id,
  agent: owner,
  title: `Run ${id}`,
  started: 1_798_000_000 + id,
  finished: status === "running" ? null : 1_798_000_100 + id,
  late: false,
  status,
  answer: status === "running" ? "" : "Finished",
  error: status === "failed" ? "Something failed" : null,
  proposals: 0,
  ...overrides,
});

const agents = [
  agent("running", {
    schedule: "daily 08:00",
    on: ["created in Daily/"],
    model: "sonnet",
    may_change: ["Daily"],
    web: true,
  }),
  agent("queued", { schedule: "every 2h" }),
  agent("paused", { on: ["created in /"], skill_folder: true, path: "Agents/paused/SKILL.md" }),
  agent("broken", { schedule: "fri 17:00" }),
  agent("review"),
  agent("successful"),
  agent("ready"),
];

const runs = [
  run(1, "running", "running", {
    trigger: "Manual",
    model: "opus",
    attempts: 2,
    chain_id: "chain",
    chain_depth: 1,
    late: true,
    changed_paths: ["Notes/Changed.md"],
    changes: ["Edited a note"],
  }),
  run(2, "review", "successful", { proposals: 1, proposal_ids: [9] }),
  run(3, "successful", "successful"),
  run(4, "broken", "failed"),
  run(5, "paused", "skipped"),
];

const status: TesseraStatus = {
  paused: false,
  max_chain_depth: 5,
  agents: [
    {
      name: "running",
      title: "Running",
      schedule: "daily 08:00",
      on: [],
      model: null,
      paused: false,
      running: true,
      queued: 0,
      error: null,
    },
    {
      name: "queued",
      title: "Queued",
      schedule: "every 2h",
      on: [],
      model: null,
      paused: false,
      running: false,
      queued: 2,
      error: null,
    },
    {
      name: "paused",
      title: "Paused",
      schedule: null,
      on: ["created in /"],
      model: null,
      paused: true,
      running: false,
      queued: 0,
      error: null,
    },
    {
      name: "broken",
      title: "Broken",
      schedule: "fri 17:00",
      on: [],
      model: null,
      paused: false,
      running: false,
      queued: 0,
      error: "Scheduler error",
    },
    {
      name: "review",
      title: "Review",
      schedule: null,
      on: [],
      model: null,
      paused: false,
      running: false,
      queued: 0,
      error: null,
    },
    {
      name: "successful",
      title: "Successful",
      schedule: null,
      on: [],
      model: null,
      paused: false,
      running: false,
      queued: 0,
      error: null,
    },
    {
      name: "ready",
      title: "Ready",
      schedule: null,
      on: [],
      model: null,
      paused: false,
      running: false,
      queued: 0,
      error: null,
    },
  ],
  runs,
};

beforeEach(() => {
  localStorage.clear();
  useAttention.setState({ status, agents, error: null, refresh: vi.fn().mockResolvedValue(undefined) });
  useReview.setState({ pending: [{ id: 9, updated: 1, stale: false } as Proposal], initialized: true });
  useVault.setState({
    vault: { root: "/vault", name: "Vault" },
    entries: [
      { path: "Daily/Today.md", name: "Today.md", is_dir: false, kind: "markdown", size: 10, mtime: 1 },
      { path: "Daily/image.png", name: "image.png", is_dir: false, kind: "image", size: 10, mtime: 1 },
      { path: "Other.md", name: "Other.md", is_dir: false, kind: "markdown", size: 10, mtime: 1 },
    ],
    remove: vi.fn().mockResolvedValue(true),
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  useUi.setState({
    menu: null,
    picker: null,
    confirm: null,
    openView: vi.fn(),
    ask: vi.fn().mockResolvedValue(true),
  });
  vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue(undefined);
  vi.spyOn(api, "tesseraPauseAll").mockResolvedValue(null);
  vi.spyOn(api, "tesseraPauseAgent").mockResolvedValue(null);
  vi.spyOn(api, "tesseraRun").mockResolvedValue(42);
  vi.spyOn(api, "tesseraTestEvent").mockResolvedValue(43);
  vi.spyOn(api, "mirrorAgents").mockResolvedValue({ written: [], removed: [], skipped: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workflow helpers and detail views", () => {
  it("describes all run states and frontmatter shapes", () => {
    expect(runState(run(1, "a", "running"))).toBe("Running");
    expect(runState(run(1, "a", "failed"))).toBe("Failed");
    expect(runState(run(1, "a", "skipped"))).toBe("Skipped");
    expect(runState(run(1, "a", "successful"), true)).toBe("Needs review");
    expect(runState(run(1, "a", "successful"))).toBe("Successful");
    expect(workflowTrigger(agent("manual"))).toBe("Manual");
    expect(workflowTrigger(agent("event", { on: ["created in /", "tagged #ready"] }))).toContain("tagged #ready");

    const oneEvent = workflowContent(
      "---\nname: new\n---\nBody",
      null,
      ["created in /"],
      null,
      [],
      " New instructions ",
      true,
    );
    expect(oneEvent).toContain("on: created in /");
    expect(oneEvent).toContain("New instructions");
    const many = workflowContent(oneEvent, "every 3h", ["one", "two"], "haiku", ["Projects"], undefined, false);
    expect(many).toContain("on:");
    expect(many).not.toContain("web:");
  });

  it("renders rich run details and workflow context states", async () => {
    useAttention.setState({
      status,
      agents,
    });
    useReview.setState({ pending: [{ id: 9 } as Proposal] });
    const { rerender } = render(<RunDetail id="1" />);
    expect(screen.getByText("Started late", { exact: false })).toBeTruthy();
    expect(screen.getByText("Depth 1 · chain")).toBeTruthy();
    rerender(<RunDetail id="2" />);
    expect(screen.getByText("Needs review")).toBeTruthy();
    rerender(<RunDetail id="missing" />);
    expect(screen.getByText("This run is unavailable.")).toBeTruthy();

    rerender(<WorkflowContext name="running" />);
    expect(screen.getByText("Running")).toBeTruthy();
    rerender(<WorkflowContext name="queued" />);
    expect(screen.getByText("Queued")).toBeTruthy();
    rerender(<WorkflowContext name="paused" />);
    expect(screen.getByText("Paused")).toBeTruthy();
    rerender(<WorkflowContext name="broken" />);
    expect(screen.getByText("Failed")).toBeTruthy();
    rerender(<WorkflowContext name="review" />);
    expect(screen.getByText("Needs review")).toBeTruthy();
    rerender(<WorkflowContext name="ready" />);
    expect(screen.getByText("Ready")).toBeTruthy();
    rerender(<WorkflowContext name="missing" />);
    expect(screen.getByText("Workflow unavailable.")).toBeTruthy();
  });
});

describe("workflow list actions", () => {
  it("renders every state and runs, pauses, tests and opens menu actions", async () => {
    render(<Workflows />);
    expect(screen.getByText("Queued · 2")).toBeTruthy();
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Scheduler error").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Pause automations" }));
    await waitFor(() => expect(api.tesseraPauseAll).toHaveBeenCalledWith(true));
    const readyCard = screen.getByText("Agent ready").closest("article")!;
    fireEvent.click(readyCard.querySelector<HTMLButtonElement>("button.primary")!);
    await waitFor(() => expect(api.tesseraRun).toHaveBeenCalledWith("ready"));

    const pausedCard = screen.getByText("Agent paused").closest("article")!;
    fireEvent.click(pausedCard.querySelector<HTMLButtonElement>("footer button:nth-child(2)")!);
    expect(useUi.getState().picker?.items.map((item) => item.id)).toEqual(["Daily/Today.md", "Other.md"]);
    await act(async () => useUi.getState().picker?.onPick(useUi.getState().picker!.items[0]));
    expect(api.tesseraTestEvent).toHaveBeenCalledWith("paused", "Daily/Today.md");

    const queuedCard = screen.getByText("Agent queued").closest("article")!;
    fireEvent.click(queuedCard.querySelector<HTMLButtonElement>("footer button:nth-child(2)")!);
    await waitFor(() => expect(api.tesseraPauseAgent).toHaveBeenCalled());

    const more = screen.getByRole("button", { name: "More actions for Agent ready" });
    vi.spyOn(more, "getBoundingClientRect").mockReturnValue({ left: 10, bottom: 20 } as DOMRect);
    fireEvent.click(more);
    const menu = useUi.getState().menu!;
    expect(menu.x).toBe(10);
    menu.items.find((item) => item.label === "Edit workflow")?.action?.();
    await menu.items.find((item) => item.label === "Edit agent source")?.action?.();
    await menu.items.find((item) => item.label === "Delete workflow…")?.action?.();
    await waitFor(() => expect(useVault.getState().remove).toHaveBeenCalledWith("Agents/ready.md"));
  });

  it("covers named, runs-only, agents-only, paused and empty layouts", () => {
    const { rerender } = render(<Workflows name="successful" />);
    expect(screen.getByRole("heading", { name: "Agent successful" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit workflow" }));
    expect(screen.getByRole("heading", { name: "Edit workflow" })).toBeTruthy();
    rerender(<Workflows runsOnly />);
    expect(screen.queryByText("Create workflow")).toBeNull();
    rerender(<Workflows agentsOnly />);
    expect(screen.queryByText("Recent runs")).toBeNull();
    useAttention.setState({ status: { ...status, paused: true }, agents: [] });
    rerender(<Workflows />);
    expect(screen.getByText("All automatic workflows are paused.", { exact: false })).toBeTruthy();
    expect(screen.getByText("No workflows yet.", { exact: false })).toBeTruthy();
  });
});

describe("workflow form", () => {
  it("validates a new workflow and saves all trigger and safety options", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "create").mockResolvedValue({ path: "Agents/New workflow.md", hash: "hash", review: null });
    useAttention.setState({
      agents: [],
      refresh: vi.fn().mockImplementation(async () => {
        useAttention.setState({
          agents: [agent("new-workflow", { title: "New workflow", path: "Agents/New workflow.md" })],
        });
      }),
    });
    render(<WorkflowForm />);
    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toContain("Describe what the agent should do.");
    await user.type(screen.getByLabelText("Name"), "New workflow");
    await user.type(screen.getByLabelText("Instructions"), "Summarize the project");
    fireEvent.change(screen.getByLabelText("Review behavior"), { target: { value: "folders" } });
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toContain("Choose at least one folder");
    fireEvent.click(screen.getByRole("button", { name: "Choose May change without review" }));
    fireEvent.click(screen.getByLabelText("Run on a schedule"));
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "every" } });
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "4" } });
    fireEvent.click(screen.getByLabelText("Run when a Markdown note is created"));
    fireEvent.click(screen.getByRole("button", { name: "Choose Event folders" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "sonnet" } });
    fireEvent.click(screen.getByLabelText("Can use the web (search and fetch pages)"));
    fireEvent.submit(form);
    await waitFor(() => expect(api.create).toHaveBeenCalled());
    const content = vi.mocked(api.create).mock.calls[0][1];
    expect(content).toContain("schedule: every 4h");
    expect(content).toContain("created in /");
    expect(content).toContain("may-change:");
    expect(content).toContain("web: true");
  });

  it("loads and updates an existing workflow with custom source settings", async () => {
    const custom = agent("custom", {
      schedule: "0 9 * * 1",
      on: ["tagged #ready", "created in Projects/"],
      model: "future-model",
      may_change: ["Projects"],
      web: true,
    });
    useAttention.setState({ agents: [custom], refresh: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "read").mockResolvedValue({
      path: custom.path,
      kind: "markdown",
      size: 10,
      mtime: 1,
      hash: "old",
      content: "---\nname: custom\n---\nBody",
      review: null,
    });
    vi.spyOn(api, "write").mockResolvedValue({ path: custom.path, hash: "new", review: null });
    const done = vi.fn();
    render(<WorkflowForm agent={custom} onDone={done} />);
    await waitFor(() => expect(api.read).toHaveBeenCalled());
    expect(screen.getByText("Custom events preserved:", { exact: false })).toBeTruthy();
    expect(screen.getByText("Custom schedule preserved:", { exact: false })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Updated instructions" } });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(api.write).toHaveBeenCalled());
    expect(done).toHaveBeenCalled();
  });
});
