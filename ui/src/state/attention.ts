import { vaultOperation } from "./vaultSession";
import { create } from "zustand";
import { api, inTauri, onTesseraChanged, onVaultChanged } from "../ipc/api";
import { vaultPrefs } from "./vaultPreferences";
import { type Agent, type TesseraStatus, errorMessage } from "../ipc/types";

interface Attention {
  disconnected: boolean;
  status: TesseraStatus | null;
  agents: Agent[];
  error: string | null;
  root: string | null;
  unseenFailureIds: number[];
  refresh(): Promise<void>;
  markFailuresSeen(ids: number[]): void;
}
let generation = 0;
let initialized = false;
let knownFailures = new Set<number>();
let seenFailures = new Set<number>();
const seenKey = (root: string) => `mosaic:seen-failed-runs:${root}`;
function loadSeen(root: string): Set<number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(seenKey(root)) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : []);
  } catch {
    return new Set();
  }
}
export const useAttention = create<Attention>((set) => ({
  disconnected: false,
  status: null,
  agents: [],
  error: null,
  root: null,
  unseenFailureIds: [],
  async refresh() {
    const current = generation;
    const sameVault = vaultOperation();
    try {
      const [status, agents, claude] = await Promise.all([api.tesseraStatus(), api.agents(), api.chatCheck()]);
      if (generation !== current || !sameVault()) return;
      const failures = status.runs.filter((r) => r.status === "failed").map((r) => r.id);
      const arrived = initialized && failures.some((id) => !knownFailures.has(id));
      knownFailures = new Set(failures);
      initialized = true;
      if (arrived && inTauri)
        void import("@tauri-apps/api/window")
          .then(async ({ getCurrentWindow, UserAttentionType }) => {
            const win = getCurrentWindow();
            if (!(await win.isFocused())) await win.requestUserAttention(UserAttentionType.Informational);
          })
          .catch(() => {});
      set({
        status,
        agents,
        disconnected: !claude.path,
        error: null,
        unseenFailureIds: failures.filter((id) => !seenFailures.has(id)),
      });
    } catch (e) {
      if (generation === current && sameVault()) set({ error: errorMessage(e) });
    }
  },
  markFailuresSeen(ids) {
    const state = useAttention.getState();
    if (!state.root || !state.status) return;
    const failed = new Set(state.status.runs.filter((run) => run.status === "failed").map((run) => run.id));
    const newlySeen = ids.filter((id) => failed.has(id) && !seenFailures.has(id));
    if (!newlySeen.length) return;
    for (const id of newlySeen) seenFailures.add(id);
    try {
      localStorage.setItem(seenKey(state.root), JSON.stringify([...seenFailures]));
    } catch {
      // The badge still clears for this session when app storage is unavailable.
    }
    set({ unseenFailureIds: state.unseenFailureIds.filter((id) => !seenFailures.has(id)) });
  },
}));
export function startAttention(root: string) {
  generation++;
  initialized = false;
  knownFailures = new Set();
  seenFailures = loadSeen(root);
  useAttention.setState({ root, status: null, agents: [], unseenFailureIds: [], error: null });
  const refresh = () => void useAttention.getState().refresh();
  refresh();
  let live = true;
  const offs: (() => void)[] = [];
  const keep = (f: () => void) => (live ? offs.push(f) : f());
  // Runs change the scheduler state; agent files change in the agents folder; Claude Code may have
  // been installed or signed in while Mosaic was in the background.
  void onTesseraChanged(refresh).then(keep);
  void onVaultChanged((c) => {
    const folder = vaultPrefs().agents_folder;
    if (c.paths.some((p) => p === folder || p.startsWith(`${folder}/`))) refresh();
  }).then(keep);
  window.addEventListener("focus", refresh);
  return () => {
    live = false;
    generation++;
    window.removeEventListener("focus", refresh);
    for (const off of offs) off();
  };
}
