// In-memory stand-in for mosaic-core, used when the UI runs outside Tauri (browser dev, Vitest).
// It mirrors the core's semantics closely enough for UI work; it is not a second implementation to keep in sync
// feature-for-feature.

import type {
  Agent,
  AgentRun,
  Backlink,
  CalendarOverlayOccurrence,
  CalendarSubscription,
  CoreError,
  CreatePlannerEpic,
  CreatePlannerEvent,
  CreatePlannerTask,
  CreatePlannerWorkSession,
  Entry,
  EventOccurrence,
  FileContent,
  IcalImportPreview,
  MarkdownImportCandidate,
  MarkdownImportPreview,
  MovePlannerTask,
  PlannerActivityEntry,
  PlannerEpic,
  PlannerEvent,
  PlannerTask,
  PlannerWorkSession,
  Proposal,
  QueryResult,
  QueryRow,
  SearchHit,
  UpdatePlannerEpic,
  UpdatePlannerEvent,
  UpdatePlannerTask,
  UpdatePlannerWorkSession,
  Version,
} from "./types";
import { kindOf } from "./kinds";
import { parse as parseYaml } from "yaml";
import { annotatedTask, taskLabel, type WorkflowState, WORKFLOW_STATES } from "../views/taskBoardModel";
import { defaultTemplateConfig, inFolder, templateDefault } from "../templates";
import type { TemplateConfig, TemplateRequest } from "./types";
import { fillTemplate } from "../daily";

interface MockFile {
  content: string;
  mtime: number;
}

const files = new Map<string, MockFile>();
const dirs = new Set<string>();
let opened = false;
let mockRoot = "/mock/vault";
const templateConfigs = new Map<string, TemplateConfig>();
let bookmarks: string[] = ["Welcome.md"];
let updateBuilt = false;
let updateRunning = false;
let updateTimers: ReturnType<typeof setTimeout>[] = [];
let agentRules: { path: string; access: string }[] = [];
let tesseraPaused = false;
let tesseraMaxDepth = 3;
const tesseraPausedAgents: string[] = [];
const tesseraRuns: AgentRun[] = [];
const proposals: (Proposal & { content: string | null })[] = [];
let plannerRevision = 0;
let plannerId = 0;
const plannerWorkSessions: PlannerWorkSession[] = [];
const plannerEvents: PlannerEvent[] = [];
const plannerEventExceptions = new Map<string, { action: "cancelled" | "replaced"; replacement: string | null }>();
const plannerEpics: PlannerEpic[] = [];
const plannerTasks: PlannerTask[] = [];
const importedFingerprints = new Set<string>();
const importedTaskIds = new Map<string, string>();
const importedEpicIdsByFingerprint = new Map<string, string>();
const importedIcal = new Set<string>();
const mockCalendarSubscriptions: CalendarSubscription[] = [
  {
    id: "mock-team",
    name: "Team calendar",
    color: "#7c6fd0",
    visible: true,
    refresh_minutes: 30,
    last_success: new Date().toISOString(),
    last_error: null,
    has_cache: true,
  },
];
const plannerActivities: PlannerActivityEntry[] = [];

const plannerNow = () => new Date().toISOString();
const nextPlannerId = (kind: string) => `${kind}-${++plannerId}`;
function plannerChanged(ids: string[]) {
  plannerRevision++;
  emit("planner-changed", { root: mockRoot, revision: plannerRevision, affected_ids: ids });
}
function plannerRecord(entity_kind: "epic" | "task" | "event", entity_id: string, action: string, summary: string) {
  plannerActivities.push({
    id: plannerActivities.length + 1,
    entity_kind,
    entity_id,
    occurred_at: plannerNow(),
    action,
    summary,
    before: null,
    after: null,
  });
}
function plannerConflict(current: { revision: number }, expected: number) {
  if (current.revision !== expected)
    throw { code: "conflict", message: "Planner object changed; reload it.", current_hash: String(current.revision) };
}
const isoDay = (value: string) => value.slice(0, 10);
const plusDays = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
function mockEventOccurrences(event: PlannerEvent, from: string, to: string): EventOccurrence[] {
  const first = isoDay(event.start_value),
    duration = event.all_day
      ? Math.max(
          1,
          Math.round(
            (Date.parse(`${event.end_value}T00:00:00Z`) - Date.parse(`${event.start_value}T00:00:00Z`)) / 86400000,
          ),
        )
      : 0;
  const rule = event.recurrence_rule;
  const result: EventOccurrence[] = [];
  let day = first,
    index = 0;
  const until = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rule ?? "");
  const last = until ? `${until[1]}-${until[2]}-${until[3]}` : to;
  while (day <= to && day <= last && index < 500) {
    let occurs = !rule || day === first;
    if (rule) {
      const interval = Number(/INTERVAL=(\d+)/.exec(rule)?.[1] ?? 1);
      const frequency = /FREQ=(DAILY|WEEKLY|MONTHLY)/.exec(rule)?.[1];
      const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000);
      const byday = /BYDAY=([A-Z,]+)/.exec(rule)?.[1].split(",");
      const code = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(`${day}T12:00:00Z`).getUTCDay()];
      occurs =
        frequency === "DAILY"
          ? days % interval === 0 && (!byday || byday.includes(code))
          : frequency === "WEEKLY"
            ? Math.floor(days / 7) % interval === 0 &&
              (!byday
                ? new Date(`${day}T12:00:00Z`).getUTCDay() === new Date(`${first}T12:00:00Z`).getUTCDay()
                : byday.includes(code))
            : frequency === "MONTHLY"
              ? new Date(`${day}T12:00:00Z`).getUTCDate() === new Date(`${first}T12:00:00Z`).getUTCDate() &&
                ((new Date(`${day}T12:00:00Z`).getUTCFullYear() - new Date(`${first}T12:00:00Z`).getUTCFullYear()) *
                  12 +
                  new Date(`${day}T12:00:00Z`).getUTCMonth() -
                  new Date(`${first}T12:00:00Z`).getUTCMonth()) %
                  interval ===
                  0
              : false;
    }
    if (occurs && day >= from) {
      const exception = plannerEventExceptions.get(`${event.id}:${day}`);
      if (exception?.action === "replaced" && exception.replacement) {
        const replacement = plannerEvents.find((item) => item.id === exception.replacement);
        if (replacement)
          result.push(
            ...mockEventOccurrences(replacement, from, to).map((item) => ({
              ...item,
              series_id: event.id,
              recurring: true,
            })),
          );
      } else if (!exception)
        result.push({
          event_id: event.id,
          series_id: event.series_id ?? event.id,
          occurrence_key: day,
          title: event.title,
          description: event.description,
          location: event.location,
          meeting_url: event.meeting_url,
          participants: [...event.participants],
          epic_id: event.epic_id,
          color: event.color,
          all_day: event.all_day,
          start_value: event.all_day ? day : new Date(Date.parse(event.start_value) + index * 86400000).toISOString(),
          end_value: event.all_day
            ? plusDays(day, duration)
            : new Date(Date.parse(event.end_value) + index * 86400000).toISOString(),
          timezone: event.timezone,
          recurring: !!rule,
        });
    }
    if (!rule) break;
    day = plusDays(day, 1);
    index++;
  }
  return result;
}

function mockIcalPreview(content: string, sourceKind: string): IcalImportPreview {
  if (content.length > 10 * 1024 * 1024) throw err("invalid", "iCalendar input is larger than 10 MB");
  if (!/BEGIN:VCALENDAR/i.test(content)) throw err("invalid", "input is not an iCalendar document");
  const blocks = content.replace(/\r\n[ \t]/g, "").match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) ?? [];
  if (!blocks.length) throw err("invalid", "iCalendar document has no events");
  const value = (block: string, name: string) =>
    new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, `mi`).exec(block)?.[1].trim() ?? null;
  const dateValue = (raw: string, allDay: boolean) => {
    if (allDay) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const cleaned = raw.replace(/Z$/, "");
    return new Date(
      `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}T${cleaned.slice(9, 11)}:${cleaned.slice(11, 13)}:${cleaned.slice(13, 15)}${raw.endsWith("Z") ? "Z" : ""}`,
    ).toISOString();
  };
  const candidates = blocks.map((block, index) => {
    const uid = value(block, "UID") ?? `event-${index}`,
      recurrence_id = value(block, "RECURRENCE-ID") ?? "",
      startRaw = value(block, "DTSTART");
    if (!startRaw) throw err("invalid", `VEVENT ${uid} is missing DTSTART`);
    const all_day = startRaw.length === 8,
      endRaw =
        value(block, "DTEND") ??
        (all_day ? startRaw : new Date(Date.parse(dateValue(startRaw, false)) + 3600000).toISOString()),
      start_value = dateValue(startRaw, all_day),
      end_value = /^\d{8}(?:T|$)/.test(endRaw) ? dateValue(endRaw, all_day) : endRaw,
      key = `${uid}\0${recurrence_id}`,
      event: CreatePlannerEvent = {
        title: value(block, "SUMMARY") ?? "Untitled event",
        description: value(block, "DESCRIPTION") ?? "",
        location: value(block, "LOCATION") ?? "",
        meeting_url: value(block, "URL"),
        participants: [],
        epic_id: null,
        color: null,
        all_day,
        start_value,
        end_value,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        recurrence_rule: value(block, "RRULE"),
      };
    return {
      key,
      source_uid: uid,
      recurrence_id,
      title: event.title,
      all_day,
      start_value,
      end_value,
      timezone: event.timezone,
      recurrence_rule: event.recurrence_rule,
      duplicate: importedIcal.has(`${sourceKind}:${key}`),
      event,
    };
  });
  return {
    planner_revision: plannerRevision,
    source_kind: sourceKind,
    candidates,
    duplicates: candidates.filter((item) => item.duplicate).length,
  };
}

function mockOverlayRange(from: string, to: string): CalendarOverlayOccurrence[] {
  const source = mockCalendarSubscriptions.find((item) => item.visible);
  if (!source) return [];
  const today = new Date().toISOString().slice(0, 10),
    day = today >= from && today <= to ? today : from,
    start = new Date(`${day}T10:30:00`).toISOString(),
    end = new Date(`${day}T11:15:00`).toISOString();
  return [
    {
      source_id: source.id,
      source_name: source.name,
      uid: "mock-overlay-event",
      title: "Design sync",
      description: "Read-only event from an external iCalendar feed.",
      location: "Studio 4",
      meeting_url: "https://example.com/meeting",
      all_day: false,
      start_value: start,
      end_value: end,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      occurrence_key: day,
      color: source.color,
      read_only: true,
    },
  ];
}

