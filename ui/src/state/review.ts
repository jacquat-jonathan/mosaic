// Agents' pending proposals (folders under review, crates/mosaic-core/src/review.rs). They're written
// by another process (the MCP server or the CLI) into the vault's history database; the app watches
// that database and reloads them when it changes (`history-changed`).

import { create } from "zustand";
import { api, inTauri, onHistoryChanged } from "../ipc/api";
import type { Proposal } from "../ipc/types";

interface ReviewState {
  pending: Proposal[];
  initialized: boolean;
  refresh(): Promise<void>;
  /** Follows new proposals as agents make them; returns a function that stops. */
  watch(): () => void;
}

export const useReview = create<ReviewState>((set, get) => ({
  pending: [],
  initialized: false,
  refresh: async () => {
    try {
      const next = await api.proposals(false);
      const prev = get().pending;
      const arrived = get().initialized && next.some((p) => !prev.some((old) => old.id === p.id));
      // Keep the same array when nothing changed, so subscribers don't re-render.
      const same =
        next.length === prev.length &&
        next.every((p, i) => p.id === prev[i].id && p.updated === prev[i].updated && p.stale === prev[i].stale);
      if (!same) set({ pending: next });
      if (!get().initialized) set({ initialized: true });
      if (arrived && inTauri) {
        void import("@tauri-apps/api/window")
          .then(async ({ getCurrentWindow, UserAttentionType }) => {
            const win = getCurrentWindow();
            if (!(await win.isFocused())) await win.requestUserAttention(UserAttentionType.Informational);
          })
          .catch(() => {});
      }
    } catch {
      /* no vault yet, or the history is unavailable: try again next time */
    }
  },
  watch: () => {
    set({ initialized: false, pending: [] });
    void get().refresh();
    let live = true;
    let off: (() => void) | undefined;
    void onHistoryChanged(() => void get().refresh()).then((f) => (live ? (off = f) : f()));
    return () => {
      live = false;
      off?.();
    };
  },
}));
