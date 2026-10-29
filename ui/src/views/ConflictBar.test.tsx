// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { useWorkspace, type Buffer } from "../state/workspace";
import { api } from "../ipc/api";
import { ConflictBar } from "./ConflictBar";

const buffer = (overrides: Partial<Buffer> = {}): Buffer => ({
  path: "Ideas.md",
  kind: "markdown",
  content: "# Ideas\n\nMine",
  baseHash: "base",
  dirty: true,
  conflict: { diskHash: "disk" },
  deleted: false,
  error: null,
  version: 1,
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("offers explicit choices for an edit conflict", async () => {
  const user = userEvent.setup();
  const workspace = useWorkspace.getState();
  const reload = vi.spyOn(workspace, "reload").mockResolvedValue();
  const keepMine = vi.spyOn(workspace, "keepMine").mockResolvedValue();
  render(<ConflictBar buffer={buffer()} />);

  expect(screen.getByRole("alert").textContent).toContain("changed on disk");
  await user.click(screen.getByRole("button", { name: "Load disk version" }));
  expect(reload).toHaveBeenCalledWith("Ideas.md");
  await user.click(screen.getByRole("button", { name: "Keep mine" }));
  expect(keepMine).toHaveBeenCalledWith("Ideas.md");
});

test("distinguishes deletion and save failures", async () => {
  const user = userEvent.setup();
  const workspace = useWorkspace.getState();
  const discard = vi.spyOn(workspace, "discardDeleted").mockImplementation(() => {});
  const save = vi.spyOn(workspace, "save").mockResolvedValue();
  const view = render(<ConflictBar buffer={buffer({ conflict: null, deleted: true })} />);

  expect(screen.getByRole("alert").textContent).toContain("deleted on disk");
  await user.click(screen.getByRole("button", { name: "Discard" }));
  expect(discard).toHaveBeenCalledWith("Ideas.md");

  view.rerender(<ConflictBar buffer={buffer({ conflict: null, dirty: false, error: "disk is full" })} />);
  expect(screen.getByRole("alert").textContent).toContain("disk is full");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(save).toHaveBeenCalledWith("Ideas.md");
});

test("failed comparisons are explicit and can be retried without losing the draft", async () => {
  vi.spyOn(api, "read")
    .mockRejectedValueOnce(new Error("read unavailable"))
    .mockResolvedValueOnce({ content: "Disk text", hash: "disk" } as Awaited<ReturnType<typeof api.read>>);
  render(<ConflictBar buffer={buffer()} />);
  await userEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(await screen.findByText("Couldn't compare this file: read unavailable")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep mine" })).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "Retry comparison" }));
  expect(await screen.findByText("Disk text")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep mine" })).toHaveProperty("disabled", false);
});
test("pending resolutions disable duplicate actions and failed writes retain the notice", async () => {
  let fail!: (error: Error) => void;
  const keep = vi.spyOn(useWorkspace.getState(), "keepMine").mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const draft = buffer();
  render(<ConflictBar buffer={draft} />);
  fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
  expect(keep).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Compare" })).toHaveProperty("disabled", true);
  await act(async () => fail(new Error("write unavailable")));
  expect(await screen.findByText("write unavailable")).toBeTruthy();
  expect(draft.content).toBe("# Ideas\n\nMine");
});
