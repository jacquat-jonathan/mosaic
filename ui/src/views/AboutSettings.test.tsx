// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { UpdateStatus } from "../ipc/types";
import { registerDraft } from "../state/drafts";
import { useUpdateFlow } from "../state/updates";
import { useWorkspace } from "../state/workspace";
import { AboutSettings } from "./AboutSettings";

const status: UpdateStatus = {
  version: "0.1.0",
  commit: "commit",
  app_path: "/Applications/Mosaic.app",
  running: false,
  ready_to_install: false,
  last_install_error: null,
};
beforeEach(() => {
  useUpdateFlow.setState({ log: [], phase: "idle", error: null });
  useWorkspace.setState({ buffers: {} });
  vi.spyOn(api, "updateStatus").mockResolvedValue(status);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("status and check failures are announced and can be retried", async () => {
  const user = userEvent.setup();
  vi.mocked(api.updateStatus).mockRejectedValueOnce(new Error("Status unavailable"));
  vi.spyOn(api, "checkUpdates")
    .mockRejectedValueOnce(new Error("Check unavailable"))
    .mockResolvedValue({ latest_version: null, releases: [], update_available: false });
  render(<AboutSettings />);
  await user.click(await screen.findByRole("button", { name: "Retry update status" }));
  const check = await screen.findByRole("button", { name: "Check for updates" });
  await user.click(check);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Check unavailable");
  expect(screen.getByRole("button", { name: "Download update" })).toHaveProperty("disabled", true);
  await user.click(check);
  await screen.findByText("No complete signed downloadable release is available yet.");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("restart waits for draft decisions and cannot be started twice", async () => {
  const user = userEvent.setup();
  vi.mocked(api.updateStatus).mockResolvedValue({ ...status, ready_to_install: true });
  const finish = vi.spyOn(api, "finishUpdate").mockResolvedValue(null);
  let decide!: (accepted: boolean) => void;
  const guard = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        decide = resolve;
      }),
  );
  const unregister = registerDraft("mosaic:test-update-draft", guard);
  try {
    render(<AboutSettings />);
    await user.click(await screen.findByRole("button", { name: "Restart to finish" }));
    const preparing = screen.getByRole("button", { name: "Preparing restart…" });
    expect(preparing).toHaveProperty("disabled", true);
    await user.click(preparing);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    await act(async () => decide(false));
    expect(await screen.findByRole("button", { name: "Restart to finish" })).toHaveProperty("disabled", false);
    expect(finish).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

test("failed installation keeps the ready state and offers a retry", async () => {
  const user = userEvent.setup();
  vi.mocked(api.updateStatus).mockResolvedValue({ ...status, ready_to_install: true });
  const finish = vi
    .spyOn(api, "finishUpdate")
    .mockRejectedValueOnce(new Error("Install refused"))
    .mockResolvedValue(null);
  render(<AboutSettings />);
  await user.click(await screen.findByRole("button", { name: "Restart to finish" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Install refused");
  expect(useUpdateFlow.getState().phase).toBe("built");
  await user.click(screen.getByRole("button", { name: "Restart to finish" }));
  expect(finish).toHaveBeenCalledTimes(2);
});
