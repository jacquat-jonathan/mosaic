import { create } from "zustand";
import { api, onTesseraChanged } from "../ipc/api";
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
export const useAttention = create<Attention>((set) => ({
  count: 0, disconnected: false, status: null, agents: [], error: null,
  async refresh() {
    const current = generation;
    try {
      const [status, agents, claude] = await Promise.all([api.tesseraStatus(), api.agents(), api.chatCheck()]);
      if (generation !== current) return;
      const latest = new Map<string, string>();
      for (const r of status.runs) if (!latest.has(r.agent)) latest.set(r.agent, r.status);
      const count = [...latest.values()].filter(s => s === "failed").length + status.agents.filter(a => a.error).length + (claude.path ? 0 : 1);
      set({ status, agents, count, disconnected: !claude.path, error: null });
    } catch (e) { if (generation === current) set({ error: errorMessage(e), count: 1 }); }
  },
}));
export function startAttention() {
  generation++;
  useAttention.setState({ status: null, agents: [], count: 0, error: null });
  const refresh = () => void useAttention.getState().refresh();
  refresh();
  let live = true; let off: (() => void) | undefined;
  void onTesseraChanged(refresh).then(f => live ? off = f : f());
  const timer = setInterval(refresh, 15000);
  return () => { live = false; generation++; clearInterval(timer); off?.(); };
}
