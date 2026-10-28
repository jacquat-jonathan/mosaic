// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { useWorkspace, type Buffer } from "../state/workspace";
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
  const discard = vi.spyOn(workspace, "deleted").mockImplementation(() => {});
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
