// The chat with Claude in the right panel (views/ChatPanel.tsx): the conversation so far, the
// running answer, and the Claude Code session it continues. Kept for the app session, not in the
// vault (unless saved as a note).

import { create } from "zustand";
import { api, onChatEvent } from "../ipc/api";
import { errorMessage, type ChatEvent } from "../ipc/types";

export type ChatItem =
  | { kind: "user"; text: string; agent: string | null; context: string[]; selection: { path: string; text: string } | null; model: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; summary: string; path: string | null; writes: boolean; error: string | null; review: number | null; done: boolean }
  | { kind: "error"; text: string };

interface ChatState {
  items: ChatItem[];
  /** Claude Code's session, continued by the next message. */
  session: string | null;
  /** The answer being written, if any. */
  run: number | null;
  cost: number;
  /** Mosaic's tools weren't connected in the last answer. */
  noMosaic: boolean;
  /** `active`: the open note, which requests that don't name a note are about. */
  send(message: string, context: string[], active: string | null, agent: string | null, selection: { path: string; text: string } | null, model: string | null): Promise<void>;
  stop(): void;
  clear(): void;
  apply(run: number, e: ChatEvent): void;
}

export const useChat = create<ChatState>((set, get) => ({
  items: [],
  session: null,
  run: null,
  cost: 0,
  noMosaic: false,

  async send(message, context, active, agent, selection, model) {
    if (get().run !== null) return;
    set((s) => ({ items: [...s.items, { kind: "user", text: message, agent, context, selection, model }], run: -1 }));
    try {
      const run = await api.chatSend(message, get().session, context, active, agent, selection, model);
      set({ run });
      // Events that came in before the id was known.
      for (const e of early.get(run) ?? []) get().apply(run, e);
      early.clear();
    } catch (e) {
      set((s) => ({ run: null, items: [...s.items, { kind: "error", text: errorMessage(e) }] }));
    }
  },

  stop() {
    const run = get().run;
    if (run !== null && run > 0) void api.chatStop(run);
  },

  clear() {
    get().stop();
    set({ items: [], session: null, run: null, cost: 0, noMosaic: false });
  },

  apply(run, e) {
    if (run !== get().run) return;
    set((s) => {
      const items = [...s.items];
      switch (e.kind) {
        case "started":
          return { session: e.session_id || s.session, noMosaic: !e.mosaic };
        case "text":
          items.push({ kind: "text", text: e.text });
          return { items };
        case "tool":
          items.push({ kind: "tool", id: e.id, summary: e.summary, path: e.path, writes: e.writes, error: null, review: null, done: false });
          return { items };
        case "tool_done": {
          const i = items.findIndex((x) => x.kind === "tool" && x.id === e.id);
          if (i < 0) return s;
          items[i] = { ...(items[i] as Extract<ChatItem, { kind: "tool" }>), error: e.error, review: e.review, done: true };
          return { items };
        }
        case "done":
          if (e.error) items.push({ kind: "error", text: e.error });
          return { items, run: null, session: e.session_id ?? s.session, cost: s.cost + (e.cost_usd ?? 0) };
      }
    });
  },
}));

/** Events of a run whose id `chat_send` hasn't returned yet (they can arrive first). */
const early = new Map<number, ChatEvent[]>();

let listening = false;
/** Starts routing chat events to the store (once). */
export function listenToChat() {
  if (listening) return;
  listening = true;
  void onChatEvent((run, e) => {
    if (useChat.getState().run === -1) early.set(run, [...(early.get(run) ?? []), e]);
    else useChat.getState().apply(run, e);
  });
}

/** The conversation as Markdown, for "Save as note". */
export function chatAsMarkdown(items: ChatItem[]): string {
  return items
    .map((it) => {
      switch (it.kind) {
        case "user":
          return `**You${it.agent ? ` (agent ${it.agent})` : ""}${it.model ? ` · ${it.model}` : ""}:** ${it.text}${it.selection ? `\n\n> Selected from [[${it.selection.path.replace(/\.md$/i, "")}]]: ${it.selection.text.replace(/\n/g, "\n> ")}` : ""}`;
        case "text":
          return it.text;
        case "tool":
          return `- _${it.summary}${it.review ? " (proposed for review)" : ""}${it.error ? ` — failed: ${it.error}` : ""}_`;
        case "error":
          return `> ${it.text}`;
      }
    })
    .join("\n\n");
}
