// Mirrors of the serialized mosaic-core types.

export type FileKind =
  | "markdown"
  | "canvas"
  | "excalidraw"
  | "html"
  | "image"
  | "pdf"
  | "csv"
  | "json"
  | "yaml"
  | "graphviz"
  | "code"
  | "text"
  | "other";

export interface Entry {
  path: string;
  name: string;
  is_dir: boolean;
  kind: FileKind | null;
  size: number;
  mtime: number;
}

export interface FileContent {
  path: string;
  kind: FileKind;
  size: number;
  mtime: number;
  hash: string;
  content: string | null;
}

export interface Written {
  path: string;
  hash: string;
}

export interface VaultInfo {
  root: string;
  name: string;
}

export interface RecentVault extends VaultInfo {
  /** False when the folder is gone (deleted, or on an unplugged disk). */
  exists: boolean;
}

export interface CoreError {
  code:
    | "not_found"
    | "already_exists"
    | "conflict"
    | "invalid_path"
    | "not_text"
    | "invalid"
    | "io";
  message: string;
  current_hash: string | null;
}

export function isCoreError(e: unknown): e is CoreError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export function errorMessage(e: unknown): string {
  if (isCoreError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface SearchHit {
  path: string;
  title: string;
  /** Excerpt with matched terms wrapped in `**`. */
  snippet: string;
  score: number;
}

/** A checkbox task, in task queries (`task:open`). */
export interface TaskRow {
  /** 1-based line in the note. */
  line: number;
  status: "open" | "done" | "moved" | "cancelled";
  /** The checkbox character as written (" ", "x", ">", "-", …). */
  mark: string;
  text: string;
  depth: number;
  /** Line of the task it's nested under. */
  parent: number | null;
  /** Its own due date (📅), if any. */
  due: string | null;
}

/** What a chat answer is made of, as it streams in (crates/mosaic-core/src/chat.rs). */
export type ChatEvent =
  | { kind: "started"; session_id: string; mosaic: boolean }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; summary: string; path: string | null; writes: boolean }
  | { kind: "tool_done"; id: string; error: string | null; review: number | null }
  | { kind: "done"; session_id: string | null; cost_usd: number | null; error: string | null };

export interface ClaudeInfo {
  path: string | null;
  version: string | null;
}

/** An agent defined in the vault's Agents/ folder (crates/mosaic-core/src/agents.rs). */
export interface Agent {
  /** weekly-review: the slash command and skill name. */
  name: string;
  /** Weekly review */
  title: string;
  description: string;
  path: string;
  skill_folder: boolean;
  schedule: string | null;
  may_change: string[];
  instructions: string;
}

export interface AgentRun {
  id: number;
  agent: string;
  title: string;
  started: number;
  finished: number | null;
  late: boolean;
  status: "running" | "done" | "failed";
  answer: string;
  error: string | null;
  proposals: number;
  changes: string[];
  changed_paths?: string[];
  proposal_ids?: number[];
}

export interface TesseraStatus {
  paused: boolean;
  agents: { name: string; title: string; schedule: string; paused: boolean; running: boolean; error: string | null }[];
  runs: AgentRun[];
}

/** A task on a day of the calendar (crates/mosaic-core/src/days.rs). */
export interface DayTask {
  path: string;
  line: number;
  status: TaskRow["status"];
  mark: string;
  text: string;
  depth: number;
  parent: number | null;
  due: string | null;
  /** In the day's daily note (true), or a dated task (📅) from another note. */
  daily: boolean;
}

export interface Day {
  /** 2026-10-04 */
  date: string;
  note: string | null;
  tasks: DayTask[];
}

export interface Days {
  days: Day[];
  /** Dated tasks still open after their day. */
  overdue: DayTask[];
}

export interface CarryOver {
  from: string | null;
  to: string;
  moved: number;
  created: boolean;
}

export interface QueryRow {
  path: string;
  title: string;
  /** Milliseconds since the Unix epoch. */
  modified: number;
  tags: string[];
  /** The note's frontmatter. */
  props: Record<string, unknown>;
  /** Set in task queries: the row is this task, in the note above. */
  task?: TaskRow;
}

export interface QueryResult {
  /** Fields worth showing next to each note. */
  columns: string[];
  rows: QueryRow[];
  /** Matches before `limit`. */
  total: number;
}

export interface Backlink {
  source: string;
  line: number;
  context: string;
  embed: boolean;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface Renamed {
  path: string;
  updated_links_in: string[];
  review?: number;
}

export interface IndexProgress {
  done: number;
  total: number;
  finished: boolean;
}

export interface CliInfo {
  path: string | null;
  link: string;
  installed: boolean;
}

export interface UpdateStatus {
  version: string;
  /** Short commit the app was built from ("" if unknown). */
  commit: string;
  source_dir: string;
  /** Why the source folder can't be used, if it can't. */
  source_problem: string | null;
  /** The installed .app; null for a development build. */
  app_path: string | null;
  running: boolean;
  ready_to_install: boolean;
  /** Why the last "Restart to finish" couldn't install the new build. */
  last_install_error: string | null;
}

export interface Release {
  version: string;
  date: string;
  /** Top-level bullet points of the release in CHANGELOG.md. */
  notes: string[];
}

export interface UpdateCheck {
  branch: string;
  upstream: string;
  /** The version on the upstream branch, if its Cargo.toml could be read. */
  latest_version: string | null;
  /** Releases newer than this app, newest first. */
  releases: Release[];
  behind: { hash: string; subject: string }[];
  ahead: number;
  source_head: string;
  installed_outdated: boolean;
  dirty: boolean;
}

/** A note that mentions another note's title or alias without linking to it. */
export interface Mention {
  source: string;
  line: number;
  context: string;
  /** The words as written. */
  text: string;
}

/** What agents may do in a folder (Settings › AI). */
export interface AgentRule {
  path: string;
  access: "read-only" | "hidden" | "review";
}

/** A change an agent proposed in a folder under review (crates/mosaic-core/src/review.rs). */
export interface Proposal {
  id: number;
  path: string;
  action: "created" | "edited" | "deleted" | "renamed";
  status: "pending" | "accepted" | "rejected" | "withdrawn" | "undone";
  source: string;
  actor: string | null;
  created: number;
  updated: number;
  decided: number | null;
  reason: string | null;
  base_hash: string | null;
  hash: string | null;
  /** The file changed since the proposal was made: accepting overwrites that. */
  stale: boolean;
  /** Accepted anyway after the file changed: the person's changes since were replaced. */
  overwrote: boolean;
  binary: boolean;
  to_path: string | null;
  update_links: boolean;
}

/** One version of a file kept by Mosaic (see crates/mosaic-core/src/history.rs). */
export interface Version {
  id: number;
  path: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  source: "app" | "cli" | "agent" | "external";
  /** The agent or client name, e.g. "claude-code". */
  actor: string | null;
  action: "before" | "created" | "edited" | "deleted" | "renamed" | "restored";
  hash: string;
  size: number;
  from_path: string | null;
}

export interface UpdateDone {
  ok: boolean;
  cancelled: boolean;
  error: string | null;
}
