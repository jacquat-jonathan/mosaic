// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { DEFAULT_PREFS, useSettings } from "./settings";
import { checkForUpdates, startAutomaticUpdates, useUpdateFlow } from "./updates";

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  useSettings.setState({ ...DEFAULT_PREFS });
  useUpdateFlow.setState({ phase: "idle", check: null, checking: false, checkError: null, error: null, log: [] });
  vi.spyOn(api, "updateStatus").mockResolvedValue({
    version: "0.27.0",
    commit: "",
    app_path: "/Applications/Mosaic.app",
    running: false,
    ready_to_install: false,
    last_install_error: null,
  });
  vi.spyOn(api, "checkUpdates").mockResolvedValue({ update_available: true, latest_version: "0.28.0", releases: [] });
  vi.spyOn(api, "startUpdate").mockResolvedValue(null);
  vi.spyOn(api, "finishUpdate").mockResolvedValue(null);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("checks at launch and daily, downloading only with explicit opt-in and never installing", async () => {
  stop = startAutomaticUpdates();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.checkUpdates).toHaveBeenCalledTimes(1);
  expect(api.startUpdate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
  expect(api.checkUpdates).toHaveBeenCalledTimes(1);
  useSettings.setState({ autoDownloadUpdates: true });
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(api.checkUpdates).toHaveBeenCalledTimes(2);
  expect(api.startUpdate).toHaveBeenCalledTimes(1);
  expect(api.finishUpdate).not.toHaveBeenCalled();
});

test("disabled checks and development builds make no update requests", async () => {
  useSettings.setState({ autoCheckUpdates: false });
  stop = startAutomaticUpdates();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.updateStatus).not.toHaveBeenCalled();
  vi.mocked(api.updateStatus).mockResolvedValue({
    version: "dev",
    commit: "",
    app_path: null,
    running: false,
    ready_to_install: false,
    last_install_error: null,
  });
  useSettings.setState({ autoCheckUpdates: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(api.checkUpdates).not.toHaveBeenCalled();
});

test("disabling or stopping during a check prevents background downloading", async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.checkUpdates>>) => void;
  vi.mocked(api.checkUpdates).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useSettings.setState({ autoDownloadUpdates: true });
  stop = startAutomaticUpdates();
  await vi.advanceTimersByTimeAsync(0);
  const manual = checkForUpdates();
  expect(api.checkUpdates).toHaveBeenCalledTimes(1);
  useSettings.setState({ autoCheckUpdates: false });
  stop();
  finish({ update_available: true, latest_version: "0.28.0", releases: [] });
  await manual;
  await vi.advanceTimersByTimeAsync(0);
  expect(api.startUpdate).not.toHaveBeenCalled();
});

test("failed checks are visible and retryable without duplicate requests", async () => {
  vi.mocked(api.checkUpdates).mockRejectedValueOnce(new Error("Offline"));
  await checkForUpdates();
  expect(useUpdateFlow.getState().checkError).toBe("Offline");
  await checkForUpdates();
  expect(useUpdateFlow.getState().checkError).toBeNull();
  expect(useUpdateFlow.getState().check?.update_available).toBe(true);
});
