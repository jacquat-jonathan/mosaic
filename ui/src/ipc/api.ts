// Typed access to the backend. Inside Tauri this goes through `invoke`; in a plain browser (UI
// development and tests) it falls back to an in-memory mock vault.

import type { IndexProgress, UpdateDone, Written, AgentRule, ChatEvent } from "./types";
import { commands } from "./bindings";
import { mockCommands, mockInvoke } from "./mock";
import type { VaultPreferences } from "../state/vaultPreferences";
import type { TemplateConfig, TemplateRequest } from "./types";
import type {
  CreatePlannerEpic,
  CreatePlannerEvent,
  CreatePlannerTask,
  CreatePlannerWorkSession,
  IcalImportPreview,
  MarkdownImportPreview,
  MovePlannerTask,
  PlannerChanged,
  UpdatePlannerEpic,
  UpdatePlannerEvent,
  UpdatePlannerTask,
  UpdatePlannerWorkSession,
} from "./types";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The backend's commands, typed from Rust (./bindings.ts); the in-memory mock outside the app. */
const cmd: typeof commands = inTauri ? commands : mockCommands;

/** Adds a file from outside the vault (bytes sent raw, not as JSON). A taken name gets " 1", " 2"… */
async function importFile(path: string, bytes: Uint8Array): Promise<Written> {
  if (!inTauri) return mockInvoke("import_file", { path, bytes }) as Promise<Written>;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Written>("import_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
}

export const api = {
  openVault: (path: string) => cmd.openVault(path),
  currentVault: () => cmd.currentVault(),
  lastVault: () => cmd.lastVault(),
  createVault: (parent: string, name: string) => cmd.createVault(parent, name),
  recentVaults: () => cmd.recentVaults(),
  forgetVault: (path: string) => cmd.forgetVault(path),
  bookmarks: () => cmd.getBookmarks(),
  setBookmarks: (paths: string[]) => cmd.setBookmarks(paths),
  copy: (from: string, to: string) => cmd.copyPath(from, to),
  importFile,
  list: (dir = "", recursive = false) => cmd.listDir(dir, recursive),
  read: (path: string) => cmd.readFile(path),
  create: (path: string, content = "", root?: string) => cmd.createFile(path, content, root ?? null),
  templateConfig: () => cmd.templateConfig(),
  // The core serializes every field; `#[serde(default)]` only makes them optional when it reads.
  vaultPreferences: () => cmd.vaultPreferences() as Promise<VaultPreferences>,
  setVaultPreferences: (root: string, patch: Partial<VaultPreferences>) => cmd.setVaultPreferences(patch, root),
  setTemplateConfig: (config: TemplateConfig) => cmd.setTemplateConfig(config),
  templates: (path: string | null = null) => cmd.listTemplates(path),
  renderTemplate: (request: TemplateRequest) => cmd.renderTemplate(request),
  createNote: (request: TemplateRequest) => cmd.createNote(request),
  templateStarters: () => cmd.templateStarters(),
  write: (path: string, content: string, expectedHash?: string | null, root?: string) =>
    cmd.writeFile(path, content, expectedHash ?? null, root ?? null),
  mkdir: (path: string) => cmd.makeDir(path),
  rename: (from: string, to: string) => cmd.renamePath(from, to),
  unfinishedRenames: () => cmd.unfinishedRenames(),
  /** Rewrites the links an unfinished move left pointing at the old name. */
  fixLinks: (id: number) => cmd.fixLinks(id),
  remove: (path: string) => cmd.deletePath(path),
  absolutePath: (path: string) => cmd.absolutePath(path),
  search: (query: string, limit = 50) => cmd.search(query, limit),
  /** Notes matching a structured query (crates/mosaic-core/src/query.rs). */
  query: (query: string) => cmd.queryNotes(query),
  /** Whether Claude Code is installed (and where). */
  chatCheck: () => cmd.chatCheck(),
  /** Sends a chat message (as `agent` from Agents/ if given); events arrive through `onChatEvent`. Returns the run id. */
  chatSend: (
    message: string,
    session: string | null,
    context: string[],
    active: string | null,
    agent: string | null,
    selection: { path: string; text: string } | null,
    model: string | null,
  ) => cmd.chatSend(message, session, context, active, agent, selection?.path ?? null, selection?.text ?? null, model),
  chatStop: (run: number) => cmd.chatStop(run),
  /** The agents in the vault's Agents/ folder. */
  agents: () => cmd.agents(),
  /** Mirrors the agents into the vault's .claude/skills/ for Claude Code. */
  mirrorAgents: () => cmd.mirrorAgents(),
  tesseraStatus: () => cmd.tesseraStatus(),
  tesseraRun: (name: string) => cmd.tesseraRun(name),
  tesseraTestEvent: (name: string, path: string) => cmd.tesseraTestEvent(name, path),
  tesseraPauseAll: (paused: boolean) => cmd.tesseraPauseAll(paused),
  tesseraPauseAgent: (name: string, paused: boolean) => cmd.tesseraPauseAgent(name, paused),
  tesseraSetMaxChainDepth: (depth: number) => cmd.tesseraSetMaxChainDepth(depth),
  /** Each day's tasks from `from` to `to` (2026-10-04; at most 62 days), and overdue dated tasks. */
  days: (from: string, to: string, today: string) => cmd.days(from, to, today),
  /** Moves the open tasks of the last daily note before `day` into `path` (created with `newNote`). */
  carryOver: (day: string, path: string | null, newNote: string | null) => cmd.carryOver(day, path, newNote),
  /** Ticks or unticks the task on `line` of a note; `conflict` when that line changed. */
  setTask: (path: string, line: number, text: string, done: boolean) => cmd.setTask(path, line, text, done),
  setTaskWorkflow: (path: string, line: number, text: string, expectedState: string, next: string) =>
    cmd.setTaskWorkflow(path, line, text, expectedState, next),
  plannerSummary: () => cmd.plannerSummary(),
  plannerActivity: (entityKind: "epic" | "task" | "event", entityId: string) =>
    cmd.plannerActivity(entityKind, entityId),
  plannerEpics: (includeArchived = false, includeTrashed = false) => cmd.plannerEpics(includeArchived, includeTrashed),
  plannerTasks: (includeArchived = false, includeTrashed = false) => cmd.plannerTasks(includeArchived, includeTrashed),
  createPlannerEpic: (input: CreatePlannerEpic) => cmd.plannerCreateEpic(input),
  updatePlannerEpic: (id: string, input: UpdatePlannerEpic) => cmd.plannerUpdateEpic(id, input),
  archivePlannerEpic: (id: string, expectedRevision: number) => cmd.plannerArchiveEpic(id, expectedRevision),
  restorePlannerEpic: (id: string, expectedRevision: number) => cmd.plannerRestoreEpic(id, expectedRevision),
  trashPlannerEpic: (id: string, expectedRevision: number) => cmd.plannerTrashEpic(id, expectedRevision),
  createPlannerTask: (input: CreatePlannerTask) => cmd.plannerCreateTask(input),
  updatePlannerTask: (id: string, input: UpdatePlannerTask) => cmd.plannerUpdateTask(id, input),
  movePlannerTask: (id: string, input: MovePlannerTask) => cmd.plannerMoveTask(id, input),
  completePlannerTask: (
    id: string,
    expectedRevision: number,
    allowIncompleteSubtasks: boolean,
    futureSessions: "cancel" | "keep" = "cancel",
  ) => cmd.plannerCompleteTask(id, expectedRevision, allowIncompleteSubtasks, futureSessions),
  reopenPlannerTask: (id: string, expectedRevision: number) => cmd.plannerReopenTask(id, expectedRevision),
  archivePlannerTask: (id: string, expectedRevision: number) => cmd.plannerArchiveTask(id, expectedRevision),
  restorePlannerTask: (id: string, expectedRevision: number) => cmd.plannerRestoreTask(id, expectedRevision),
  trashPlannerTask: (id: string, expectedRevision: number) => cmd.plannerTrashTask(id, expectedRevision),
  plannerWorkSessions: (taskId: string | null = null, includeCancelled = false) =>
    cmd.plannerWorkSessions(taskId, includeCancelled),
  createPlannerWorkSession: (input: CreatePlannerWorkSession) => cmd.plannerCreateWorkSession(input),
  updatePlannerWorkSession: (id: string, input: UpdatePlannerWorkSession) => cmd.plannerUpdateWorkSession(id, input),
  cancelPlannerWorkSession: (id: string, expectedRevision: number) =>
    cmd.plannerCancelWorkSession(id, expectedRevision),
  plannerCalendarRange: (from: string, to: string) => cmd.plannerCalendarRange(from, to),
  plannerEvents: (includeArchived = false, includeTrashed = false) =>
    cmd.plannerEvents(includeArchived, includeTrashed),
  createPlannerEvent: (input: CreatePlannerEvent) => cmd.plannerCreateEvent(input),
  updatePlannerEvent: (id: string, input: UpdatePlannerEvent) => cmd.plannerUpdateEvent(id, input),
  archivePlannerEvent: (id: string, expectedRevision: number) => cmd.plannerArchiveEvent(id, expectedRevision),
  restorePlannerEvent: (id: string, expectedRevision: number) => cmd.plannerRestoreEvent(id, expectedRevision),
  trashPlannerEvent: (id: string, expectedRevision: number) => cmd.plannerTrashEvent(id, expectedRevision),
  cancelPlannerEventOccurrence: (seriesId: string, expectedRevision: number, occurrenceKey: string) =>
    cmd.plannerCancelEventOccurrence(seriesId, expectedRevision, occurrenceKey),
  replacePlannerEventOccurrence: (
    seriesId: string,
    expectedRevision: number,
    occurrenceKey: string,
    input: CreatePlannerEvent,
  ) => cmd.plannerReplaceEventOccurrence(seriesId, expectedRevision, occurrenceKey, input),
  plannerMigrationPreview: () => cmd.plannerMigrationPreview(),
  importMarkdownToPlanner: (
    preview: MarkdownImportPreview,
    selectedFingerprints: string[],
    allowDuplicates: boolean,
    timezone: string,
  ) => cmd.plannerImportMarkdown(preview, selectedFingerprints, allowDuplicates, timezone),
  previewPlannerIcal: (
    content: string,
    sourceKind = "ics-file",
    fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  ) => cmd.plannerIcalPreview(sourceKind, content, fallbackTimezone),
  importPlannerIcal: (preview: IcalImportPreview, selectedKeys: string[], allowDuplicates: boolean) =>
    cmd.plannerIcalImport(preview, selectedKeys, allowDuplicates),
  exportPlannerIcal: () => cmd.plannerIcalExport(),
  exportPlannerIcalFile: (path: string) => cmd.plannerIcalExportFile(path),
  exportPlanner: (format: "json" | "csv") => cmd.plannerExport(format),
  exportPlannerFile: (format: "json" | "csv", path: string) => cmd.plannerExportFile(format, path),
  restorePlannerBackup: (path: string) => cmd.plannerRestoreBackup(path),
  calendarSubscriptions: () => cmd.calendarSubscriptions(),
  addCalendarSubscription: (name: string, url: string, color: string, refreshMinutes: number) =>
    cmd.addCalendarSubscription(name, url, color, refreshMinutes),
  updateCalendarSubscription: (id: string, name: string, color: string, visible: boolean, refreshMinutes: number) =>
    cmd.updateCalendarSubscription(id, name, color, visible, refreshMinutes),
  removeCalendarSubscription: (id: string) => cmd.removeCalendarSubscription(id),
  refreshCalendarSubscriptions: (force = false) => cmd.refreshCalendarSubscriptions(force),
  calendarOverlayRange: (
    from: string,
    to: string,
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  ) => cmd.calendarOverlayRange(from, to, timezone),
  /** Agents' proposals in folders under review: pending first, then recent decisions. */
  proposals: (includeDecided = false) => cmd.proposals(includeDecided),
  /** The proposed content (null for a deletion). */
  proposalContent: (id: number) => cmd.proposalContent(id),
  /** The file as it was when the agent proposed (to show what the person changed since). */
  proposalBase: (id: number) => cmd.proposalBase(id),
  acceptProposal: (id: number, force = false, content: string | null = null) => cmd.acceptProposal(id, force, content),
  rejectProposal: (id: number, reason: string | null) => cmd.rejectProposal(id, reason),
  backlinks: (path: string) => cmd.backlinks(path),
  tags: () => cmd.tags(),
  aliases: () => cmd.aliases(),
  cliInfo: () => cmd.cliInfo(),
  installCli: () => cmd.installCli(),
  updateStatus: () => cmd.updateStatus(),
  checkUpdates: () => cmd.checkUpdates(),
  fileHistory: (path: string) => cmd.fileHistory(path),
  agentRules: () => cmd.getAgentRules(),
  printWindow: () => (inTauri ? cmd.printWindow() : Promise.resolve(window.print())),
  unlinkedMentions: (path: string) => cmd.unlinkedMentions(path),
  linkMention: (source: string, line: number, text: string, target: string) =>
    cmd.linkMention(source, line, text, target),
  setAgentRules: (rules: AgentRule[]) => cmd.setAgentRules(rules),
  versionContent: (id: number) => cmd.versionContent(id),
  restoreVersion: (path: string, id: number, expectedHash: string | null) => cmd.restoreVersion(path, id, expectedHash),
  aiActivity: () => cmd.aiActivity(null),
  undoChange: (id: number) => cmd.undoChange(id),
  startUpdate: () => cmd.startUpdate(),
  cancelUpdate: () => cmd.cancelUpdate(),
  finishUpdate: () => cmd.finishUpdate(),
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

/** Publishes a sanitized HTML preview on Mosaic's local asset origin. */
export async function htmlPreviewDocumentUrl(html: string): Promise<string> {
  if (!inTauri) return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  const path = await cmd.htmlPreviewDocument(html);
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
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
/** The vault's history database changed: an agent proposed or withdrew a change, or one was decided. */
export const onHistoryChanged = (cb: () => void) => listenTo<void>("history-changed", cb);
export const onPlannerChanged = (cb: (change: PlannerChanged) => void) =>
  listenTo<PlannerChanged>("planner-changed", cb);

/** Subscribes to changes of the app's settings file (e.g. an agent added a bookmark). */
export async function onSettingsChanged(cb: () => void): Promise<() => void> {
  if (!inTauri) {
    window.addEventListener("mock-settings-changed", cb);
    return () => window.removeEventListener("mock-settings-changed", cb);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen("settings-changed", () => cb());
}

/** Opens a vault file with its default macOS application (explicit user action only). Programs,
 * installers and folders are refused by the backend. */
export async function openInDefaultApp(path: string): Promise<void> {
  if (!inTauri) return;
  await cmd.openInDefaultApp(path);
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
