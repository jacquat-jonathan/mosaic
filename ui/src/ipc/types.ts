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
  /** Set when undo history and proposals can't be saved for this vault this session. */
  history_warning?: string | null;
}

export interface RecentVault extends VaultInfo {
  /** False when the folder is gone (deleted, or on an unplugged disk). */
  exists: boolean;
}

export interface CoreError {
  code: "not_found" | "already_exists" | "conflict" | "invalid_path" | "not_text" | "invalid" | "io";
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
  workflow?: "new" | "blocked" | "in-progress" | "in-qa" | "done";
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
  on: string[];
  model: string | null;
  may_change: string[];
  /** Runs may use web search and fetch (`web: true` in the agent's frontmatter). */
  web: boolean;
  instructions: string;
}

export interface AgentRun {
  id: number;
  agent: string;
  title: string;
  started: number;
  finished: number | null;
  late: boolean;
  status: "running" | "done" | "failed" | "skipped";
  trigger?: string | null;
  trigger_path?: string | null;
  chain_id?: string | null;
  chain_depth?: number | null;
  model?: string | null;
  attempts?: number;
  answer: string;
  error: string | null;
  proposals: number;
  changes: string[];
  changed_paths?: string[];
  proposal_ids?: number[];
}

export interface TesseraStatus {
  paused: boolean;
  max_chain_depth: number;
  agents: {
    name: string;
    title: string;
    schedule: string | null;
    on: string[];
    model: string | null;
    paused: boolean;
    running: boolean;
    queued: number;
    error: string | null;
  }[];
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

export type PlannerTaskStatus = "new" | "blocked" | "in-progress" | "in-qa" | "done";

export interface PlannerSummary {
  schema_version: number;
  revision: number;
  epics: number;
  tasks: number;
  work_sessions: number;
  events: number;
  is_empty: boolean;
}

export interface PlannerActivityEntry {
  id: number;
  entity_kind: string;
  entity_id: string;
  occurred_at: string;
  action: string;
  summary: string;
  before: unknown | null;
  after: unknown | null;
}

export interface PlannerEpic {
  id: string;
  title: string;
  description: string;
  color: string;
  position: number;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  trashed_at: string | null;
}

export interface PlannerTask {
  id: string;
  epic_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  status: PlannerTaskStatus;
  due_date: string | null;
  estimate_minutes: number | null;
  position: number;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
  trashed_at: string | null;
}

export interface CreatePlannerEpic {
  title: string;
  description: string;
  color: string;
}
export interface UpdatePlannerEpic {
  expected_revision: number;
  title?: string | null;
  description?: string | null;
  color?: string | null;
  position?: number | null;
}
export interface CreatePlannerTask {
  epic_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  status: PlannerTaskStatus;
  due_date: string | null;
  estimate_minutes: number | null;
}
export interface UpdatePlannerTask {
  expected_revision: number;
  title?: string | null;
  description?: string | null;
  due_date?: string | null;
  clear_due_date: boolean;
  estimate_minutes?: number | null;
  clear_estimate: boolean;
}
export interface MovePlannerTask {
  expected_revision: number;
  epic_id: string | null;
  parent_id: string | null;
  status: PlannerTaskStatus;
  position: number;
}

export interface PlannerWorkSession {
  id: string;
  task_id: string;
  all_day: boolean;
  start_value: string;
  end_value: string;
  timezone: string;
  state: "planned" | "cancelled";
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface CreatePlannerWorkSession {
  task_id: string;
  all_day: boolean;
  start_value: string;
  end_value: string;
  timezone: string;
}
export interface UpdatePlannerWorkSession {
  expected_revision: number;
  all_day: boolean;
  start_value: string;
  end_value: string;
  timezone: string;
}
export interface PlannerEvent {
  id: string;
  series_id: string | null;
  title: string;
  description: string;
  location: string;
  meeting_url: string | null;
  participants: string[];
  epic_id: string | null;
  color: string | null;
  all_day: boolean;
  start_value: string;
  end_value: string;
  timezone: string;
  recurrence_rule: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  trashed_at: string | null;
}
export interface CreatePlannerEvent {
  title: string;
  description: string;
  location: string;
  meeting_url: string | null;
  participants: string[];
  epic_id: string | null;
  color: string | null;
  all_day: boolean;
  start_value: string;
  end_value: string;
  timezone: string;
  recurrence_rule: string | null;
}
export interface UpdatePlannerEvent extends CreatePlannerEvent {
  expected_revision: number;
}
export interface EventOccurrence {
  event_id: string;
  series_id: string;
  occurrence_key: string;
  title: string;
  description: string;
  location: string;
  meeting_url: string | null;
  participants: string[];
  epic_id: string | null;
  color: string | null;
  all_day: boolean;
  start_value: string;
  end_value: string;
  timezone: string;
  recurring: boolean;
}
export interface CalendarWorkSession {
  session: PlannerWorkSession;
  task_title: string;
  task_status: PlannerTaskStatus;
  epic_id: string | null;
  color: string | null;
}
export interface DueMarker {
  task_id: string;
  title: string;
  date: string;
  status: PlannerTaskStatus;
  epic_id: string | null;
  color: string | null;
}
export interface DayWorkload {
  date: string;
  minutes: number;
}
export interface PlannerCalendarRange {
  from: string;
  to: string;
  events: EventOccurrence[];
  work_sessions: CalendarWorkSession[];
  due_markers: DueMarker[];
  unscheduled_tasks: PlannerTask[];
  workload: DayWorkload[];
}

export interface IcalImportCandidate {
  key: string;
  source_uid: string;
  recurrence_id: string;
  title: string;
  all_day: boolean;
  start_value: string;
  end_value: string;
  timezone: string;
  recurrence_rule: string | null;
  duplicate: boolean;
  event: CreatePlannerEvent;
}
export interface IcalImportPreview {
  planner_revision: number;
  source_kind: string;
  candidates: IcalImportCandidate[];
  duplicates: number;
}
export interface IcalImportResult {
  planner_revision: number;
  imported_event_ids: string[];
  skipped_duplicates: string[];
}
export interface CalendarSubscription {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  refresh_minutes: number;
  last_success: string | null;
  last_error: string | null;
  has_cache: boolean;
}
export interface CalendarOverlayOccurrence {
  source_id: string;
  source_name: string;
  uid: string;
  title: string;
  description: string;
  location: string;
  meeting_url: string | null;
  all_day: boolean;
  start_value: string;
  end_value: string;
  timezone: string;
  occurrence_key: string;
  color: string | null;
  read_only: true;
}
export interface CalendarOverlayRange {
  subscriptions: CalendarSubscription[];
  occurrences: CalendarOverlayOccurrence[];
}

export interface MarkdownImportCandidate {
  source_path: string;
  source_line: number;
  block_id: string | null;
  fingerprint: string;
  parent_fingerprint: string | null;
  epic_fingerprint: string | null;
  depth: number;
  kind: "epic" | "task" | "subtask";
  title: string;
  status: PlannerTaskStatus;
  due_date: string | null;
  all_day_session_date: string | null;
  archived: boolean;
  default_selected: boolean;
  duplicate: boolean;
}
export interface MarkdownImportGroup {
  source_path: string;
  tasks: MarkdownImportCandidate[];
}
export interface MarkdownImportPreview {
  planner_revision: number;
  groups: MarkdownImportGroup[];
  candidates: number;
  selected_by_default: number;
  duplicates: number;
}
export interface MarkdownImportResult {
  planner_revision: number;
  imported_epic_ids: string[];
  imported_task_ids: string[];
  skipped_duplicates: string[];
}
export interface PlannerChanged {
  root: string;
  revision: number;
  affected_ids: string[];
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
  mode?: "binary" | "source";
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
export interface TemplateRule {
  folder: string;
  template: string | null;
}
export interface TemplateConfig {
  version: number;
  folder: string;
  rules: TemplateRule[];
}
export interface TemplateList {
  templates: { path: string; name: string }[];
  default: { template: string | null; rule_folder: string | null };
}
export interface TemplateRequest {
  path: string;
  template?: string | null;
  blank?: boolean;
  timestamp?: string | null;
  expected_template_hash?: string | null;
}
export interface TemplatePreview {
  path: string;
  content: string;
  template: string | null;
  template_hash: string | null;
  rule_folder: string | null;
  context: { title: string; date: string; time: string; weekday: string; timestamp: string };
}
