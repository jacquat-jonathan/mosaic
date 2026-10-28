// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { Version } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { HistoryModal } from "./HistoryModal";

const versions: Version[] = [
  {
    id: 2,
    path: "Notes/Plan.md",
    time: Date.now() - 1_000,
    source: "agent",
    actor: "claude-code",
    action: "edited",
    hash: "old",
    size: 12,
    from_path: null,
  },
  {
    id: 1,
    path: "Notes/Plan.md",
    time: Date.now() - 2_000,
    source: "user",
    actor: null,
    action: "renamed",
    hash: "",
    size: 0,
    from_path: "Notes/Old.md",
  },
];

beforeEach(() => {
  useUi.setState({ history: { path: "Notes/Plan.md", focus: 2 } });
  useVault.setState({ revision: 0 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("loads, compares and restores a historical version", async () => {
  vi.spyOn(api, "fileHistory").mockResolvedValue(versions);
  vi.spyOn(api, "read").mockResolvedValue({
    path: "Notes/Plan.md",
    kind: "markdown",
    size: 9,
    mtime: 1,
    content: "new\nline\n",
    hash: "current",
  });
  vi.spyOn(api, "versionContent").mockResolvedValue("old\nline\n");
  const restore = vi
    .spyOn(api, "restoreVersion")
    .mockResolvedValue({ path: "Notes/Plan.md", hash: "restored", review: null });
  render(<HistoryModal />);

  expect(await screen.findByRole("dialog", { name: "History of Plan" })).toBeTruthy();
  expect(await screen.findByText(/red lines would come back/)).toBeTruthy();
  expect(screen.getByText("new")).toBeTruthy();
  expect(screen.getByRole("option", { name: /moved from/i })).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: /Restore this version/ }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("Notes/Plan.md", 2, "current"));
  await userEvent.keyboard("{Escape}");
  expect(useUi.getState().history).toBeNull();
});

test("shows empty history and handles missing current files and load errors", async () => {
  vi.spyOn(api, "fileHistory").mockResolvedValueOnce([]);
  vi.spyOn(api, "read").mockRejectedValueOnce(new Error("missing"));
  vi.spyOn(api, "versionContent").mockResolvedValue("");
  const view = render(<HistoryModal />);
  expect(await screen.findByText(/No versions yet/)).toBeTruthy();
  view.unmount();

  vi.restoreAllMocks();
  useUi.setState({ history: { path: "Notes/Plan.md", focus: 2 } });
  vi.spyOn(api, "fileHistory").mockResolvedValue(versions);
  vi.spyOn(api, "read").mockRejectedValue(new Error("missing"));
  vi.spyOn(api, "versionContent").mockRejectedValue(new Error("history unavailable"));
  render(<HistoryModal />);
  expect(await screen.findByText("history unavailable")).toBeTruthy();
});
