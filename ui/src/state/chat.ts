// Chats are stored per vault in app storage. Events target their originating chat even when tabs change.
import { create } from "zustand";
import { prefs } from "./settings";
import { api, onChatEvent } from "../ipc/api";
import { errorMessage, type ChatEvent } from "../ipc/types";

export type ChatItem =
  | { kind: "user"; text: string; agent: string | null; context: string[]; selection: { path: string; text: string } | null; model: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; summary: string; path: string | null; writes: boolean; error: string | null; review: number | null; done: boolean }
  | { kind: "error"; text: string };

export interface Conversation {
  id: string;
  title: string;
  created: number;
  updated: number;
  items: ChatItem[];
  session: string | null;
  run: number | null;
  cost: number;
  noMosaic: boolean;
  draft: string;
  attached: string[];
  selection: { path: string; text: string } | null;
  agent: string | null;
  model: string;
}
interface ChatState {
  root: string | null;
  chats: Record<string, Conversation>;
  storageError: string | null;
  restore(root: string): void;
  create(context?: string[]): string;
  update(id: string, patch: Partial<Conversation>): void;
  remove(id: string): void;
  send(id: string, message: string, context: string[], active: string | null, agent: string | null, selection: Conversation["selection"], model: string | null): Promise<void>;
  stop(id: string): void;
  apply(run: number, e: ChatEvent): void;
}
export const chatTitle = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 72) || "New chat";
export function chatGroup(updated: number, now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(start); week.setDate(week.getDate() - 7);
  return updated >= +start ? "Today" : updated >= +week ? "Previous 7 days" : "Older";
}
const early = new Map<number, ChatEvent[]>();
const pending = new Set<string>();
export const useChat = create<ChatState>((set, get) => ({
  root: null, chats: {}, storageError: null,
  restore(root) {
    for (const c of Object.values(get().chats)) if (c.run !== null && c.run > 0) void api.chatStop(c.run);
    early.clear(); pending.clear();
    let chats: Record<string, Conversation> = {};
    let storageError: string | null = null;
    try {
      const saved = JSON.parse(localStorage.getItem(`mosaic:chats:${root}`) ?? "{}");
      for (const [id, value] of Object.entries(saved)) {
        const c = value as Conversation;
        if (!c || c.id !== id || !Array.isArray(c.items) || typeof c.title !== "string") continue;
        chats[id] = { ...c, run: null, draft: c.draft ?? "", attached: c.attached ?? [], selection: c.selection ?? null, agent: c.agent ?? null, model: c.model ?? "",
          items: c.run !== null ? [...c.items, { kind: "error", text: "The previous answer was interrupted. Send a message to continue." }] : c.items };
      }
    } catch { storageError = "Saved chats could not be loaded from app storage."; }
    set({ root, chats, storageError });
  },
  create(context = []) {
    const id = crypto.randomUUID(); const now = Date.now();
    set(s => ({ chats: { ...s.chats, [id]: { id, title: "New chat", created: now, updated: now, items: [], session: null, run: null, cost: 0, noMosaic: false, draft: "", attached: context, selection: null, agent: null, model: prefs().chatModel } } }));
    return id;
  },
  update(id, patch) { set(s => s.chats[id] ? { chats: { ...s.chats, [id]: { ...s.chats[id], ...patch } } } : s); },
  remove(id) { get().stop(id); set(s => ({ chats: Object.fromEntries(Object.entries(s.chats).filter(([key]) => key !== id)) })); },
  async send(id, message, context, active, agent, selection, model) {
    const c = get().chats[id]; if (!c || c.run !== null) return;
    const root = get().root;
    pending.add(id);
    get().update(id, { items: [...c.items, { kind: "user", text: message, context, agent, selection, model }], run: -1, updated: Date.now(), ...(c.items.length ? {} : { title: chatTitle(message) }) });
    try {
      const run = await api.chatSend(message, c.session, context, active, agent, selection, model);
      if (get().root !== root || !get().chats[id] || get().chats[id].run !== -1) { void api.chatStop(run); return; }
      get().update(id, { run });
      for (const e of early.get(run) ?? []) get().apply(run, e);
      early.delete(run);
    } catch (e) {
      if (get().root === root && get().chats[id]) get().update(id, { run: null, items: [...get().chats[id].items, { kind: "error", text: errorMessage(e) }] });
    } finally { pending.delete(id); if (!pending.size) early.clear(); }
  },
  stop(id) { const c = get().chats[id]; if (c?.run && c.run > 0) void api.chatStop(c.run); if (c?.run === -1) get().update(id, { run: null }); },
  apply(run, e) {
    const c = Object.values(get().chats).find(c => c.run === run);
    if (!c) { if (pending.size) early.set(run, [...(early.get(run) ?? []), e]); return; }
    const items = [...c.items];
    switch (e.kind) {
      case "started": get().update(c.id, { session: e.session_id || c.session, noMosaic: !e.mosaic }); break;
      case "text": get().update(c.id, { items: [...items, { kind: "text", text: e.text }] }); break;
      case "tool": get().update(c.id, { items: [...items, { kind: "tool", id: e.id, summary: e.summary, path: e.path, writes: e.writes, error: null, review: null, done: false }] }); break;
      case "tool_done": get().update(c.id, { items: items.map(i => i.kind === "tool" && i.id === e.id ? { ...i, error: e.error, review: e.review, done: true } : i) }); break;
      case "done":
        if (e.error) items.push({ kind: "error", text: e.error });
        get().update(c.id, { items, run: null, session: e.session_id ?? c.session, cost: c.cost + (e.cost_usd ?? 0), updated: Date.now() }); break;
    }
  },
}));
useChat.subscribe((s, prev) => {
  if (!s.root || s.chats === prev.chats || s.root !== prev.root) return;
  try { localStorage.setItem(`mosaic:chats:${s.root}`, JSON.stringify(s.chats)); if (s.storageError) useChat.setState({ storageError: null }); }
  catch { if (!s.storageError) useChat.setState({ storageError: "Chats could not be saved. App storage may be full." }); }
});
let listening = false;
export function listenToChat() {
  if (listening) return;
  listening = true;
  void onChatEvent((run, e) => useChat.getState().apply(run, e)).catch(() => { listening = false; });
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