/** Browser testing: what an agent's change in a folder under review leaves behind. */
export function mockPropose(path: string, content: string | null, actor = "claude-code"): number {
  const now = Date.now();
  const existing = files.get(path);
  const p = {
    id: proposals.length + 1,
    path,
    action: (content === null ? "deleted" : existing ? "edited" : "created") as Proposal["action"],
    status: "pending" as const,
    source: "agent",
    actor,
    created: now,
    updated: now,
    decided: null,
    reason: null,
    base_hash: existing ? hash(existing.content) : null,
    hash: content === null ? null : hash(content),
    stale: false,
    overwrote: false,
    binary: false,
    to_path: null,
    update_links: true,
    content,
  };
  proposals.push(p);
  // Like an agent's MCP server writing the history database.
  window.dispatchEvent(new CustomEvent("mock-history-changed"));
  return p.id;
}
// Reachable from the browser console (a module imported by URL can be a separate copy after a hot reload).
(globalThis as { mosaicMock?: object }).mosaicMock = { propose: mockPropose };

const emit = (name: string, detail: unknown) => window.dispatchEvent(new CustomEvent(`mock-${name}`, { detail }));

function updateStatus() {
  return {
    version: "0.1.0",
    commit: "5320ff4",
    app_path: "/Applications/Mosaic.app",
    running: updateRunning,
    ready_to_install: updateBuilt,
    last_install_error: null,
  };
}

/** Plays a short fake build log, so the update flow can be exercised in the browser. */
function fakeUpdate() {
  updateRunning = true;
  const lines = [
    "$ git pull --ff-only",
    "Updating 5320ff4..9a1c2e7",
    "Fast-forward",
    "$ scripts/install.sh --build-only",
    "Lockfile is up to date, resolution step is skipped",
    "   Compiling mosaic-core v0.1.0",
    "   Compiling mosaic-app v0.1.0",
    "    Finished `release` profile [optimized] target(s) in 1m 42s",
    "        Built application at: target/release/bundle/macos/Mosaic.app",
    "BUILT_APP=/Users/you/Developer/mosaic/target/release/bundle/macos/Mosaic.app",
  ];
  updateTimers = lines.map((l, i) => setTimeout(() => emit("update-log", l), 250 * (i + 1)));
  updateTimers.push(
    setTimeout(
      () => {
        updateRunning = false;
        updateBuilt = true;
        emit("update-done", { ok: true, cancelled: false, error: null });
      },
      250 * (lines.length + 1),
    ),
  );
}

function cancelFakeUpdate() {
  if (!updateRunning) return;
  updateTimers.forEach(clearTimeout);
  updateRunning = false;
  emit("update-log", "Cancelling…");
  emit("update-done", { ok: false, cancelled: true, error: "Update cancelled." });
}

// File history, like the core's (crates/mosaic-core/src/history.rs), much simplified.
type MockVersion = Version & { content: string | null };
const versions: MockVersion[] = [];
let nextVersion = 1;
function track(path: string, action: Version["action"], content: string | null, extra: Partial<MockVersion> = {}) {
  versions.push({
    id: nextVersion++,
    path,
    time: Date.now(),
    source: "app",
    actor: null,
    action,
    hash: content === null ? "" : hash(content),
    size: content?.length ?? 0,
    from_path: null,
    content,
    ...extra,
  });
}

let chatRuns = 0;
const mockDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Checkbox tasks of a note, like the core's parser (crates/mosaic-core/src/parse.rs), simplified. */
function mockTasks(path: string, content: string) {
  const out: {
    path: string;
    line: number;
    mark: string;
    text: string;
    depth: number;
    parent: number | null;
    due: string | null;
  }[] = [];
  const stack: { indent: number; line: number }[] = [];
  content.split("\n").forEach((l, i) => {
    const m = /^(\s*)[-*+] \[(.)\](?: (.*))?$/.exec(l);
    if (!m) return;
    const indent = m[1].replace(/\t/g, "    ").length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const text = (m[3] ?? "").trim();
    out.push({
      path,
      line: i + 1,
      mark: m[2],
      text,
      depth: stack.length,
      parent: stack[stack.length - 1]?.line ?? null,
      due: /📅\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null,
    });
    stack.push({ indent, line: i + 1 });
  });
  return out;
}

const mockWorkflow = (text: string, mark: string): WorkflowState => {
  if (mark === "x" || mark === "X") return "done";
  const annotation = /<!--\s*mosaic:state=([\w-]+)\s*-->/.exec(text)?.[1];
  return WORKFLOW_STATES.some((s) => s.id === annotation && s.id !== "done") ? (annotation as WorkflowState) : "new";
};
const taskStatus = (mark: string) =>
  mark === "x" || mark === "X" ? "done" : mark === ">" ? "moved" : mark === "-" ? "cancelled" : "open";

function mockDays(from: string, to: string, today: string) {
  const dailyOf = (p: string) => {
    const iso = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/.exec(p)?.[1];
    if (iso) return iso;
    const format = vaultPreferences.get(mockRoot)?.daily_format;
    const stem = p.split("/").pop()?.replace(/\.md$/, "") ?? "";
    let date: string | null = null;
    if (format === "DD-MM-YYYY" && /^\d{2}-\d{2}-\d{4}$/.test(stem)) date = stem.split("-").reverse().join("-");
    if (format === "YYYYMMDD" && /^\d{8}$/.test(stem))
      date = `${stem.slice(0, 4)}-${stem.slice(4, 6)}-${stem.slice(6)}`;
    return date && mockDay(new Date(`${date}T12:00`)) === date ? date : null;
  };
  const days: { date: string; note: string | null; tasks: unknown[] }[] = [];
  for (let d = new Date(`${from}T12:00`); mockDay(d) <= to; d.setDate(d.getDate() + 1)) {
    const date = mockDay(d);
    const notes = [...files.keys()].filter((p) => dailyOf(p) === date);
    if (notes.length > 1) throw err("invalid", `Two daily notes represent ${date}; rename one before continuing`);
    days.push({ date, note: notes[0] ?? null, tasks: [] });
  }
  const overdue: unknown[] = [];
  for (const [path, f] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.endsWith(".md")) continue;
    for (const t of mockTasks(path, f.content)) {
      const daily = dailyOf(path);
      const task = { ...t, text: taskLabel(t.text), status: taskStatus(t.mark), daily: !!daily };
      const on = daily ?? t.due;
      if (!daily && t.due && task.status === "open" && t.due < today) overdue.push(task);
      days.find((x) => x.date === on)?.tasks.push(task);
    }
  }
  return { days, overdue };
}

function mockAgents(): Agent[] {
  const folder = String(vaultPreferences.get(mockRoot)?.agents_folder ?? "Agents");
  return [...files.entries()]
    .filter(
      ([p]) =>
        p.startsWith(`${folder}/`) &&
        (/^[^/]+\.md$/i.test(p.slice(folder.length + 1)) || /^[^/]+\/SKILL\.md$/i.test(p.slice(folder.length + 1))),
    )
    .map(([path, f]) => {
      const skill = /\/SKILL\.md$/i.test(path);
      const title = skill ? path.slice(folder.length + 1).split("/")[0] : path.split("/").pop()!.replace(/\.md$/i, "");
      const fm = /^---\n([\s\S]*?)\n---/.exec(f.content);
      let props: Record<string, unknown> = {};
      try {
        props = parseYaml(fm?.[1] ?? "") ?? {};
      } catch {
        /* Invalid frontmatter. */
      }
      const body = f.content.slice(fm?.[0].length ?? 0).trim();
      const allowed = props["may-change"] ?? props.may_change;
      const events = props.on;
      return {
        name: String(props.name ?? title)
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, "-")
          .replace(/^-|-$/g, ""),
        title,
        path,
        skill_folder: skill,
        description: String(props.description ?? body.split("\n").find((l) => l.trim()) ?? title),
        schedule: typeof props.schedule === "string" ? props.schedule : null,
        on: Array.isArray(events) ? events.map(String) : typeof events === "string" ? [events] : [],
        model: typeof props.model === "string" ? props.model : null,
        may_change: Array.isArray(allowed) ? allowed.map(String) : typeof allowed === "string" ? [allowed] : [],
        web: props.web === true || ["true", "yes", "on"].includes(String(props.web).toLowerCase()),
        instructions: body,
      };
    });
}

