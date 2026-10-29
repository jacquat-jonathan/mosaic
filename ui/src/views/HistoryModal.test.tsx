// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  useVault.setState({ revision: 0, vault: { root: "/vault", name: "Vault" } });
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
  expect(await screen.findByText("new")).toBeTruthy();
  expect(screen.getByRole("option", { name: /moved from/i })).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: /Restore this version/ }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("Notes/Plan.md", 2, "current"));
  await userEvent.keyboard("{Escape}");
  expect(useUi.getState().history).toBeNull();
});

test("shows empty history and handles missing current files and load errors", async () => {
  vi.spyOn(api, "fileHistory").mockResolvedValueOnce([]);
  vi.spyOn(api, "read").mockRejectedValueOnce({ code: "not_found", message: "missing" });
  vi.spyOn(api, "versionContent").mockResolvedValue("");
  const view = render(<HistoryModal />);
  expect(await screen.findByText(/No versions yet/)).toBeTruthy();
  view.unmount();

  vi.restoreAllMocks();
  useUi.setState({ history: { path: "Notes/Plan.md", focus: 2 } });
  vi.spyOn(api, "fileHistory").mockResolvedValue(versions);
  vi.spyOn(api, "read").mockRejectedValue({ code: "not_found", message: "missing" });
  vi.spyOn(api, "versionContent").mockRejectedValue(new Error("history unavailable"));
  render(<HistoryModal />);
  expect(await screen.findByText("history unavailable")).toBeTruthy();
});

test("keyboard selection ignores a late response from the previous version", async () => {
  const third = { ...versions[0], id: 3, actor: "Version three" };
  vi.spyOn(api, "fileHistory").mockResolvedValue([versions[0], third]);
  vi.spyOn(api, "read").mockResolvedValue({
    path: "Notes/Plan.md",
    content: "current",
    hash: "current",
    kind: "markdown",
    size: 1,
    mtime: 1,
  });
  let finish!: (text: string) => void;
  vi.spyOn(api, "versionContent").mockImplementation((id) =>
    id === 2
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve("third version"),
  );
  render(<HistoryModal />);
  const first = await screen.findByRole("option", { name: /claude-code/ });
  await waitFor(() => expect(api.versionContent).toHaveBeenCalledWith(2));
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Version three/ }).getAttribute("aria-selected")).toBe("true");
  expect(await screen.findByText("third version")).toBeTruthy();
  await act(async () => finish("stale second version"));
  expect(screen.queryByText("stale second version")).toBeNull();
});

test("keeps unread files distinct from missing files and retries their hash", async () => {
  vi.spyOn(api, "fileHistory").mockResolvedValue(versions);
  vi.spyOn(api, "versionContent").mockResolvedValue("old version");
  vi.spyOn(api, "read").mockRejectedValueOnce(new Error("Read denied")).mockResolvedValue({
    path: "Notes/Plan.md",
    content: "current",
    hash: "new hash",
    kind: "markdown",
    size: 1,
    mtime: 1,
  });
  vi.spyOn(api, "restoreVersion").mockResolvedValue({ path: "Notes/Plan.md", hash: "restored", review: null });
  render(<HistoryModal />);
  expect(await screen.findByText("Read denied")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restore this version" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry current file" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Restore this version" })).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
  await waitFor(() => expect(api.restoreVersion).toHaveBeenCalledWith("Notes/Plan.md", 2, "new hash"));
});

test("locks a pending restore and closes history when its vault changes", async () => {
  vi.spyOn(api, "fileHistory").mockResolvedValue(versions);
  vi.spyOn(api, "read").mockResolvedValue({
    path: "Notes/Plan.md",
    content: "current",
    hash: "current",
    kind: "markdown",
    size: 1,
    mtime: 1,
  });
  vi.spyOn(api, "versionContent").mockResolvedValue("old");
  let finish!: () => void;
  vi.spyOn(api, "restoreVersion").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ path: "Notes/Plan.md", hash: "restored", review: null });
      }),
  );
  render(<HistoryModal />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Restore this version" })).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
  expect(screen.getByRole("button", { name: "Restoring…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Close dialog" })).toHaveProperty("disabled", true);
  await userEvent.keyboard("{Escape}");
  expect(useUi.getState().history).not.toBeNull();
  act(() => useVault.setState({ vault: { root: "/other", name: "Other" } }));
  await waitFor(() => expect(useUi.getState().history).toBeNull());
  await act(async () => finish());
  expect(api.restoreVersion).toHaveBeenCalledTimes(1);
});
