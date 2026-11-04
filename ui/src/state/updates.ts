import { create } from "zustand";
import { api, onUpdateDone, onUpdateLog } from "../ipc/api";

import type { UpdateCheck } from "../ipc/types";
import { errorMessage } from "../ipc/types";
import { useSettings } from "./settings";

interface UpdateFlow {
  check: UpdateCheck | null;
  checking: boolean;
  checkError: string | null;
  log: string[];
  phase: "idle" | "running" | "built" | "failed" | "cancelled";
  error: string | null;
}
/** Progress outlives Settings, so closing the panel keeps the update and its log. */
export const useUpdateFlow = create<UpdateFlow>(() => ({
  log: [],
  phase: "idle",
  error: null,
  check: null,
  checking: false,
  checkError: null,
}));
const LOG_LIMIT = 2000;
export async function startUpdateListeners(): Promise<() => void> {
  const offLog = await onUpdateLog((line) =>
    useUpdateFlow.setState((state) => ({
      log: state.log.length >= LOG_LIMIT ? [...state.log.slice(-LOG_LIMIT + 1), line] : [...state.log, line],
    })),
  );
  const offDone = await onUpdateDone((done) =>
    useUpdateFlow.setState(
      done.ok
        ? { phase: "built", error: null }
        : done.cancelled
          ? { phase: "cancelled", error: null }
          : { phase: "failed", error: done.error },
    ),
  );
  return () => {
    offLog();
    offDone();
  };
}

let checkRequest: Promise<void> | null = null;
/** Manual and automatic checks share one request and one visible result. */
export function checkForUpdates(): Promise<void> {
  if (checkRequest) return checkRequest;
  useUpdateFlow.setState({ checking: true, checkError: null });
  checkRequest = (async () => {
    try {
      useUpdateFlow.setState({ check: await api.checkUpdates() });
    } catch (cause) {
      useUpdateFlow.setState({ check: null, checkError: errorMessage(cause) });
    } finally {
      useUpdateFlow.setState({ checking: false });
      checkRequest = null;
    }
  })();
  return checkRequest;
}

export async function downloadUpdate() {
  if (["running", "built"].includes(useUpdateFlow.getState().phase)) return;
  useUpdateFlow.setState({ log: [], phase: "running", error: null });
  try {
    await api.startUpdate();
  } catch (cause) {
    useUpdateFlow.setState({ phase: "failed", error: errorMessage(cause) });
  }
}

/** Check on launch and daily while open; downloading is a separate opt-in. Never installs. */
export function startAutomaticUpdates(): () => void {
  let stopped = false;
  let pending = false;
  let lastAttempt = 0;
  const tick = async () => {
    if (stopped || pending || !useSettings.getState().autoCheckUpdates) return;
    if (Date.now() - lastAttempt < 24 * 60 * 60 * 1000) return;
    pending = true;
    try {
      const status = await api.updateStatus();
      if (stopped || !useSettings.getState().autoCheckUpdates || !status.app_path) return;
      if (status.running || status.ready_to_install) {
        useUpdateFlow.setState({ phase: status.running ? "running" : "built" });
        return;
      }
      if (["running", "built"].includes(useUpdateFlow.getState().phase)) return;
      lastAttempt = Date.now();
      await checkForUpdates();
      if (
        !stopped &&
        useSettings.getState().autoCheckUpdates &&
        useSettings.getState().autoDownloadUpdates &&
        useUpdateFlow.getState().check?.update_available
      )
        await downloadUpdate();
    } catch (cause) {
      lastAttempt = Date.now();
      if (!stopped) useUpdateFlow.setState({ checkError: errorMessage(cause) });
    } finally {
      pending = false;
    }
  };
  void tick();
  const interval = setInterval(() => void tick(), 60 * 60 * 1000);
  const unsubscribe = useSettings.subscribe((next, previous) => {
    if (next.autoCheckUpdates !== previous.autoCheckUpdates) {
      lastAttempt = 0;
      void tick();
    }
  });
  return () => {
    stopped = true;
    clearInterval(interval);
    unsubscribe();
  };
}