function seed() {
  const now = Date.now();
  const add = (p: string, c: string) => files.set(p, { content: c, mtime: now });
  add(
    "Welcome.md",
    [
      "---",
      "tags: [intro, mosaic]",
      "status: draft",
      "---",
      "# Welcome to Mosaic",
      "",
      "This is a **mock vault** with *live preview*, ~~old~~ ==highlighted== and `inline code`.",
      "",
      "## Links",
      "- Wikilink to [[Ideas]], with alias [[Ideas|my ideas]], heading [[Ideas#Later]]",
      "- Missing: [[Not yet written]]",
      "- External: [Tauri](https://tauri.app) and a #tag/nested",
      "- [ ] open task",
      "- [x] done task",
      "",
      "> A quote that spans",
      "> two lines.",
      "",
      "Inline math $E = mc^2$ and a block:",
      "",
      "$$",
      "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
      "$$",
      "",
      "| Name | Value |",
      "|:-----|------:|",
      "| alpha | 1 |",
      "| beta | 2 |",
      "",
      "```mermaid",
      "graph LR",
      "  A[Human] --> C((Vault))",
      "  B[AI] --> C",
      "```",
      "",
      "A diagram from the vault, embedded:",
      "",
      "![[Diagram.canvas]]",
      "",
      "```ts",
      "const answer: number = 42;",
      "```",
      "",
      "---",
      "",
      "![[Ideas]]",
      "",
    ].join("\n"),
  );
  const ideas = "# Ideas\n\nBack to [[Welcome]].\n\n## Later\n\n- Graph view\n";
  const edited = ideas.replace("- Graph view", "- Graph view\n- File history (added by an agent)");
  add("Ideas.md", edited);
  // An agent's changes, to try File history and AI activity in the browser.
  track("Ideas.md", "before", ideas, { source: "agent", time: now - 3_600_000 });
  track("Ideas.md", "edited", edited, { source: "agent", actor: "claude-code", time: now - 3_500_000 });
  add("Agent notes.md", "# Agent notes\n\nWritten by an agent. The ideas list needs a review.\n");
  track("Agent notes.md", "created", "# Agent notes\n\nWritten by an agent. The ideas list needs a review.\n", {
    source: "agent",
    actor: "claude-code",
    time: now - 600_000,
  });
  add("Projects/Mosaic/Plan.md", "# Plan\n\n1. Build it\n");
  // Daily notes around today, for the calendar.
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return mockDay(d);
  };
  add(`Daily/${day(-1)}.md`, `# ${day(-1)}\n\n- [x] Standup\n- [>] Write the release notes\n- [-] Gym\n`);
  add(
    `Daily/${day(0)}.md`,
    `# ${day(0)}\n\n- [ ] Write the release notes\n    - [x] Outline\n    - [ ] Draft\n    - [ ] Proofread\n- [ ] Call Anna\n- [x] Inbox zero\n`,
  );
  add(
    "Agents/Weekly review.md",
    "---\ndescription: Sum up the week's tasks into Friday's daily note\nschedule: fri 17:00\non: created in Daily/\nmodel: sonnet\n---\nRead this week's daily notes and write a short summary.\n",
  );
  add(
    "Agents/Inbox triage.md",
    "---\ndescription: Sort meeting notes into their projects\n---\nMove each note in Inbox/ to its project folder.\n",
  );
  add(
    "Projects/Mosaic/Tasks.md",
    `# Tasks\n\n- [ ] Ship the calendar 📅 ${day(2)}\n- [ ] Overdue review 📅 ${day(-3)}\n`,
  );
  add("Projects/Data.csv", 'name,value,note\nalpha,1,"quoted, with comma"\nbeta,2,"multi\nline"\ngamma,3,\n');
  add(
    "Diagram.canvas",
    JSON.stringify(
      {
        // Every diagram shape and arrowhead, for trying the diagram tool in the browser.
        nodes: [
          { id: "s0", type: "text", x: 0, y: 0, width: 180, height: 100, text: "Rectangle", shape: "rectangle" },
          {
            id: "s1",
            type: "text",
            x: 260,
            y: 0,
            width: 180,
            height: 100,
            text: "Rounded rectangle",
            shape: "rounded",
          },
          { id: "s2", type: "text", x: 520, y: 0, width: 180, height: 70, text: "Pill", shape: "pill" },
          { id: "s3", type: "text", x: 780, y: 0, width: 180, height: 110, text: "Ellipse", shape: "ellipse" },
          {
            id: "s4",
            type: "text",
            x: 1040,
            y: 0,
            width: 180,
            height: 130,
            text: "Diamond",
            shape: "diamond",
            color: "3",
          },
          {
            id: "s5",
            type: "text",
            x: 0,
            y: 220,
            width: 200,
            height: 100,
            text: "Parallelogram",
            shape: "parallelogram",
          },
          { id: "s6", type: "text", x: 260, y: 220, width: 200, height: 100, text: "Hexagon", shape: "hexagon" },
          {
            id: "s7",
            type: "text",
            x: 520,
            y: 220,
            width: 150,
            height: 130,
            text: "Cylinder",
            shape: "cylinder",
            color: "5",
          },
          { id: "s8", type: "text", x: 780, y: 220, width: 180, height: 120, text: "Document", shape: "document" },
          {
            id: "s9",
            type: "text",
            x: 1040,
            y: 220,
            width: 200,
            height: 100,
            text: "Predefined process",
            shape: "process",
          },
          { id: "s10", type: "text", x: 0, y: 440, width: 200, height: 130, text: "Cloud", shape: "cloud" },
          {
            id: "s11",
            type: "text",
            x: 260,
            y: 440,
            width: 180,
            height: 140,
            text: "Note",
            shape: "note",
            border: "dashed",
          },
          { id: "s12", type: "text", x: 520, y: 440, width: 100, height: 140, text: "Actor", shape: "actor" },
        ],
        edges: [
          { id: "e1", fromNode: "s0", toNode: "s1", label: "arrow" },
          { id: "e2", fromNode: "s1", toNode: "s2", toEnd: "triangle", label: "inherits" },
          { id: "e3", fromNode: "s2", toNode: "s3", toEnd: "open", line: "dashed", label: "depends" },
          {
            id: "e4",
            fromNode: "s5",
            toNode: "s6",
            fromEnd: "diamond",
            toEnd: "none",
            fromLabel: "1",
            toLabel: "1..*",
          },
          { id: "e5", fromNode: "s6", toNode: "s7", fromEnd: "diamond-open", toEnd: "none", line: "dotted" },
          { id: "e6", fromNode: "s12", toNode: "s4", toEnd: "circle", color: "6" },
        ],
      },
      null,
      "\t",
    ),
  );
  add(
    "Board.canvas",
    JSON.stringify(
      {
        nodes: [
          { id: "g1", type: "group", x: -40, y: -60, width: 760, height: 360, label: "Mosaic", color: "5" },
          {
            id: "t1",
            type: "text",
            x: 0,
            y: 0,
            width: 260,
            height: 140,
            text: "# Humans\nWrite **Markdown** here and link [[Ideas]].",
            color: "4",
          },
          { id: "f1", type: "file", x: 400, y: 0, width: 280, height: 220, file: "Ideas.md" },
          { id: "l1", type: "link", x: 0, y: 380, width: 260, height: 70, url: "https://jsoncanvas.org" },
          {
            id: "t2",
            type: "text",
            x: 400,
            y: 380,
            width: 320,
            height: 280,
            text: "## Diagrams in cards\nEnergy: $E = mc^2$\n\n```mermaid\ngraph LR\n  Note --> Canvas --> Diagram\n```",
          },
        ],
        edges: [
          {
            id: "e1",
            fromNode: "t1",
            fromSide: "right",
            toNode: "f1",
            toSide: "left",
            label: "links to",
            keepMe: true,
          },
        ],
        customTopLevel: "preserved",
      },
      null,
      "\t",
    ),
  );
  add(
    "Charts/Sales.vl.json",
    JSON.stringify(
      {
        data: { url: "sales.csv" },
        mark: "line",
        encoding: { x: { field: "month", type: "ordinal", sort: null }, y: { field: "amount", type: "quantitative" } },
      },
      null,
      2,
    ),
  );
  add("Charts/sales.csv", "month,amount\nJan,12\nFeb,19\nMar,15\nApr,26\n");
  add(
    "Graph.dot",
    "digraph G {\n  rankdir=LR;\n  node [shape=box, style=rounded];\n  Human -> Vault; AI -> Vault; Vault -> Docs;\n}\n",
  );
  // Binary files are stored as data URLs in the mock.
  add(
    "Attachments/diagram.svg",
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTIwIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjEyMCIgcng9IjE0IiBmaWxsPSIjNDA5Y2ZmIi8+PHRleHQgeD0iMTYwIiB5PSI3MCIgZm9udC1zaXplPSIyOCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIj5kaWFncmFtLnN2ZzwvdGV4dD48L3N2Zz4=",
  );
  add(
    "Docs/sample.pdf",
    "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA0MjAgMzAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNiAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA4OCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDQwIDIwMCBUZCAoTW9zYWljIHNhbXBsZSBQREYpIFRqIEVUIEJUIC9GMSAxNCBUZiA0MCAxNjAgVGQgKFBhZ2Ugb25lKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA0MjAgMzAwXSAvQ29udGVudHMgNyAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNiAwIFIgPj4gPj4gPj4KZW5kb2JqCjYgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago3IDAgb2JqCjw8IC9MZW5ndGggNDIgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiA0MCAyMDAgVGQgKFNlY29uZCBwYWdlKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwMzg1IDAwMDAwIG4gCjAwMDAwMDA1MTEgMDAwMDAgbiAKMDAwMDAwMDU4MSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDggL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjY3MwolJUVPRgo=",
  );
  add(
    "Docs/page.html",
    '<!doctype html><html><head><style>body{font-family:sans-serif;padding:20px} h1{color:#4078f2}</style></head><body><h1>HTML page</h1><p>Rendered in a <b>sandbox</b>.</p><img src="../Attachments/diagram.svg" width="200"><script>document.body.append("SCRIPT RAN")</script></body></html>',
  );
  add("Projects/notes.txt", "Plain text file.\nSecond line.");
  add("config.json", '{\n  "name": "mosaic",\n  "version": 1\n}\n');
  for (const p of files.keys()) addParents(p);
}
seed();

function addParents(p: string) {
  const parts = p.split("/");
  for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
}

function err(code: CoreError["code"], message: string): CoreError {
  return { code, message, current_hash: null };
}

