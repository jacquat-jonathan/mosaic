// Agents' pending proposals (folders under review, crates/mosaic-core/src/review.rs). They're written
// by another process (the MCP server or the CLI) without touching any file, so no file event tells
// the app: it checks every few seconds while a vault is open.

import { create } from "zustand";
import { api } from "../ipc/api";
import type { Proposal } from "../ipc/types";

const POLL_MS = 4000;

interface ReviewState {
  pending: Proposal[];
  refresh(): Promise<void>;
  /** Starts checking for new proposals; returns a function that stops. */
  watch(): () => void;
}

export const useReview = create<ReviewState>((set, get) => ({
  pending: [],
  refresh: async () => {
    try {
      const next = await api.proposals(false);
      const prev = get().pending;
      // Keep the same array when nothing changed, so subscribers don't re-render every poll.
      const same = next.length === prev.length && next.every((p, i) => p.id === prev[i].id && p.updated === prev[i].updated && p.stale === prev[i].stale);
      if (!same) set({ pending: next });
    } catch {
      /* no vault yet, or the history is unavailable: try again next time */
    }
  },
  watch: () => {
    void get().refresh();
    const timer = setInterval(() => void get().refresh(), POLL_MS);
    return () => clearInterval(timer);
  },
}));
