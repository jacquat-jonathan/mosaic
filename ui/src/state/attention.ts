import { create } from "zustand";
import { api, inTauri, onTesseraChanged, onVaultChanged } from "../ipc/api";
import { vaultPrefs } from "./vaultPreferences";
import { type Agent, type TesseraStatus, errorMessage } from "../ipc/types";

interface Attention {
  count: number;
  disconnected: boolean;
  status: TesseraStatus | null;
  agents: Agent[];
  error: string | null;
  refresh(): Promise<void>;
}
let generation = 0;
let initialized = false;
let seenFailures = new Set<number>();
export const useAttention = create<Attention>((set) => ({
  count: 0,
  disconnected: false,
  status: null,
  agents: [],
  error: null,
  async refresh() {
    const current = generation;
    try {
      const [status, agents, claude] = await Promise.all([api.tesseraStatus(), api.agents(), api.chatCheck()]);
      if (generation !== current) return;
      const failures = status.runs.filter((r) => r.status === "failed" || r.status === "skipped").map((r) => r.id);
      const arrived = initialized && failures.some((id) => !seenFailures.has(id));
      seenFailures = new Set(failures);
      initialized = true;
      if (arrived && inTauri)
        void import("@tauri-apps/api/window")
          .then(async ({ getCurrentWindow, UserAttentionType }) => {
            const win = getCurrentWindow();
            if (!(await win.isFocused())) await win.requestUserAttention(UserAttentionType.Informational);
          })
          .catch(() => {});
      const latest = new Map<string, string>();
      for (const r of status.runs) if (!latest.has(r.agent)) latest.set(r.agent, r.status);
      const count =
        [...latest.values()].filter((s) => s === "failed" || s === "skipped").length +
        status.agents.filter((a) => a.error).length +
        (claude.path ? 0 : 1);
      set({ status, agents, count, disconnected: !claude.path, error: null });
    } catch (e) {
      if (generation === current) set({ error: errorMessage(e), count: 1 });
    }
  },
}));
export function startAttention() {
  generation++;
  initialized = false;
  seenFailures = new Set();
  useAttention.setState({ status: null, agents: [], count: 0, error: null });
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