function norm(p: unknown): string {
  const s = String(p ?? "").replace(/\\/g, "/");
  if (s.startsWith("/")) throw err("invalid_path", `${s} (must be relative to the vault)`);
  const parts = s.split("/").filter((x) => x && x !== ".");
  if (parts.some((x) => x === "..")) throw err("invalid_path", `${s} (.. is not allowed)`);
  if (parts.some((x) => x.startsWith("."))) throw err("invalid_path", `${s} (hidden)`);
  return parts.join("/");
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function entry(path: string): Entry {
  const isDir = dirs.has(path);
  const f = files.get(path);
  return {
    path,
    name: path.split("/").pop() ?? path,
    is_dir: isDir,
    kind: isDir ? null : kindOf(path),
    size: f?.content.length ?? 0,
    mtime: f?.mtime ?? 0,
  };
}

function list(dir: string, recursive: boolean): Entry[] {
  const prefix = dir ? `${dir}/` : "";
  const children = [...dirs, ...files.keys()].filter(
    (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/") && p !== dir,
  );
  const sorted = [...new Set(children)]
    .map(entry)
    .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return sorted.flatMap((e) => (recursive && e.is_dir ? [e, ...list(e.path, true)] : [e]));
}

function exists(p: string) {
  return files.has(p) || dirs.has(p);
}

function write(p: string, content: string) {
  files.set(p, { content, mtime: Date.now() });
  addParents(p);
  return { path: p, hash: hash(content) };
}

const vaultPreferences = new Map<string, Record<string, unknown>>();
export async function mockInvoke(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  if (typeof a.root === "string" && a.root !== mockRoot) throw err("invalid", "The vault changed");
  switch (cmd) {
    case "planner_summary":
      return {
        schema_version: 1,
        revision: plannerRevision,
        epics: plannerEpics.length,
        tasks: plannerTasks.length,
        work_sessions: plannerWorkSessions.length,
        events: plannerEvents.filter((event) => !event.series_id).length,
        is_empty:
          plannerEpics.length === 0 &&
          plannerTasks.length === 0 &&
          plannerWorkSessions.length === 0 &&
          plannerEvents.length === 0,
      };
    case "planner_activity":
      return plannerActivities
        .filter((item) => item.entity_kind === a.entityKind && item.entity_id === a.entityId)
        .map((item) => structuredClone(item));
    case "planner_epics":
      return plannerEpics
        .filter((epic) => (a.includeArchived || !epic.archived_at) && (a.includeTrashed || !epic.trashed_at))
        .sort((x, y) => x.position - y.position)
        .map((epic) => ({ ...epic }));
    case "planner_tasks":
      return plannerTasks
        .filter((task) => (a.includeArchived || !task.archived_at) && (a.includeTrashed || !task.trashed_at))
        .sort((x, y) => x.position - y.position)
        .map((task) => ({ ...task }));
    case "planner_create_epic": {
      const input = a.input as CreatePlannerEpic,
        title = input.title.trim();
      if (!title) throw err("invalid", "Epic title cannot be empty");
      const at = plannerNow(),
        epic: PlannerEpic = {
          id: nextPlannerId("epic"),
          title,
          description: input.description,
          color: input.color,
          position: (plannerEpics.at(-1)?.position ?? 0) + 1024,
          revision: 1,
          created_at: at,
          updated_at: at,
          archived_at: null,
          trashed_at: null,
        };
      plannerEpics.push(epic);
      plannerRecord("epic", epic.id, "created", "Created epic");
      plannerChanged([epic.id]);
      return { ...epic };
    }
    case "planner_update_epic": {
      const epic = plannerEpics.find((item) => item.id === a.id);
      if (!epic) throw err("not_found", "Planner epic not found");
      const input = a.input as UpdatePlannerEpic;
      plannerConflict(epic, input.expected_revision);
      if (typeof input.title === "string") {
        if (!input.title.trim()) throw err("invalid", "Epic title cannot be empty");
        epic.title = input.title.trim();
      }
      if (typeof input.description === "string") epic.description = input.description;
      if (typeof input.color === "string") epic.color = input.color;
      if (typeof input.position === "number") epic.position = input.position;
      epic.revision++;
      epic.updated_at = plannerNow();
      plannerRecord("epic", epic.id, "updated", "Updated epic");
      plannerChanged([epic.id]);
      return { ...epic };
    }
    case "planner_archive_epic":
    case "planner_restore_epic":
    case "planner_trash_epic": {
      const epic = plannerEpics.find((item) => item.id === a.id);
      if (!epic) throw err("not_found", "Planner epic not found");
      plannerConflict(epic, Number(a.expectedRevision));
      const at = plannerNow();
      if (cmd === "planner_archive_epic") epic.archived_at ??= at;
      else if (cmd === "planner_restore_epic") {
        epic.archived_at = null;
        epic.trashed_at = null;
      } else {
        if (!epic.archived_at) throw err("invalid", "Archive an epic before moving it to Trash");
        epic.trashed_at = at;
      }
      epic.revision++;
      epic.updated_at = at;
      plannerRecord(
        "epic",
        epic.id,
        cmd === "planner_archive_epic" ? "archived" : cmd === "planner_restore_epic" ? "restored" : "trashed",
        cmd === "planner_archive_epic"
          ? "Archived epic"
          : cmd === "planner_restore_epic"
            ? "Restored epic"
            : "Trashed epic",
      );
      plannerChanged([epic.id]);
      return { ...epic };
    }
    case "planner_create_task": {
      const input = a.input as CreatePlannerTask,
        title = input.title.trim();
      if (!title) throw err("invalid", "Task title cannot be empty");
      if (input.epic_id && !plannerEpics.some((epic) => epic.id === input.epic_id && !epic.trashed_at))
        throw err("not_found", "Planner epic not found");
      const parent = input.parent_id ? plannerTasks.find((task) => task.id === input.parent_id) : null;
      if (input.parent_id && !parent) throw err("not_found", "Planner parent task not found");
      if (parent && parent.epic_id !== input.epic_id) throw err("invalid", "A subtask must use its parent's epic");
      const at = plannerNow(),
        task: PlannerTask = {
          id: nextPlannerId("task"),
          epic_id: input.epic_id,
          parent_id: input.parent_id,
          title,
          description: input.description,
          status: input.status,
          due_date: input.due_date,
          estimate_minutes: input.estimate_minutes,
          position:
            Math.max(
              0,
              ...plannerTasks
                .filter(
                  (item) =>
                    item.epic_id === input.epic_id &&
                    item.parent_id === input.parent_id &&
                    item.status === input.status,
                )
                .map((item) => item.position),
            ) + 1024,
          revision: 1,
          created_at: at,
          updated_at: at,
          completed_at: input.status === "done" ? at : null,
          archived_at: null,
          trashed_at: null,
        };
      plannerTasks.push(task);
      plannerRecord("task", task.id, "created", "Created task");
      plannerChanged([task.id]);
      return { ...task };
    }
    case "planner_update_task": {
      const task = plannerTasks.find((item) => item.id === a.id);
      if (!task) throw err("not_found", "Planner task not found");
      const input = a.input as UpdatePlannerTask;
      plannerConflict(task, input.expected_revision);
      if (typeof input.title === "string") {
        if (!input.title.trim()) throw err("invalid", "Task title cannot be empty");
        task.title = input.title.trim();
      }
      if (typeof input.description === "string") task.description = input.description;
      if (input.clear_due_date) task.due_date = null;
      else if (typeof input.due_date === "string") task.due_date = input.due_date;
      if (input.clear_estimate) task.estimate_minutes = null;
      else if (typeof input.estimate_minutes === "number") task.estimate_minutes = input.estimate_minutes;
      task.revision++;
      task.updated_at = plannerNow();
      plannerRecord("task", task.id, "updated", "Updated task");
      plannerChanged([task.id]);
      return { ...task };
    }
    case "planner_move_task": {
      const task = plannerTasks.find((item) => item.id === a.id);
      if (!task) throw err("not_found", "Planner task not found");
      const input = a.input as MovePlannerTask;
      plannerConflict(task, input.expected_revision);
      if ((task.status === "done") !== (input.status === "done"))
        throw err("invalid", "Use the complete or reopen operation when crossing the Done boundary");
      const descendants = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of plannerTasks)
          if (
            item.parent_id &&
            (item.parent_id === task.id || descendants.has(item.parent_id)) &&
            !descendants.has(item.id)
          ) {
            descendants.add(item.id);
            changed = true;
          }
      }
      if (input.parent_id === task.id || descendants.has(input.parent_id ?? ""))
        throw err("invalid", "Moving this task there would create a hierarchy cycle");
      const parent = input.parent_id ? plannerTasks.find((item) => item.id === input.parent_id) : null;
      if (input.parent_id && !parent) throw err("not_found", "Planner parent task not found");
      if (parent && parent.epic_id !== input.epic_id) throw err("invalid", "A subtask must use its parent's epic");
      const at = plannerNow();
      Object.assign(task, {
        epic_id: input.epic_id,
        parent_id: input.parent_id,
        status: input.status,
        position: input.position,
        completed_at: input.status === "done" ? (task.completed_at ?? at) : null,
        updated_at: at,
        revision: task.revision + 1,
      });
      for (const id of descendants) {
        const child = plannerTasks.find((item) => item.id === id)!;
        child.epic_id = input.epic_id;
        child.revision++;
        child.updated_at = at;
      }
      plannerRecord("task", task.id, "moved", "Moved task");
      plannerChanged([task.id, ...descendants]);
      return { ...task };
    }
    case "planner_complete_task": {
      const task = plannerTasks.find((item) => item.id === a.id);
      if (!task) throw err("not_found", "Planner task not found");
      plannerConflict(task, Number(a.expectedRevision));
      if (
        !a.allowIncompleteSubtasks &&
        plannerTasks.some((item) => item.parent_id === task.id && item.status !== "done" && !item.archived_at)
      )
        throw err("invalid", "Task has incomplete subtasks; confirm before completing it");
      const at = plannerNow();
      task.status = "done";
      task.completed_at ??= at;
      task.updated_at = at;
      task.revision++;
      if (a.futureSessions === "cancel")
        for (const session of plannerWorkSessions)
          if (session.task_id === task.id && session.state === "planned" && session.start_value > at) {
            session.state = "cancelled";
            session.revision++;
            session.updated_at = at;
          }
      plannerRecord("task", task.id, "completed", "Completed task");
      plannerChanged([task.id]);
      return { ...task };
    }
    case "planner_reopen_task":
    case "planner_archive_task":
    case "planner_restore_task":
    case "planner_trash_task": {
      const task = plannerTasks.find((item) => item.id === a.id);
      if (!task) throw err("not_found", "Planner task not found");
      plannerConflict(task, Number(a.expectedRevision));
      const at = plannerNow();
      if (cmd === "planner_reopen_task") {
        task.status = "new";
        task.completed_at = null;
      } else if (cmd === "planner_archive_task") task.archived_at ??= at;
      else if (cmd === "planner_restore_task") {
        task.archived_at = null;
        task.trashed_at = null;
      } else {
        if (!task.archived_at) throw err("invalid", "Archive a task before moving it to Trash");
        task.trashed_at = at;
      }
      task.updated_at = at;
      task.revision++;
      plannerRecord(
        "task",
        task.id,
        cmd === "planner_reopen_task"
          ? "reopened"
          : cmd === "planner_archive_task"
            ? "archived"
            : cmd === "planner_restore_task"
              ? "restored"
              : "trashed",
        cmd === "planner_reopen_task"
          ? "Reopened task"
          : cmd === "planner_archive_task"
            ? "Archived task"
            : cmd === "planner_restore_task"
              ? "Restored task"
              : "Trashed task",
      );
      plannerChanged([task.id]);
      return { ...task };
    }
    case "planner_work_sessions":
      return plannerWorkSessions
        .filter(
          (session) =>
            (!a.taskId || session.task_id === a.taskId) && (a.includeCancelled || session.state !== "cancelled"),
        )
        .map((session) => ({ ...session }));
    case "planner_create_work_session": {
      const input = a.input as CreatePlannerWorkSession,
        task = plannerTasks.find((item) => item.id === input.task_id);
      if (!task) throw err("not_found", "Planner task not found");
      if (task.status === "done" || task.archived_at)
        throw err("invalid", "Work sessions can only be added to active incomplete tasks");
      if (Date.parse(input.end_value) <= Date.parse(input.start_value) && !input.all_day)
        throw err("invalid", "Session end must be after start");
      if (input.all_day && input.end_value <= input.start_value)
        throw err("invalid", "Session end must be after start");
      const at = plannerNow(),
        session: PlannerWorkSession = {
          id: nextPlannerId("session"),
          task_id: input.task_id,
          all_day: input.all_day,
          start_value: input.start_value,
          end_value: input.end_value,
          timezone: input.timezone,
          state: "planned",
          revision: 1,
          created_at: at,
          updated_at: at,
        };
      plannerWorkSessions.push(session);
      plannerChanged([session.id, session.task_id]);
      return { ...session };
    }
    case "planner_update_work_session": {
      const session = plannerWorkSessions.find((item) => item.id === a.id);
      if (!session) throw err("not_found", "Planner work session not found");
      const input = a.input as UpdatePlannerWorkSession;
      plannerConflict(session, input.expected_revision);
      if (session.state === "cancelled") throw err("invalid", "A cancelled work session cannot be moved or resized");
      Object.assign(session, {
        all_day: input.all_day,
        start_value: input.start_value,
        end_value: input.end_value,
        timezone: input.timezone,
        revision: session.revision + 1,
        updated_at: plannerNow(),
      });
      plannerChanged([session.id, session.task_id]);
      return { ...session };
    }
    case "planner_cancel_work_session": {
      const session = plannerWorkSessions.find((item) => item.id === a.id);
      if (!session) throw err("not_found", "Planner work session not found");
      plannerConflict(session, Number(a.expectedRevision));
      session.state = "cancelled";
      session.revision++;
      session.updated_at = plannerNow();
      plannerChanged([session.id, session.task_id]);
      return { ...session };
    }
    case "planner_events":
      return plannerEvents
        .filter(
          (event) =>
            !event.series_id && (a.includeArchived || !event.archived_at) && (a.includeTrashed || !event.trashed_at),
        )
        .map((event) => structuredClone(event));
    case "planner_create_event": {
      const input = a.input as CreatePlannerEvent,
        title = input.title.trim();
      if (!title) throw err("invalid", "Event title cannot be empty");
      const at = plannerNow(),
        event: PlannerEvent = {
          ...structuredClone(input),
          id: nextPlannerId("event"),
          series_id: null,
          title,
          revision: 1,
          created_at: at,
          updated_at: at,
          archived_at: null,
          trashed_at: null,
        };
      plannerEvents.push(event);
      plannerRecord("event", event.id, "created", "Created event");
      plannerChanged([event.id]);
      return structuredClone(event);
    }
    case "planner_update_event": {
      const event = plannerEvents.find((item) => item.id === a.id);
      if (!event) throw err("not_found", "Planner event not found");
      const input = a.input as UpdatePlannerEvent;
      plannerConflict(event, input.expected_revision);
      if (!input.title.trim()) throw err("invalid", "Event title cannot be empty");
      Object.assign(event, structuredClone(input), {
        title: input.title.trim(),
        revision: event.revision + 1,
        updated_at: plannerNow(),
      });
      plannerRecord("event", event.id, "updated", "Updated event");
      plannerChanged([event.id]);
      return structuredClone(event);
    }
    case "planner_archive_event":
    case "planner_restore_event":
    case "planner_trash_event": {
      const event = plannerEvents.find((item) => item.id === a.id);
      if (!event) throw err("not_found", "Planner event not found");
      plannerConflict(event, Number(a.expectedRevision));
      const at = plannerNow();
      if (cmd === "planner_archive_event") event.archived_at ??= at;
      else if (cmd === "planner_restore_event") {
        event.archived_at = null;
        event.trashed_at = null;
      } else {
        if (!event.archived_at) throw err("invalid", "Archive an event before moving it to Trash");
        event.trashed_at = at;
      }
      event.revision++;
      event.updated_at = at;
      plannerRecord(
        "event",
        event.id,
        cmd === "planner_archive_event" ? "archived" : cmd === "planner_restore_event" ? "restored" : "trashed",
        cmd === "planner_archive_event"
          ? "Archived event"
          : cmd === "planner_restore_event"
            ? "Restored event"
            : "Trashed event",
      );
      plannerChanged([event.id]);
      return structuredClone(event);
    }
    case "planner_cancel_event_occurrence": {
      const event = plannerEvents.find((item) => item.id === a.seriesId);
      if (!event) throw err("not_found", "Planner event not found");
      plannerConflict(event, Number(a.expectedRevision));
      plannerEventExceptions.set(`${event.id}:${a.occurrenceKey}`, { action: "cancelled", replacement: null });
      event.revision++;
      event.updated_at = plannerNow();
      plannerChanged([event.id]);
      return structuredClone(event);
    }
    case "planner_replace_event_occurrence": {
      const event = plannerEvents.find((item) => item.id === a.seriesId);
      if (!event) throw err("not_found", "Planner event not found");
      plannerConflict(event, Number(a.expectedRevision));
      const input = a.input as CreatePlannerEvent,
        at = plannerNow(),
        replacement: PlannerEvent = {
          ...structuredClone(input),
          id: nextPlannerId("event"),
          series_id: event.id,
          recurrence_rule: null,
          revision: 1,
          created_at: at,
          updated_at: at,
          archived_at: null,
          trashed_at: null,
        };
      plannerEvents.push(replacement);
      plannerEventExceptions.set(`${event.id}:${a.occurrenceKey}`, { action: "replaced", replacement: replacement.id });
      event.revision++;
      event.updated_at = at;
      plannerChanged([event.id, replacement.id]);
      return structuredClone(replacement);
    }
    case "planner_calendar_range": {
      const from = String(a.from),
        to = String(a.to),
        roots = plannerEvents.filter((event) => !event.series_id && !event.archived_at && !event.trashed_at),
        events = roots.flatMap((event) => mockEventOccurrences(event, from, to));
      const sessions = plannerWorkSessions
        .filter(
          (session) =>
            session.state === "planned" && isoDay(session.start_value) <= to && isoDay(session.end_value) >= from,
        )
        .flatMap((session) => {
          const task = plannerTasks.find((item) => item.id === session.task_id);
          if (!task) return [];
          return [
            {
              session: { ...session },
              task_title: task.title,
              task_status: task.status,
              epic_id: task.epic_id,
              color: plannerEpics.find((epic) => epic.id === task.epic_id)?.color ?? null,
            },
          ];
        });
      const due_markers = plannerTasks
        .filter(
          (task) =>
            task.due_date && task.due_date >= from && task.due_date <= to && !task.archived_at && !task.trashed_at,
        )
        .map((task) => ({
          task_id: task.id,
          title: task.title,
          date: task.due_date!,
          status: task.status,
          epic_id: task.epic_id,
          color: plannerEpics.find((epic) => epic.id === task.epic_id)?.color ?? null,
        }));
      const unscheduled_tasks = plannerTasks
        .filter((task) => task.status !== "done" && !task.archived_at && !task.trashed_at)
        .map((task) => ({ ...task }));
      const workload = [];
      for (let day = from; day <= to; day = plusDays(day, 1)) {
        let minutes = 0;
        for (const item of sessions)
          if (isoDay(item.session.start_value) === day)
            minutes += item.session.all_day
              ? (plannerTasks.find((task) => task.id === item.session.task_id)?.estimate_minutes ?? 60)
              : Math.max(0, (Date.parse(item.session.end_value) - Date.parse(item.session.start_value)) / 60000);
        workload.push({ date: day, minutes });
      }
      return { from, to, events, work_sessions: sessions, due_markers, unscheduled_tasks, workload };
    }
    case "planner_ical_preview":
      return mockIcalPreview(String(a.content), String(a.sourceKind));
    case "planner_ical_import": {
      const preview = a.preview as IcalImportPreview,
        selected = new Set(a.selectedKeys as string[]),
        known = new Set(preview.candidates.map((item) => item.key));
      for (const key of selected)
        if (!known.has(key)) throw err("invalid", "iCalendar selection contains an unknown event");
      const imported_event_ids: string[] = [],
        skipped_duplicates: string[] = [];
      for (const candidate of preview.candidates.filter((item) => selected.has(item.key))) {
        const fingerprint = `${preview.source_kind}:${candidate.key}`;
        if (importedIcal.has(fingerprint) && !a.allowDuplicates) {
          skipped_duplicates.push(candidate.key);
          continue;
        }
        const at = plannerNow(),
          event: PlannerEvent = {
            ...structuredClone(candidate.event),
            id: nextPlannerId("event"),
            series_id: null,
            revision: 1,
            created_at: at,
            updated_at: at,
            archived_at: null,
            trashed_at: null,
          };
        plannerEvents.push(event);
        importedIcal.add(fingerprint);
        imported_event_ids.push(event.id);
      }
      if (imported_event_ids.length) plannerChanged(imported_event_ids);
      return { planner_revision: plannerRevision, imported_event_ids, skipped_duplicates };
    }
    case "planner_ical_export":
      return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mosaic//Planner//EN\r\n${plannerEvents
        .filter((item) => !item.series_id && !item.archived_at && !item.trashed_at)
        .map(
          (item) =>
            `BEGIN:VEVENT\r\nUID:mosaic-${item.id}@local\r\nSUMMARY:${item.title}\r\nDTSTART${item.all_day ? ";VALUE=DATE" : ""}:${item.all_day ? item.start_value.replaceAll("-", "") : item.start_value.replaceAll(/[-:]/g, "").replace(".000", "")}\r\nDTEND${item.all_day ? ";VALUE=DATE" : ""}:${item.all_day ? item.end_value.replaceAll("-", "") : item.end_value.replaceAll(/[-:]/g, "").replace(".000", "")}\r\nEND:VEVENT\r\n`,
        )
        .join("")}END:VCALENDAR\r\n`;
    case "planner_ical_export_file":
      return String(a.path);
    case "planner_export": {
      if (a.format === "json")
        return `${JSON.stringify(
          {
            format_version: 1,
            exported_at: plannerNow(),
            summary: await mockInvoke("planner_summary", {}),
            epics: plannerEpics,
            tasks: plannerTasks,
            work_sessions: plannerWorkSessions,
            events: plannerEvents.filter((item) => !item.series_id),
            activity: plannerActivities,
          },
          null,
          2,
        )}\n`;
      if (a.format === "csv")
        return (
          "entity_type,id,parent_id,epic_id,status,title,start,end,due_date,estimate_minutes,archived_at,trashed_at\r\n" +
          plannerTasks
            .map(
              (item) =>
                `"task","${item.id}","${item.parent_id ?? ""}","${item.epic_id ?? ""}","${item.status}","${item.title.replaceAll('"', '""')}","","","${item.due_date ?? ""}","${item.estimate_minutes ?? ""}","${item.archived_at ?? ""}","${item.trashed_at ?? ""}"`,
            )
            .join("\r\n") +
          "\r\n"
        );
      throw err("invalid", "planner export must be JSON or CSV");
    }
    case "planner_export_file":
      return String(a.path);
    case "planner_restore_backup":
      return `${String(a.path)}/.mosaic/planner.sqlite3`;
    case "calendar_subscriptions":
      return structuredClone(mockCalendarSubscriptions);
    case "add_calendar_subscription": {
      const name = String(a.name).trim(),
        url = String(a.url);
      if (!name || !/^https?:\/\/|^webcal:\/\//i.test(url))
        throw err("invalid", "subscription name and HTTPS or webcal URL are required");
      const item: CalendarSubscription = {
        id: nextPlannerId("subscription"),
        name,
        color: String(a.color),
        visible: true,
        refresh_minutes: Number(a.refreshMinutes),
        last_success: new Date().toISOString(),
        last_error: null,
        has_cache: true,
      };
      mockCalendarSubscriptions.push(item);
      return structuredClone(item);
    }
    case "update_calendar_subscription": {
      const item = mockCalendarSubscriptions.find((value) => value.id === a.id);
      if (!item) throw err("not_found", "Calendar subscription not found");
      Object.assign(item, {
        name: String(a.name),
        color: String(a.color),
        visible: Boolean(a.visible),
        refresh_minutes: Number(a.refreshMinutes),
      });
      return structuredClone(item);
    }
    case "remove_calendar_subscription": {
      const index = mockCalendarSubscriptions.findIndex((value) => value.id === a.id);
      if (index < 0) throw err("not_found", "Calendar subscription not found");
      mockCalendarSubscriptions.splice(index, 1);
      return null;
    }
    case "refresh_calendar_subscriptions": {
      for (const item of mockCalendarSubscriptions) {
        item.last_success = new Date().toISOString();
        item.last_error = null;
      }
      return structuredClone(mockCalendarSubscriptions);
    }
    case "calendar_overlay_range":
      return {
        subscriptions: structuredClone(mockCalendarSubscriptions),
        occurrences: mockOverlayRange(String(a.from), String(a.to)),
      };
    case "planner_migration_preview": {
      const groups: { source_path: string; tasks: MarkdownImportCandidate[] }[] = [];
      for (const [path, file] of [...files.entries()].sort(([x], [y]) => x.localeCompare(y))) {
        if (!path.endsWith(".md")) continue;
        const rows = mockTasks(path, file.content),
          byLine = new Map<number, string>(),
          byRow = new Map(rows.map((row) => [row.line, row])),
          candidates: MarkdownImportCandidate[] = [];
        for (const row of rows) {
          const block = /\s\^([\w-]+)\s*$/.exec(row.text)?.[1] ?? null;
          const clean =
            taskLabel(row.text)
              .replace(/\s\^[\w-]+\s*$/, "")
              .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, "")
              .trim() || "Untitled task";
          const fingerprint = hash(block ? `${path}\0block\0${block}` : `${path}\0line\0${row.line}\0${clean}`);
          byLine.set(row.line, fingerprint);
          let ancestor = byRow.get(row.line);
          while (ancestor?.parent) ancestor = byRow.get(ancestor.parent);
          const epic_fingerprint = ancestor
            ? (byLine.get(ancestor.line) ?? (ancestor.line === row.line ? fingerprint : null))
            : null;
          const kind = row.depth === 0 ? "epic" : row.depth === 1 ? "task" : "subtask";
          const status =
            row.mark.toLowerCase() === "x"
              ? "done"
              : row.mark === ">" || row.mark === "-"
                ? "new"
                : mockWorkflow(row.text, row.mark);
          const archived = row.mark === ">" || row.mark === "-";
          candidates.push({
            source_path: path,
            source_line: row.line,
            block_id: block,
            fingerprint,
            parent_fingerprint: row.parent ? (byLine.get(row.parent) ?? null) : null,
            epic_fingerprint,
            depth: row.depth,
            kind,
            title: clean,
            status,
            due_date: row.due,
            all_day_session_date: null,
            archived,
            default_selected: !archived && (kind === "epic" || status !== "done"),
            duplicate: importedFingerprints.has(fingerprint),
          });
        }
        if (candidates.length) groups.push({ source_path: path, tasks: candidates });
      }
      const all = groups.flatMap((group) => group.tasks);
      return {
        planner_revision: plannerRevision,
        groups,
        candidates: all.length,
        selected_by_default: all.filter((item) => item.default_selected && !item.duplicate).length,
        duplicates: all.filter((item) => item.duplicate).length,
      } satisfies MarkdownImportPreview;
    }
    case "planner_import_markdown": {
      const preview = a.preview as MarkdownImportPreview,
        selected = new Set(a.selectedFingerprints as string[]),
        all = preview.groups.flatMap((group) => group.tasks),
        known = new Set(all.map((item) => item.fingerprint));
      for (const item of selected)
        if (!known.has(item)) throw err("invalid", "Migration selection contains an unknown task");
      const importedEpicIds: string[] = [],
        importedTaskIdsNow: string[] = [],
        skipped: string[] = [],
        mappedEpics = new Map<string, string>(),
        mappedTasks = new Map<string, string>();
      for (const item of all
        .filter((item) => selected.has(item.fingerprint))
        .sort((x, y) => x.depth - y.depth || x.source_line - y.source_line)) {
        if (!a.allowDuplicates && importedFingerprints.has(item.fingerprint)) {
          skipped.push(item.fingerprint);
          const priorEpic = importedEpicIdsByFingerprint.get(item.fingerprint),
            priorTask = importedTaskIds.get(item.fingerprint);
          if (priorEpic) mappedEpics.set(item.fingerprint, priorEpic);
          if (priorTask) mappedTasks.set(item.fingerprint, priorTask);
          continue;
        }
        const at = plannerNow();
        if (item.kind === "epic") {
          const id = nextPlannerId("epic"),
            created: PlannerEpic = {
              id,
              title: item.title,
              description: "",
              color: "#6477d4",
              position: (plannerEpics.at(-1)?.position ?? 0) + 1024,
              revision: 1,
              created_at: at,
              updated_at: at,
              archived_at: item.archived ? at : null,
              trashed_at: null,
            };
          plannerEpics.push(created);
          importedFingerprints.add(item.fingerprint);
          importedEpicIdsByFingerprint.set(item.fingerprint, id);
          mappedEpics.set(item.fingerprint, id);
          importedEpicIds.push(id);
          continue;
        }
        const id = nextPlannerId("task"),
          epic_id = item.epic_fingerprint
            ? (mappedEpics.get(item.epic_fingerprint) ??
              importedEpicIdsByFingerprint.get(item.epic_fingerprint) ??
              null)
            : null,
          parentCandidate = item.parent_fingerprint
            ? all.find((candidate) => candidate.fingerprint === item.parent_fingerprint)
            : null,
          parent_id =
            parentCandidate?.kind === "epic"
              ? null
              : item.parent_fingerprint
                ? (mappedTasks.get(item.parent_fingerprint) ?? importedTaskIds.get(item.parent_fingerprint) ?? null)
                : null;
        const created: PlannerTask = {
          id,
          epic_id,
          parent_id,
          title: item.title,
          description: "",
          status: item.status,
          due_date: item.due_date,
          estimate_minutes: null,
          position:
            Math.max(
              0,
              ...plannerTasks
                .filter(
                  (task) => task.epic_id === epic_id && task.parent_id === parent_id && task.status === item.status,
                )
                .map((task) => task.position),
            ) + 1024,
          revision: 1,
          created_at: at,
          updated_at: at,
          completed_at: item.status === "done" ? at : null,
          archived_at: item.archived ? at : null,
          trashed_at: null,
        };
        plannerTasks.push(created);
        importedFingerprints.add(item.fingerprint);
        importedTaskIds.set(item.fingerprint, created.id);
        mappedTasks.set(item.fingerprint, created.id);
        importedTaskIdsNow.push(created.id);
      }
      const affected = [...importedEpicIds, ...importedTaskIdsNow];
      if (affected.length) plannerChanged(affected);
      return {
        planner_revision: plannerRevision,
        imported_epic_ids: importedEpicIds,
        imported_task_ids: importedTaskIdsNow,
        skipped_duplicates: skipped,
      };
    }
    case "vault_preferences": {
      const { DEFAULT_VAULT_PREFS } = await import("../state/vaultPreferences");
      return { ...DEFAULT_VAULT_PREFS, ...vaultPreferences.get(mockRoot) };
    }
    case "set_vault_preferences": {
      if (a.root !== mockRoot) throw err("invalid", "The vault changed");
      vaultPreferences.set(mockRoot, { ...vaultPreferences.get(mockRoot), ...(a.patch as object) });
      emit("settings-changed", {});
      return null;
    }
    case "template_config":
      return templateConfigs.get(mockRoot) ?? defaultTemplateConfig();
    case "set_template_config": {
      const c = a.config as TemplateConfig;
      if (c.version !== 1 || !c.folder || c.folder.includes(".."))
        throw err("invalid", "Choose a valid Templates folder");
      if (new Set(c.rules.map((r) => r.folder.toLowerCase())).size !== c.rules.length)
        throw err("invalid", "Each folder needs one template rule");
      if (
        c.rules.some(
          (r) => r.template && (!inFolder(r.template, c.folder) || !r.template.toLowerCase().endsWith(".md")),
        )
      )
        throw err("invalid", "Defaults must reference Markdown files inside the Templates folder");
      templateConfigs.set(mockRoot, structuredClone(c));
      emit("settings-changed", {});
      return null;
    }
    case "list_templates": {
      const c = templateConfigs.get(mockRoot) ?? defaultTemplateConfig();
      return {
        templates: [...files.keys()]
          .filter((p) => p.endsWith(".md") && inFolder(p, c.folder))
          .sort()
          .map((path) => ({ path, name: path.split("/").pop() })),
        default: a.path ? templateDefault(c, String(a.path)) : { template: null, rule_folder: null },
      };
    }
    case "render_template": {
      const r = a.request as TemplateRequest,
        c = templateConfigs.get(mockRoot) ?? defaultTemplateConfig();
      const path = norm(r.path);
      if (!path.toLowerCase().endsWith(".md")) throw err("invalid_path", "A note needs a .md extension");
      if (r.blank && r.template) throw err("invalid", "Choose a template or Blank");
      const resolved = r.blank
        ? { template: null, rule_folder: null }
        : r.template
          ? { template: r.template, rule_folder: null }
          : templateDefault(c, path);
      let source = "",
        sourceHash: string | null = null;
      if (resolved.template) {
        if (!inFolder(resolved.template, c.folder))
          throw err("invalid", "Choose a template inside the Templates folder");
        const f = files.get(resolved.template);
        if (!f) throw err("not_found", `Template missing: ${resolved.template}`);
        source = f.content;
        sourceHash = hash(source);
        if (r.expected_template_hash && sourceHash !== r.expected_template_hash)
          throw err("conflict", "Template changed; refresh the preview");
      }
      const d = new Date(r.timestamp ?? Date.now()),
        title = path.split("/").pop()!.slice(0, -3);
      const context = {
        title,
        date: mockDay(d),
        time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
        weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
        timestamp: r.timestamp ?? d.toISOString(),
      };
      const content = fillTemplate(
        source.replace(/\{\{\s*title\s*\}\}/g, () => title),
        d,
      );
      return {
        path,
        content,
        template: resolved.template,
        template_hash: sourceHash,
        rule_folder: resolved.rule_folder,
        context,
      };
    }
    case "create_note": {
      const p = (await mockInvoke("render_template", a)) as import("./types").TemplatePreview;
      if (exists(p.path)) throw err("already_exists", `already exists: ${p.path}`);
      const out = write(p.path, p.content);
      track(p.path, "created", p.content);
      return { ...out, template: p.template, rule_folder: p.rule_folder };
    }
    case "template_starters":
      return Object.entries({
        Meeting: ["Participants", "Purpose", "Agenda", "Notes", "Decisions", "Actions"],
        Retro: ["Context", "What went well", "What to improve", "Themes", "Agreed actions"],
        Project: ["Purpose", "Outcomes", "Scope", "Stakeholders", "Milestones", "Decisions", "Risks", "Next actions"],
        Analysis: ["Question", "Context", "Evidence", "Assumptions", "Options", "Recommendation", "Open questions"],
        Brainstorm: ["Prompt", "Constraints", "Ideas", "Themes", "Promising directions", "Next experiments"],
      }).map(([name, sections]) => [
        `${name}.md`,
        `# {{title}}\n\nDate: {{date}}\n\n${sections.map((s) => `## ${s}\n`).join("\n")}\n`,
      ]);
    case "open_vault":
      opened = true;
      mockRoot = String(a.path ?? "/mock/vault");
      return { root: mockRoot, name: "Mock vault" };
    case "current_vault":
      return opened ? { root: mockRoot, name: "Mock vault" } : null;
    case "last_vault":
      return null;
    case "create_vault":
      opened = true;
      return { root: `${String(a.parent)}/${String(a.name)}`, name: String(a.name) };
    case "recent_vaults":
      return [
        { root: "/mock/vault", name: "Mock vault", exists: true },
        { root: "/mock/Work notes", name: "Work notes", exists: true },
        { root: "/Volumes/USB/Old vault", name: "Old vault", exists: false },
      ];
    case "forget_vault":
      return null;
    case "update_status":
      return updateStatus();
    case "check_updates":
      await new Promise((r) => setTimeout(r, 600));
      return {
        latest_version: "0.2.0",
        releases: [
          {
            version: "0.2.0",
            date: "2026-10-01",
            notes: [
              "**Movable window:** drag the sidebar header, tab bar or welcome screen. Updates show the current `version` and *release notes*.",
              "A running update can be cancelled; the installed app stays as it was.",
            ],
          },
        ],
        update_available: true,
      };
    case "start_update":
      if (updateRunning) throw err("invalid", "An update is already running.");
      fakeUpdate();
      return null;
    case "cancel_update":
      cancelFakeUpdate();
      return null;
    case "finish_update":
      window.location.reload();
      return null;
    case "get_bookmarks":
      return bookmarks;
    case "set_bookmarks":
      bookmarks = [...(a.paths as string[])];
      return null;
    case "copy_path": {
      const from = files.get(norm(a.from));
      if (!from) throw err("not_found", `not found: ${norm(a.from)}`);
      const to = norm(a.to);
      if (exists(to)) throw err("already_exists", `already exists: ${to}`);
      return write(to, from.content);
    }
    case "import_file": {
      // Binary files are kept as data: URLs, like the mock's sample images.
      const p = norm(a.path);
      const bytes = a.bytes as Uint8Array;
      const kind = kindOf(p);
      const content = ["image", "pdf", "other"].includes(kind)
        ? `data:${kind === "pdf" ? "application/pdf" : `image/${p.split(".").pop()}`};base64,${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))}`
        : new TextDecoder().decode(bytes);
      const dot = p.lastIndexOf(".") > p.lastIndexOf("/") + 1 ? p.lastIndexOf(".") : p.length;
      let target = p;
      for (let n = 1; exists(target); n++) target = `${p.slice(0, dot)} ${n}${p.slice(dot)}`;
      return write(target, content);
    }
    case "list_dir":
      return list(norm(a.dir), Boolean(a.recursive));
    case "read_file": {
      const p = norm(a.path);
      const f = files.get(p);
      if (!f) throw err("not_found", `not found: ${p}`);
      const kind = kindOf(p);
      const text = !["image", "pdf", "other"].includes(kind);
      const out: FileContent = {
        path: p,
        kind,
        size: f.content.length,
        mtime: f.mtime,
        hash: hash(f.content),
        content: text ? f.content : null,
      };
      return out;
    }
    case "unlinked_mentions": {
      // Simplified: whole-word, case-insensitive title matches outside [[links]].
      const target = norm(a.path);
      const title = target.split("/").pop()!.replace(/\.md$/, "");
      const word = new RegExp(
        `(^|[^\\p{L}\\p{N}])(${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^\\p{L}\\p{N}])`,
        "iu",
      );
      const out: { source: string; line: number; context: string; text: string }[] = [];
      for (const [p, f] of files) {
        if (p === target || !p.endsWith(".md") || f.content.includes(`[[${title}`)) continue;
        f.content.split("\n").forEach((l, i) => {
          const m = word.exec(l.replace(/\[\[[^\]]*\]\]/g, (x) => " ".repeat(x.length)));
          if (m) out.push({ source: p, line: i + 1, context: l.trim(), text: m[2] });
        });
      }
      return out;
    }
    case "link_mention": {
      const p = norm(a.source);
      const f = files.get(p)!;
      const lines = f.content.split("\n");
      const text = String(a.text);
      const title = norm(a.target).split("/").pop()!.replace(/\.md$/, "");
      lines[Number(a.line) - 1] = lines[Number(a.line) - 1].replace(
        text,
        text === title ? `[[${title}]]` : `[[${title}|${text}]]`,
      );
      return write(p, lines.join("\n"));
    }
    case "get_agent_rules":
      return agentRules;
    case "set_agent_rules":
      agentRules = a.rules as typeof agentRules;
      return null;
    case "file_history":
      return versions
        .filter((v) => v.path === norm(a.path))
        .reverse()
        .map(({ content: _c, ...v }) => v);
    case "version_content":
      return versions.find((v) => v.id === a.id)?.content ?? "";
    case "ai_activity":
      return versions
        .filter((v) => (v.source === "agent" || v.source === "cli") && v.action !== "before")
        .reverse()
        .map(({ content: _c, ...v }) => v);
    case "restore_version": {
      const p = norm(a.path);
      const content = versions.find((v) => v.id === a.id)?.content ?? "";
      const out = write(p, content);
      track(p, "restored", content);
      return out;
    }
    case "undo_change": {
      const v = versions.find((x) => x.id === a.id);
      if (!v) throw err("not_found", "change not found");
      const cur = files.get(v.path);
      if (v.action === "created") files.delete(v.path);
      else if (v.action === "deleted") write(v.path, v.content ?? "");
      else {
        if (cur && hash(cur.content) !== v.hash)
          throw { code: "conflict", message: `${v.path} changed since`, current_hash: hash(cur.content) };
        const prev = versions.filter((x) => x.path === v.path && x.id < v.id && x.content !== null).pop();
        if (!prev) throw err("invalid", "no earlier version");
        write(v.path, prev.content ?? "");
        track(v.path, "restored", prev.content);
      }
      window.dispatchEvent(new CustomEvent("mock-vault-changed", { detail: { paths: [v.path] } }));
      return v.path;
    }
    case "create_file": {
      const p = norm(a.path);
      if (exists(p)) throw err("already_exists", `already exists: ${p}`);
      return write(p, String(a.content ?? ""));
    }
    case "write_file": {
      const p = norm(a.path);
      const cur = files.get(p);
      if (a.expectedHash && cur && hash(cur.content) !== a.expectedHash) {
        throw { code: "conflict", message: `file changed: ${p}`, current_hash: hash(cur.content) };
      }
      const out = write(p, String(a.content ?? ""));
      track(p, cur ? "edited" : "created", String(a.content ?? ""));
      return out;
    }
    case "make_dir": {
      const p = norm(a.path);
      dirs.add(p);
      addParents(p);
      return null;
    }
    case "rename_path": {
      const from = norm(a.from);
      const to = norm(a.to);
      if (!exists(from)) throw err("not_found", `not found: ${from}`);
      if (exists(to) && from.toLowerCase() !== to.toLowerCase()) throw err("already_exists", `already exists: ${to}`);
      if (to.startsWith(`${from}/`)) throw err("invalid_path", `cannot move ${from} into itself`);
      const move = (p: string) => (p === from ? to : `${to}${p.slice(from.length)}`);
      const under = (p: string) => p === from || p.startsWith(`${from}/`);
      const c = templateConfigs.get(mockRoot);
      if (c) {
        if (under(c.folder)) c.folder = move(c.folder);
        for (const r of c.rules) {
          if (under(r.folder)) r.folder = move(r.folder);
          if (r.template && under(r.template)) r.template = move(r.template);
        }
      }
      const preferences = vaultPreferences.get(mockRoot);
      if (preferences) {
        for (const key of [
          "agents_folder",
          "daily_folder",
          "daily_template",
          "new_note_folder",
          "attachment_folder",
          "startup_note",
        ]) {
          const value = preferences[key];
          if (typeof value === "string" && under(value)) preferences[key] = move(value);
        }
        const colors = preferences.folder_colors as Record<string, string> | undefined;
        if (colors)
          preferences.folder_colors = Object.fromEntries(
            Object.entries(colors).map(([path, color]) => [under(path) ? move(path) : path, color]),
          );
      }
      for (const [p, f] of [...files])
        if (under(p)) {
          files.delete(p);
          files.set(move(p), f);
        }
      for (const d of [...dirs])
        if (under(d)) {
          dirs.delete(d);
          dirs.add(move(d));
        }
      addParents(to);
      track(to, "renamed", null, { from_path: from });
      return { path: to, updated_links_in: [], review: null };
    }
    case "delete_path": {
      const p = norm(a.path);
      if (!exists(p)) throw err("not_found", `not found: ${p}`);
      const under = (x: string) => x === p || x.startsWith(`${p}/`);
      for (const k of [...files.keys()])
        if (under(k)) {
          track(k, "deleted", files.get(k)!.content);
          files.delete(k);
        }
      for (const d of [...dirs]) if (under(d)) dirs.delete(d);
      return null;
    }
    case "search": {
      const terms = String(a.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (!terms.length) return [];
      const hits: SearchHit[] = [];
      for (const [path, f] of files) {
        const hay = `${path}\n${f.content}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
        const i = f.content.toLowerCase().indexOf(terms[0]);
        const snippet =
          i < 0
            ? ""
            : `…${f.content.slice(Math.max(0, i - 40), i)}**${f.content.slice(i, i + terms[0].length)}**${f.content.slice(i + terms[0].length, i + 60)}…`;
        hits.push({
          path,
          title: path.split("/").pop()!.replace(/\.md$/, ""),
          snippet: snippet.replace(/\n/g, " "),
          score: 1,
        });
      }
      return hits;
    }
    case "proposals": {
      const list = proposals
        .filter((p) => a.includeDecided || p.status === "pending")
        .map(({ content: _c, ...p }) => ({
          ...p,
          overwrote: false,
          stale:
            p.status === "pending" && (files.has(p.path) ? hash(files.get(p.path)!.content) : null) !== p.base_hash,
        }));
      return list;
    }
    case "proposal_content":
      return proposals.find((p) => p.id === a.id)?.content ?? null;
    case "proposal_base":
      return null;
    case "accept_proposal":
    case "reject_proposal": {
      const p = proposals.find((x) => x.id === a.id && x.status === "pending");
      if (!p) throw err("not_found", `proposal ${a.id}`);
      if (cmd === "accept_proposal") {
        const current = files.has(p.path) ? hash(files.get(p.path)!.content) : null;
        if (current !== p.base_hash && !a.force) throw err("conflict", `file changed since it was read: ${p.path}`);
        const accepted = typeof a.content === "string" ? a.content : p.content;
        if (accepted === null) files.delete(p.path);
        else write(p.path, accepted);
        track(p.path, p.action, accepted, { source: "agent", actor: p.actor });
        emit("vault-changed", { paths: [p.path] });
      }
      Object.assign(p, {
        status: cmd === "accept_proposal" ? "accepted" : "rejected",
        reason: (a.reason as string | null) ?? null,
        decided: Date.now(),
      });
      return cmd === "accept_proposal" ? p.path : null;
    }
    case "set_task": {
      const f = files.get(a.path as string);
      if (!f) throw err("not_found", String(a.path));
      const lines = f.content.split("\n");
      const i = (a.line as number) - 1;
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\].*)$/.exec(lines[i] ?? "");
      if (!m || taskLabel(m[3].slice(1).trim()) !== a.text) throw err("conflict", String(a.path));
      lines[i] =
        `${m[1]}${a.done ? "x" : " "}${a.done ? m[3] : m[3].replace(/\s*<!--\s*mosaic:state=done\s*-->/g, "")}`;
      f.content = lines.join("\n");
      f.mtime = Date.now();
      emit("vault-changed", { paths: [a.path] });
      return { path: a.path, hash: hash(f.content) };
    }
    case "set_task_workflow": {
      const f = files.get(a.path as string);
      if (!f) throw err("not_found", String(a.path));
      if (!WORKFLOW_STATES.some((s) => s.id === a.next)) throw err("invalid", "Unknown workflow state");
      const lines = f.content.split("\n");
      const i = Number(a.line) - 1;
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)(.*)$/.exec(lines[i] ?? "");
      const state = m && mockWorkflow(m[4], m[2]);
      if (!m || taskLabel(m[4]) !== a.text || state !== a.expectedState) throw err("conflict", String(a.path));
      lines[i] = `${m[1]}${a.next === "done" ? "x" : " "}${m[3]}${annotatedTask(m[4], a.next as WorkflowState)}`;
      write(String(a.path), lines.join("\n"));
      track(String(a.path), "edited", lines.join("\n"));
      emit("vault-changed", { paths: [a.path] });
      return { path: a.path, hash: hash(files.get(String(a.path))!.content) };
    }
    case "agents":
      return mockAgents();
    case "chat_check":
      return { path: "/mock/claude", version: "mock" };
    case "chat_send": {
      // A canned answer, streamed, for trying the chat panel in the browser.
      const run = ++chatRuns;
      const target = (a.context as string[])[0] ?? "Ideas.md";
      const steps: unknown[] = [
        { kind: "started", session_id: "mock-session", mosaic: true },
        { kind: "tool", id: "t1", summary: `Read ${target.replace(/\.md$/, "")}`, path: target, writes: false },
        { kind: "tool_done", id: "t1", error: null, review: null },
        {
          kind: "text",
          text: a.agent
            ? `Running the **${a.agent}** agent.`
            : `You asked: *${String(a.message).slice(0, 80)}*.${a.selectionText ? " I also received the selected text." : ""}${a.model ? ` Model: ${a.model}.` : ""}`,
        },
        { kind: "tool", id: "t2", summary: "Edited Ideas", path: "Ideas.md", writes: true },
        { kind: "tool_done", id: "t2", error: null, review: null },
        { kind: "text", text: "Done: I added a line to [[Ideas]].\n\n- one\n- two" },
        { kind: "done", session_id: "mock-session", cost_usd: 0.0123, error: null },
      ];
      steps.forEach((event, i) => setTimeout(() => emit("chat-event", { run, event }), 250 * (i + 1)));
      return run;
    }
    case "chat_stop":
      return null;
    case "mirror_agents":
      return { written: [], removed: [], skipped: [] };
    case "tessera_status":
      return {
        paused: tesseraPaused,
        max_chain_depth: tesseraMaxDepth,
        agents: mockAgents().map((a) => ({
          name: a.name,
          title: a.title,
          schedule: a.schedule,
          on: a.on,
          model: a.model,
          paused: tesseraPausedAgents.includes(a.name),
          running: tesseraRuns.some((r) => r.agent === a.name && r.status === "running"),
          queued: 0,
          error: null,
        })),
        runs: tesseraRuns,
      };
    case "tessera_pause_all":
      tesseraPaused = Boolean(a.paused);
      return null;
    case "tessera_pause_agent": {
      const name = String(a.name);
      const i = tesseraPausedAgents.indexOf(name);
      if (i >= 0) tesseraPausedAgents.splice(i, 1);
      if (a.paused) tesseraPausedAgents.push(name);
      return null;
    }
    case "tessera_set_max_chain_depth":
      tesseraMaxDepth = Number(a.depth);
      return null;
    case "tessera_run": {
      const agent = mockAgents().find((agent) => agent.name === a.name);
      if (!agent) throw err("not_found", "Agent not found");
      const id = ++chatRuns;
      tesseraRuns.unshift({
        id,
        agent: agent.name,
        title: agent.title,
        started: Math.floor(Date.now() / 1000),
        finished: Math.floor(Date.now() / 1000),
        late: false,
        status: "done",
        answer: "Mock run completed. No files were changed.",
        error: null,
        proposals: 0,
        changes: [],
        changed_paths: [],
        proposal_ids: [],
      });
      emit("tessera-changed", {});
      return id;
    }
    case "tessera_test_event": {
      const agent = mockAgents().find((agent) => agent.name === a.name);
      if (!agent) throw err("not_found", "Agent not found");
      const id = ++chatRuns;
      tesseraRuns.unshift({
        id,
        agent: agent.name,
        title: agent.title,
        started: Math.floor(Date.now() / 1000),
        finished: Math.floor(Date.now() / 1000),
        late: false,
        status: "done",
        trigger: `Test · ${a.path}`,
        trigger_path: String(a.path),
        chain_id: `test-${id}`,
        chain_depth: 0,
        model: agent.model,
        attempts: 1,
        answer: "Mock event run completed.",
        error: null,
        proposals: 0,
        changes: [],
        changed_paths: [],
        proposal_ids: [],
      });
      emit("tessera-changed", {});
      return id;
    }
    case "days":
      return mockDays(a.from as string, a.to as string, a.today as string);
    case "carry_over":
      return { from: null, to: a.path ?? `${a.day}.md`, moved: 0, created: false };
    case "query_notes":
      return mockQuery(String(a.query ?? ""));
    case "backlinks": {
      const target = norm(a.path).split("/").pop()!.replace(/\.md$/, "").toLowerCase();
      const out: Backlink[] = [];
      for (const [path, f] of files) {
        f.content.split("\n").forEach((l, i) => {
          for (const m of l.matchAll(/(!?)\[\[([^\]|#^]+)/g)) {
            if (m[2].split("/").pop()!.toLowerCase() === target)
              out.push({ source: path, line: i + 1, context: l.trim(), embed: m[1] === "!" });
          }
        });
      }
      return out;
    }
    case "tags": {
      const counts = new Map<string, number>();
      for (const f of files.values())
        for (const m of f.content.matchAll(/(?:^|\s)#([\w/-]+)/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      return [...counts].map(([tag, count]) => ({ tag, count }));
    }
    case "aliases":
      return [];
    case "cli_info":
    case "install_cli":
      return {
        path: "/Applications/Mosaic.app/Contents/MacOS/mosaic",
        link: "~/.local/bin/mosaic",
        installed: cmd === "install_cli",
      };
    case "read_raw": {
      const f = files.get(norm(a.path));
      if (!f) throw err("not_found", `not found: ${a.path}`);
      return f.content;
    }
    case "absolute_path":
      return `/mock/vault/${norm(a.path)}`;
    // The mock's renames always finish.
    case "unfinished_renames":
      return [];
    case "fix_links":
      throw err("invalid", `there is no unfinished move ${a.id}`);
    default:
      throw err("invalid", `mock: unknown command ${cmd}`);
  }
}

/** A small subset of the core's query language (tag:, folder:, field=value and friends, sort:, limit:, show:). */
function mockQuery(q: string): QueryResult {
  const tokens = q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  let rows: QueryRow[] = [...files].map(([path, f]) => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(f.content);
    let props: Record<string, unknown> = {};
    try {
      props = (fm && (parseYaml(fm[1]) as Record<string, unknown>)) || {};
    } catch {
      /* keep empty */
    }
    const tags = [
      ...(Array.isArray(props.tags) ? props.tags.map(String) : []),
      ...[...f.content.matchAll(/(?:^|\s)#([\w/-]+)/g)].map((m) => m[1]),
    ];
    return { path, title: path.split("/").pop()!.replace(/\.md$/, ""), modified: f.mtime, tags, props };
  });
  const columns: string[] = [];
  const sort: [string, boolean][] = [];
  let limit = 100;
  const taskToken = tokens.find((t) => t.startsWith("task:"));
  if (taskToken) {
    const wanted = taskToken.slice(5).split("|");
    rows = rows.flatMap((r) =>
      mockTasks(r.path, files.get(r.path)!.content)
        .filter((t) => wanted.includes("all") || wanted.includes(taskStatus(t.mark)))
        .map((t) => ({
          ...r,
          task: { ...t, status: taskStatus(t.mark), text: taskLabel(t.text), workflow: mockWorkflow(t.text, t.mark) },
        })),
    );
  }
  const value = (r: QueryRow, f: string) =>
    f === "title"
      ? r.title
      : f === "path"
        ? r.path
        : r.task && f in r.task
          ? r.task[f as keyof typeof r.task]
          : r.props[f];
  for (const tok of tokens) {
    const t = tok.replace(/"/g, "");
    let m: RegExpExecArray | null;
    if (t.startsWith("task:")) continue;
    if ((m = /^(-?)tag:(.+)$/.exec(t))) {
      const want = m[2].split("|");
      rows = rows.filter(
        (r) => r.tags.some((x) => want.some((w) => x === w || x.startsWith(`${w}/`))) !== (m![1] === "-"),
      );
    } else if ((m = /^folder:(.+)$/.exec(t))) rows = rows.filter((r) => r.path.startsWith(`${m![1]}/`));
    else if ((m = /^sort:(-?)(.+)$/.exec(t))) sort.push([m[2], m[1] === "-"]);
    else if ((m = /^limit:(\d+)$/.exec(t))) limit = Number(m[1]);
    else if ((m = /^show:(.+)$/.exec(t))) columns.push(...m[1].split(","));
    else if ((m = /^([\w.-]+)(!=|=|>|<|~)(.+)$/.exec(t))) {
      const [, f, op, v] = m;
      if (!columns.includes(f)) columns.push(f);
      rows = rows.filter((r) => {
        const x = String(value(r, f) ?? "").toLowerCase();
        const y = v.toLowerCase();
        return op === "="
          ? x === y
          : op === "!="
            ? x !== y
            : op === ">"
              ? x > y
              : op === "<"
                ? x < y && x !== ""
                : x.includes(y);
      });
    } else
      rows = rows.filter((r) => (r.task?.text ?? files.get(r.path)!.content).toLowerCase().includes(t.toLowerCase()));
  }
  for (const [f, desc] of sort.reverse())
    rows.sort((a, b) => String(value(a, f) ?? "").localeCompare(String(value(b, f) ?? "")) * (desc ? -1 : 1));
  return { columns, rows: rows.slice(0, limit), total: rows.length };
}
