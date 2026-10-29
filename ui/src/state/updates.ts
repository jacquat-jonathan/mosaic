import { create } from "zustand";
import { onUpdateDone, onUpdateLog } from "../ipc/api";

interface UpdateFlow {
  log: string[];
  phase: "idle" | "running" | "built" | "failed" | "cancelled";
  error: string | null;
}
/** Progress outlives Settings, so closing the panel keeps the update and its log. */
export const useUpdateFlow = create<UpdateFlow>(() => ({ log: [], phase: "idle", error: null }));
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
