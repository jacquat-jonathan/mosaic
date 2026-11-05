// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  runDuration,
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
      title: "Completed",
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
  it("returns focus between detail, edit, and cancelled draft confirmation", async () => {
    const user = userEvent.setup();
    const selected = agents.find((entry) => entry.name === "successful")!;
    vi.spyOn(api, "read").mockResolvedValue({
      path: selected.path,
      kind: "markdown",
      size: 10,
      mtime: 1,
      hash: "hash",
      content: "---\nname: successful\n---\nBody",
      review: null,
    });
    vi.mocked(useUi.getState().ask).mockResolvedValueOnce(false);
    render(<Workflows name="successful" />);
    await user.click(screen.getByRole("button", { name: "Edit workflow" }));
    const instructions = screen.getByLabelText("Instructions");
    expect(document.activeElement).toBe(instructions);
    await user.type(instructions, " changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Instructions")).toHaveProperty("value", `${selected.instructions} changed`);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit workflow" })));
  });

  it("shows an unavailable workflow with a route back to the list", () => {
    render(<Workflows name="missing" />);
    expect(screen.getByRole("heading", { name: "Workflow unavailable" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit workflow" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Back to workflows" }));
    expect(useUi.getState().openView).toHaveBeenCalledWith("workflows");
  });

  it("announces source-opening failures in the workflow context", async () => {
    vi.mocked(useWorkspace.getState().open).mockRejectedValueOnce(new Error("Source unavailable"));
    render(<WorkflowContext name="ready" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Source unavailable");
  });

  it("describes all run states and frontmatter shapes", () => {
    expect(runState(run(1, "a", "running"))).toBe("Running");
    expect(runState(run(1, "a", "failed"))).toBe("Failed");
    expect(runState(run(1, "a", "skipped"))).toBe("Skipped");
    expect(runState(run(1, "a", "successful"), true)).toBe("Needs review");
    expect(runState(run(1, "a", "successful"))).toBe("Completed");
    expect(runDuration(run(1, "a", "running"))).toBe("In progress");
    expect(runDuration(run(1, "a", "skipped", { finished: null }))).toBe("—");
    expect(runDuration(run(1, "a", "successful", { started: 10, finished: 52 }))).toBe("42s");
    expect(runDuration(run(1, "a", "successful", { started: 10, finished: 82 }))).toBe("1m 12s");
    expect(runDuration(run(1, "a", "successful", { started: 10, finished: 3730 }))).toBe("1h 2m");
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
  it("serializes mutations and ignores a run result after the vault changes", async () => {
    let finish!: (id: number) => void;
    vi.mocked(api.tesseraRun).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Workflows />);
    const card = screen.getByRole("article", { name: "Agent ready" });
    fireEvent.click(within(card).getByRole("button", { name: "Run now" }));
    expect(screen.getByRole("button", { name: "Pause automations" })).toHaveProperty("disabled", true);
    act(() => useVault.setState({ vault: { root: "/other", name: "Other" } }));
    await act(async () => finish(99));
    expect(useUi.getState().openView).not.toHaveBeenCalledWith("run", "99");
  });

  it("ignores stale test-trigger selections and deletion confirmations", async () => {
    render(<Workflows />);
    const card = screen.getByRole("article", { name: "Agent paused" });
    fireEvent.click(within(card).getByRole("button", { name: "Test trigger…" }));
    const picker = useUi.getState().picker!;
    act(() => useVault.setState({ vault: { root: "/other", name: "Other" } }));
    await act(async () => picker.onPick(picker.items[0]));
    expect(api.tesseraTestEvent).not.toHaveBeenCalled();
    act(() => {
      useUi.setState({ picker: null });
      useVault.setState({ vault: { root: "/vault", name: "Vault" } });
    });
    let confirm!: (accepted: boolean) => void;
    vi.mocked(useUi.getState().ask).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions for Agent ready" }));
    const menu = useUi.getState().menu!;
    act(() => {
      void menu.items.find((item) => item.label === "Delete workflow…")?.action?.();
    });
    act(() => useVault.setState({ vault: { root: "/other", name: "Other" } }));
    await act(async () => confirm(true));
    expect(useVault.getState().remove).not.toHaveBeenCalled();
  });

  it("selects the newest result even when history arrives out of order", () => {
    useAttention.setState({
      status: {
        ...status,
        runs: [
          run(1, "ready", "successful", { started: 10, answer: "Old result" }),
          run(2, "ready", "failed", { started: 20, error: "Newest result" }),
        ],
      },
    });
    render(<Workflows agentsOnly />);
    const card = screen.getByRole("article", { name: "Agent ready" });
    expect(within(card).getByText("Newest result")).toBeTruthy();
    expect(within(card).queryByText("Old result")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Open run log" }));
    expect(useUi.getState().openView).toHaveBeenCalledWith("run", "2");
  });

  it("rechecks running state before deleting after confirmation", async () => {
    let confirm!: (accepted: boolean) => void;
    vi.mocked(useUi.getState().ask).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    render(<Workflows />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Agent ready" }));
    act(() => {
      void useUi
        .getState()
        .menu!.items.find((item) => item.label === "Delete workflow…")
        ?.action?.();
    });
    act(() => useAttention.setState({ status: { ...status, runs: [...runs, run(10, "ready", "running")] } }));
    await act(async () => confirm(true));
    expect(useVault.getState().remove).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Wait for the current run to finish")),
    ).toBe(true);
  });

  it("streams run answers and tool outcomes, retaining readable older results", async () => {
    const events: NonNullable<AgentRun["transcript"]>["events"] = [
      { kind: "text", text: "Reading **the note**." },
      { kind: "tool", id: "read", summary: "Read Other", path: "Other.md", writes: false },
    ];
    useAttention.setState({
      status: { ...status, runs: [run(77, "ready", "running", { transcript: { events, truncated: false } })] },
    });
    const { rerender } = render(<RunDetail id="77" />);
    expect(screen.getByText("the note").tagName).toBe("STRONG");
    fireEvent.click(screen.getByText("Read Other"));
    fireEvent.click(screen.getByRole("button", { name: "Open Other.md" }));
    expect(useWorkspace.getState().open).toHaveBeenCalledWith("Other.md", { newTab: true });
    act(() =>
      useAttention.setState({
        status: {
          ...status,
          runs: [
            run(77, "ready", "failed", {
              transcript: {
                truncated: true,
                events: [
                  ...events,
                  { kind: "tool_done", id: "read", error: "Permission denied", review: null },
                  { kind: "tool", id: "write", summary: "Proposed Other", path: "Other.md", writes: true },
                  { kind: "tool_done", id: "write", error: null, review: 9 },
                  { kind: "done", session_id: null, cost_usd: null, error: "Workflow stopped" },
                ],
              },
            }),
          ],
        },
      }),
    );
    expect(screen.getByText("Permission denied")).toBeTruthy();
    fireEvent.click(screen.getByText("Proposed Other"));
    expect(screen.getByText("Workflow stopped")).toBeTruthy();
    expect(screen.getByText(/log was shortened/)).toBeTruthy();
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.getByRole("button", { name: "proposed — review" })).toBeTruthy();
    act(() => useAttention.setState({ status }));
    rerender(<RunDetail id="3" />);
    expect(screen.getByText("Finished", { selector: "p" })).toBeTruthy();
  });

  it("follows new run output only while the reader remains near the bottom", () => {
    const current = run(77, "ready", "running", {
      transcript: { events: [{ kind: "text", text: "First" }], truncated: false },
    });
    useAttention.setState({ status: { ...status, runs: [current] } });
    render(<RunDetail id="77" />);
    const log = screen.getByRole("region", { name: "Run log" });
    let height = 300;
    Object.defineProperties(log, { scrollHeight: { get: () => height }, clientHeight: { value: 100 } });
    log.scrollTop = 200;
    fireEvent.scroll(log);
    const append = (text: string) =>
      act(() =>
        useAttention.setState({
          status: {
            ...status,
            runs: [{ ...current, transcript: { events: [{ kind: "text", text }], truncated: false } }],
          },
        }),
      );
    height = 500;
    append("Second");
    expect(log.scrollTop).toBe(500);
    log.scrollTop = 0;
    fireEvent.scroll(log);
    height = 700;
    append("Third");
    expect(log.scrollTop).toBe(0);
    log.scrollTop = 600;
    fireEvent.scroll(log);
    height = 900;
    append("Fourth");
    expect(log.scrollTop).toBe(900);
  });

  it("keeps changed-file failures visible and preserves review navigation", async () => {
    vi.mocked(useWorkspace.getState().open).mockRejectedValueOnce(new Error("File unavailable"));
    render(<RunDetail id="1" compact />);
    fireEvent.click(screen.getByText("Changed files"));
    fireEvent.click(screen.getByRole("button", { name: "Notes/Changed.md" }));
    expect((await screen.findByRole("alert")).textContent).toBe("File unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Open activity and reviews" }));
    expect(useUi.getState().openView).toHaveBeenCalledWith("activity");
  });

  it("renders every state and runs, pauses, tests and opens menu actions", async () => {
    render(<Workflows />);
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("Queued runs")).toBeTruthy();
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Scheduler error").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Pause automations" }));
    await waitFor(() => expect(api.tesseraPauseAll).toHaveBeenCalledWith(true));
    const readyCard = screen.getByText("Agent ready").closest("article")!;
    fireEvent.click(within(readyCard).getByRole("button", { name: "Run now" }));
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
    await waitFor(() => expect((more as HTMLButtonElement).disabled).toBe(false));
    vi.spyOn(more, "getBoundingClientRect").mockReturnValue({ left: 10, bottom: 20 } as DOMRect);
    fireEvent.click(more);
    const menu = useUi.getState().menu!;
    expect(menu.x).toBe(10);
    menu.items.find((item) => item.label === "Edit workflow")?.action?.();
    await menu.items.find((item) => item.label === "Edit agent source")?.action?.();
    await menu.items.find((item) => item.label === "Delete workflow…")?.action?.();
    await waitFor(() => expect(useVault.getState().remove).toHaveBeenCalledWith("Agents/ready.md"));
  });

  it("preserves all eight ledger states, tool warnings, errors, and named filtering", () => {
    const states = ["ready", "queued", "running", "paused", "successful", "needs-review", "failed", "skipped"];
    useAttention.setState({
      status: {
        ...status,
        runs: states.map((state, index) =>
          run(index + 1, index === 6 ? "broken" : "ready", state, {
            started: 100,
            transcript:
              index === 6
                ? {
                    truncated: false,
                    events: [
                      { kind: "tool", id: "read", summary: "Read", path: "Other.md", writes: false },
                      { kind: "tool_done", id: "read", error: "Denied", review: null },
                    ],
                  }
                : undefined,
          }),
        ),
      },
    });
    const { rerender } = render(<Workflows runsOnly />);
    const rows = screen.getByRole("table", { name: "Workflow runs" }).querySelectorAll("tbody tr");
    expect(Array.from(rows).map((row) => row.querySelector(".mds-status")?.textContent)).toEqual([
      "Skipped",
      "Failed",
      "Needs review",
      "Completed",
      "Paused",
      "Running",
      "Queued",
      "Ready",
    ]);
    const failed = screen.getByRole("button", { name: "Run 7" }).closest("tr")!;
    expect(failed.textContent).toContain("1 tool warning · Something failed");
    expect(screen.getByRole("button", { name: "Run 7" }).hasAttribute("aria-expanded")).toBe(false);
    rerender(<Workflows runsOnly name="broken" />);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Run 7" })).toBeTruthy();
  });

  it("distinguishes loading, failed, empty and retained run history", () => {
    useAttention.setState({ status: null, error: null });
    render(<Workflows runsOnly />);
    expect(screen.getByRole("region", { name: "Run history" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading runs…")).toBeTruthy();
    act(() => useAttention.setState({ error: "History unavailable" }));
    expect(screen.getByRole("alert").textContent).toBe("History unavailable");
    expect(screen.getByText("Run history could not be loaded.")).toBeTruthy();
    act(() => useAttention.setState({ status: { ...status, runs: [] }, error: null }));
    expect(screen.getByText("No runs yet. Run a workflow to see its history here.")).toBeTruthy();
    act(() => useAttention.setState({ status, error: "Refresh failed" }));
    expect(screen.getByRole("alert").textContent).toBe("Refresh failed");
    expect(screen.getByRole("button", { name: "Run 5" })).toBeTruthy();
  });

  it("orders the Ledger by newest run and updates review status after a decision", () => {
    render(<Workflows runsOnly />);
    const rows = screen.getByRole("table", { name: "Workflow runs" }).querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("Run 5");
    const reviewRow = screen.getByRole("button", { name: "Run 2" }).closest("tr")!;
    expect(reviewRow.textContent).toContain("Needs review");
    expect(reviewRow.textContent).toContain("1 pending change");
    fireEvent.click(screen.getByRole("button", { name: "Run 2" }));
    expect(useUi.getState().openView).toHaveBeenCalledWith("run", "2");
    act(() => useReview.setState({ pending: [] }));
    expect(reviewRow.textContent).toContain("Completed");
    expect(reviewRow.textContent).not.toContain("pending change");
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
