// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import { useUi } from "../../state/ui";
import { useVault } from "../../state/vault";
import { PlannerUnavailable } from "./PlannerUnavailable";

beforeEach(() =>
  useVault.setState({
    vault: {
      root: "/vault",
      name: "Vault",
      planner_unavailable: {
        code: "planner_corrupt",
        message: "Database damaged",
        can_restore: true,
      },
    },
  }),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("declining recovery leaves notes and damaged data alone", async () => {
  vi.spyOn(useUi.getState(), "ask").mockResolvedValue(false);
  const restore = vi.spyOn(api, "restorePlannerBackup");
  const open = vi.spyOn(useVault.getState(), "openVault");
  render(<PlannerUnavailable />);
  fireEvent.click(screen.getByRole("button", { name: "Restore planner backup" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry planner" })).toHaveProperty("disabled", false));
  expect(restore).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByText(/Your notes remain available/)).toBeTruthy();
});

test("explicit recovery restores before reopening while preserving the workspace", async () => {
  vi.spyOn(useUi.getState(), "ask").mockResolvedValue(true);
  const restore = vi.spyOn(api, "restorePlannerBackup").mockResolvedValue("preserved.sqlite3");
  const open = vi.spyOn(useVault.getState(), "openVault").mockResolvedValue();
  render(<PlannerUnavailable />);
  fireEvent.click(screen.getByRole("button", { name: "Restore planner backup" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("/vault", { preserveWorkspace: true }));
  expect(restore).toHaveBeenCalledExactlyOnceWith("/vault");
  expect(restore.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
});

test("failed restore remains visible and never reopens or hides notes", async () => {
  vi.spyOn(useUi.getState(), "ask").mockResolvedValue(true);
  vi.spyOn(api, "restorePlannerBackup").mockRejectedValue(new Error("Backup unavailable"));
  const open = vi.spyOn(useVault.getState(), "openVault");
  render(<PlannerUnavailable />);
  fireEvent.click(screen.getByRole("button", { name: "Restore planner backup" }));
  expect(await screen.findByText("Backup unavailable")).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
});

test("confirmation from a previous vault cannot restore it after switching", async () => {
  let confirm!: (value: boolean) => void;
  vi.spyOn(useUi.getState(), "ask").mockImplementation(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  const restore = vi.spyOn(api, "restorePlannerBackup");
  render(<PlannerUnavailable />);
  fireEvent.click(screen.getByRole("button", { name: "Restore planner backup" }));
  await act(async () => {
    useVault.setState({ vault: { root: "/other", name: "Other" } });
    confirm(true);
  });
  expect(restore).not.toHaveBeenCalled();
});

test("newer schema offers retry but never backup rollback", () => {
  useVault.setState({
    vault: {
      root: "/vault",
      name: "Vault",
      planner_unavailable: {
        code: "planner_newer_schema",
        message: "New schema",
        can_restore: false,
      },
    },
  });
  render(<PlannerUnavailable />);
  expect(screen.queryByRole("button", { name: "Restore planner backup" })).toBeNull();
  expect(screen.getByText(/newer version of Mosaic/)).toBeTruthy();
});

test("retry reopens in place without restoring or asking for a destructive action", async () => {
  const ask = vi.spyOn(useUi.getState(), "ask");
  const restore = vi.spyOn(api, "restorePlannerBackup");
  const open = vi.spyOn(useVault.getState(), "openVault").mockResolvedValue();
  render(<PlannerUnavailable />);
  fireEvent.click(screen.getByRole("button", { name: "Retry planner" }));
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("/vault", { preserveWorkspace: true }));
  expect(ask).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
});
