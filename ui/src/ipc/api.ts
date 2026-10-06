// Typed access to the backend. Inside Tauri this goes through `invoke`; in a plain browser (UI
// development and tests) it falls back to an in-memory mock vault.

import type { Backlink, CliInfo, Entry, FileContent, IndexProgress, RecentVault, Renamed, SearchHit, TagCount, UpdateCheck, UpdateDone, UpdateStatus, Version, VaultInfo, Written, AgentRule, Mention, QueryResult, Proposal, Days, CarryOver, Agent, ChatEvent, ClaudeInfo, TesseraStatus } from "./types";
import { mockInvoke } from "./mock";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  return mockInvoke(cmd, args) as Promise<T>;
}

/** Adds a file from outside the vault (bytes sent raw, not as JSON). A taken name gets " 1", " 2"… */
async function importFile(path: string, bytes: Uint8Array): Promise<Written> {
  if (!inTauri) return mockInvoke("import_file", { path, bytes }) as Promise<Written>;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Written>("import_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
}

export const api = {
  openVault: (path: string) => call<VaultInfo>("open_vault", { path }),
  currentVault: () => call<VaultInfo | null>("current_vault"),
  lastVault: () => call<string | null>("last_vault"),
  createVault: (parent: string, name: string) => call<VaultInfo>("create_vault", { parent, name }),
  recentVaults: () => call<RecentVault[]>("recent_vaults"),
  forgetVault: (path: string) => call<void>("forget_vault", { path }),
  bookmarks: () => call<string[]>("get_bookmarks"),
  setBookmarks: (paths: string[]) => call<void>("set_bookmarks", { paths }),
  copy: (from: string, to: string) => call<Written>("copy_path", { from, to }),
  importFile,
  list: (dir = "", recursive = false) => call<Entry[]>("list_dir", { dir, recursive }),
  read: (path: string) => call<FileContent>("read_file", { path }),
  create: (path: string, content = "") => call<Written>("create_file", { path, content }),
  write: (path: string, content: string, expectedHash?: string | null) =>
    call<Written>("write_file", { path, content, expectedHash: expectedHash ?? null }),
  mkdir: (path: string) => call<void>("make_dir", { path }),
  rename: (from: string, to: string) => call<Renamed>("rename_path", { from, to }),
  remove: (path: string) => call<void>("delete_path", { path }),
  absolutePath: (path: string) => call<string>("absolute_path", { path }),
  search: (query: string, limit = 50) => call<SearchHit[]>("search", { query, limit }),
  /** Notes matching a structured query (crates/mosaic-core/src/query.rs). */
  query: (query: string) => call<QueryResult>("query_notes", { query }),
  /** Whether Claude Code is installed (and where). */
  chatCheck: () => call<ClaudeInfo>("chat_check", {}),
  /** Sends a chat message (as `agent` from Agents/ if given); events arrive through `onChatEvent`. Returns the run id. */
  chatSend: (
    message: string,
    session: string | null,
    context: string[],
    active: string | null,
    agent: string | null,
    selection: { path: string; text: string } | null,
    model: string | null,
  ) => call<number>("chat_send", { message, session, context, active, agent, selectionPath: selection?.path ?? null, selectionText: selection?.text ?? null, model }),
  chatStop: (run: number) => call<void>("chat_stop", { run }),
  /** The agents in the vault's Agents/ folder. */
  agents: () => call<Agent[]>("agents", {}),
  /** Mirrors the agents into the vault's .claude/skills/ for Claude Code. */
  mirrorAgents: () => call<unknown>("mirror_agents", {}),
  tesseraStatus: () => call<TesseraStatus>("tessera_status", {}),
  tesseraRun: (name: string) => call<number>("tessera_run", { name }),
  tesseraPauseAll: (paused: boolean) => call<void>("tessera_pause_all", { paused }),
  tesseraPauseAgent: (name: string, paused: boolean) => call<void>("tessera_pause_agent", { name, paused }),
  /** Each day's tasks from `from` to `to` (2026-10-04; at most 62 days), and overdue dated tasks. */
  days: (from: string, to: string, today: string) => call<Days>("days", { from, to, today }),
  /** Moves the open tasks of the last daily note before `day` into `path` (created with `newNote`). */
  carryOver: (day: string, path: string | null, newNote: string | null) => call<CarryOver>("carry_over", { day, path, newNote }),
  /** Ticks or unticks the task on `line` of a note; `conflict` when that line changed. */
  setTask: (path: string, line: number, text: string, done: boolean) => call<Written>("set_task", { path, line, text, done }),
  /** Agents' proposals in folders under review: pending first, then recent decisions. */
  proposals: (includeDecided = false) => call<Proposal[]>("proposals", { includeDecided }),
  /** The proposed content (null for a deletion). */
  proposalContent: (id: number) => call<string | null>("proposal_content", { id }),
  /** The file as it was when the agent proposed (to show what the person changed since). */
  proposalBase: (id: number) => call<string | null>("proposal_base", { id }),
  acceptProposal: (id: number, force = false) => call<string>("accept_proposal", { id, force }),
  rejectProposal: (id: number, reason: string | null) => call<void>("reject_proposal", { id, reason }),
  backlinks: (path: string) => call<Backlink[]>("backlinks", { path }),
  tags: () => call<TagCount[]>("tags"),
  aliases: () => call<[string, string][]>("aliases"),
  cliInfo: () => call<CliInfo>("cli_info"),
  installCli: () => call<CliInfo>("install_cli"),
  updateStatus: () => call<UpdateStatus>("update_status"),
  setUpdateSource: (path: string | null) => call<UpdateStatus>("set_update_source", { path }),
  checkUpdates: () => call<UpdateCheck>("check_updates"),
  fileHistory: (path: string) => call<Version[]>("file_history", { path }),
  agentRules: () => call<AgentRule[]>("get_agent_rules", {}),
  printWindow: () => (inTauri ? call<void>("print_window", {}) : Promise.resolve(window.print())),
  unlinkedMentions: (path: string) => call<Mention[]>("unlinked_mentions", { path }),
  linkMention: (source: string, line: number, text: string, target: string) => call<Written>("link_mention", { source, line, text, target }),
  setAgentRules: (rules: AgentRule[]) => call<void>("set_agent_rules", { rules }),
  versionContent: (id: number) => call<string>("version_content", { id }),
  restoreVersion: (path: string, id: number, expectedHash: string | null) => call<Written>("restore_version", { path, id, expectedHash }),
  aiActivity: () => call<Version[]>("ai_activity", {}),
  undoChange: (id: number) => call<string>("undo_change", { id }),
  startUpdate: () => call<void>("start_update"),
  cancelUpdate: () => call<void>("cancel_update"),
  finishUpdate: () => call<void>("finish_update"),
};

/** Asks the user for a folder with the native dialog (or a prompt-free mock in the browser). */
export async function pickFolder(title = "Open a folder as a vault"): Promise<string | null> {
  if (!inTauri) return "/mock/vault";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

/** URL the webview can load a vault file from (images, PDF). */
export async function fileUrl(path: string): Promise<string> {
  if (!inTauri) return await mockFileUrl(path);
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(await api.absolutePath(path));
}

async function mockFileUrl(path: string): Promise<string> {
  const { mockInvoke } = await import("./mock");
  const raw = (await mockInvoke("read_raw", { path })) as string;
  return raw.startsWith("data:") ? raw : `data:text/plain;charset=utf-8,${encodeURIComponent(raw)}`;
}

/** Opens an http(s)/mailto URL in the default browser — only ever on an explicit user click. */
export async function openExternal(url: string): Promise<void> {
  if (!/^(https?|mailto):/i.test(url)) return;
  if (!inTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Subscribes to background indexing progress. Returns an unsubscribe function. */
export async function onIndexProgress(cb: (p: IndexProgress) => void): Promise<() => void> {
  if (!inTauri) {
    cb({ done: 0, total: 0, finished: true });
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<IndexProgress>("index-progress", (e) => cb(e.payload));
}

export interface VaultChanges {
  paths: string[];
  root_missing: boolean;
}

/** Subscribes to changes made on disk outside the app. */
export async function onVaultChanged(cb: (c: VaultChanges) => void): Promise<() => void> {
  if (!inTauri) {
    const handler = (e: Event) => cb((e as CustomEvent<VaultChanges>).detail);
    window.addEventListener("mock-vault-changed", handler);
    return () => window.removeEventListener("mock-vault-changed", handler);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<VaultChanges>("vault-changed", (e) => cb(e.payload));
}

/** Streams the chat's answers: one event at a time, with the run it belongs to. */
export async function onChatEvent(cb: (run: number, event: ChatEvent) => void): Promise<() => void> {
  if (!inTauri) {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ run: number; event: ChatEvent }>).detail;
      cb(d.run, d.event);
    };
    window.addEventListener("mock-chat-event", handler);
    return () => window.removeEventListener("mock-chat-event", handler);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ run: number; event: ChatEvent }>("chat-event", (e) => cb(e.payload.run, e.payload.event));
}

export const onTesseraChanged = (cb: () => void) => listenTo<void>("tessera-changed", cb);

/** Subscribes to changes of the app's settings file (e.g. an agent added a bookmark). */
export async function onSettingsChanged(cb: () => void): Promise<() => void> {
  if (!inTauri) {
    window.addEventListener("mock-settings-changed", cb);
    return () => window.removeEventListener("mock-settings-changed", cb);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen("settings-changed", () => cb());
}

/** Opens a vault file with its default macOS application (explicit user action only). */
export async function openInDefaultApp(path: string): Promise<void> {
  if (!inTauri) return;
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(await api.absolutePath(path));
}

/** Shows a vault file (or the vault itself, with `""`) in Finder. */
export async function revealInFinder(path: string): Promise<void> {
  if (!inTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(await api.absolutePath(path));
}

/** Subscribes to backend events (or the mock's window events in the browser). */
async function listenTo<T>(name: string, cb: (payload: T) => void): Promise<() => void> {
  if (!inTauri) {
    const handler = (e: Event) => cb((e as CustomEvent<T>).detail);
    window.addEventListener(`mock-${name}`, handler);
    return () => window.removeEventListener(`mock-${name}`, handler);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(name, (e) => cb(e.payload));
}

export const onUpdateLog = (cb: (line: string) => void) => listenTo<string>("update-log", cb);
export const onUpdateDone = (cb: (d: UpdateDone) => void) => listenTo<UpdateDone>("update-done", cb);
