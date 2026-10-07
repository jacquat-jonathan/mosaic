// In-memory stand-in for mosaic-core, used when the UI runs outside Tauri (browser dev, Vitest).
// It mirrors the core's semantics closely enough for UI work; it is not a second implementation to keep in sync
// feature-for-feature.

import type { Agent, AgentRun, Backlink, CoreError, Entry, FileContent, Proposal, QueryResult, QueryRow, SearchHit, Version } from "./types";
import { kindOf } from "./kinds";
import { parse as parseYaml } from "yaml";

interface MockFile {
  content: string;
  mtime: number;
}

const files = new Map<string, MockFile>();
const dirs = new Set<string>();
let opened = false;
let bookmarks: string[] = ["Welcome.md"];
let updateSource: string | null = null;
let updateBuilt = false;
let updateRunning = false;
let updateTimers: ReturnType<typeof setTimeout>[] = [];
let agentRules: { path: string; access: string }[] = [];
let tesseraPaused = false;
let tesseraMaxDepth = 3;
const tesseraPausedAgents: string[] = [];
const tesseraRuns: AgentRun[] = [];
const proposals: (Proposal & { content: string | null })[] = [];

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
  return p.id;
}
// Reachable from the browser console (a module imported by URL can be a separate copy after a hot reload).
(globalThis as { mosaicMock?: object }).mosaicMock = { propose: mockPropose };

const emit = (name: string, detail: unknown) => window.dispatchEvent(new CustomEvent(`mock-${name}`, { detail }));

function updateStatus() {
  return {
    version: "0.1.0",
    commit: "5320ff4",
    source_dir: updateSource ?? "/Users/you/Developer/mosaic",
    source_problem: updateSource?.includes("nope") ? `${updateSource} isn't a Mosaic source checkout (no .git or scripts/install.sh).` : null,
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
    setTimeout(() => {
      updateRunning = false;
      updateBuilt = true;
      emit("update-done", { ok: true, cancelled: false, error: null });
    }, 250 * (lines.length + 1)),
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
  versions.push({ id: nextVersion++, path, time: Date.now(), source: "app", actor: null, action, hash: content === null ? "" : hash(content), size: content?.length ?? 0, from_path: null, content, ...extra });
}

let chatRuns = 0;
const mockDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Checkbox tasks of a note, like the core's parser (crates/mosaic-core/src/parse.rs), simplified. */
function mockTasks(path: string, content: string) {
  const out: { path: string; line: number; mark: string; text: string; depth: number; parent: number | null; due: string | null }[] = [];
  const stack: { indent: number; line: number }[] = [];
  content.split("\n").forEach((l, i) => {
    const m = /^(\s*)[-*+] \[(.)\](?: (.*))?$/.exec(l);
    if (!m) return;
    const indent = m[1].replace(/\t/g, "    ").length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const text = (m[3] ?? "").trim();
    out.push({ path, line: i + 1, mark: m[2], text, depth: stack.length, parent: stack[stack.length - 1]?.line ?? null, due: /📅\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null });
    stack.push({ indent, line: i + 1 });
  });
  return out;
}

const taskStatus = (mark: string) => (mark === "x" || mark === "X" ? "done" : mark === ">" ? "moved" : mark === "-" ? "cancelled" : "open");

function mockDays(from: string, to: string, today: string) {
  const dailyOf = (p: string) => /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/.exec(p)?.[1] ?? null;
  const days: { date: string; note: string | null; tasks: unknown[] }[] = [];
  for (let d = new Date(`${from}T12:00`); mockDay(d) <= to; d.setDate(d.getDate() + 1)) {
    const date = mockDay(d);
    days.push({ date, note: [...files.keys()].find((p) => dailyOf(p) === date) ?? null, tasks: [] });
  }
  const overdue: unknown[] = [];
  for (const [path, f] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.endsWith(".md")) continue;
    for (const t of mockTasks(path, f.content)) {
      const daily = dailyOf(path);
      const task = { ...t, status: taskStatus(t.mark), daily: !!daily };
      const on = daily ?? t.due;
      if (!daily && t.due && task.status === "open" && t.due < today) overdue.push(task);
      days.find((x) => x.date === on)?.tasks.push(task);
    }
  }
  return { days, overdue };
}

function mockAgents(): Agent[] {
  return [...files.entries()].filter(([p])=>/^Agents\/[^/]+\.md$/.test(p) || /^Agents\/[^/]+\/SKILL\.md$/i.test(p)).map(([path,f])=>{
    const skill=/\/SKILL\.md$/i.test(path); const title=skill ? path.split("/")[1] : path.split("/").pop()!.replace(/\.md$/i, "");
    const fm=/^---\n([\s\S]*?)\n---/.exec(f.content);
    let props: Record<string, unknown> = {}; try { props=parseYaml(fm?.[1] ?? "") ?? {}; } catch { /* Invalid frontmatter. */ }
    const body=f.content.slice(fm?.[0].length ?? 0).trim();
    const allowed=props["may-change"] ?? props.may_change;
    const events=props.on;
    return {name:String(props.name ?? title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-|-$/g,""),title,path,skill_folder:skill,description:String(props.description ?? body.split("\n").find(l=>l.trim()) ?? title),schedule:typeof props.schedule === "string" ? props.schedule : null,on:Array.isArray(events) ? events.map(String) : typeof events === "string" ? [events] : [],model:typeof props.model === "string" ? props.model : null,may_change:Array.isArray(allowed) ? allowed.map(String) : typeof allowed === "string" ? [allowed] : [],instructions:body};
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
  track("Agent notes.md", "created", "# Agent notes\n\nWritten by an agent. The ideas list needs a review.\n", { source: "agent", actor: "claude-code", time: now - 600_000 });
  add("Projects/Mosaic/Plan.md", "# Plan\n\n1. Build it\n");
  // Daily notes around today, for the calendar.
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return mockDay(d);
  };
  add(`Daily/${day(-1)}.md`, `# ${day(-1)}\n\n- [x] Standup\n- [>] Write the release notes\n- [-] Gym\n`);
  add(`Daily/${day(0)}.md`, `# ${day(0)}\n\n- [ ] Write the release notes\n    - [x] Outline\n    - [ ] Draft\n    - [ ] Proofread\n- [ ] Call Anna\n- [x] Inbox zero\n`);
  add("Agents/Weekly review.md", "---\ndescription: Sum up the week's tasks into Friday's daily note\nschedule: fri 17:00\non: created in Daily/\nmodel: sonnet\n---\nRead this week's daily notes and write a short summary.\n");
  add("Agents/Inbox triage.md", "---\ndescription: Sort meeting notes into their projects\n---\nMove each note in Inbox/ to its project folder.\n");
  add("Projects/Mosaic/Tasks.md", `# Tasks\n\n- [ ] Ship the calendar 📅 ${day(2)}\n- [ ] Overdue review 📅 ${day(-3)}\n`);
  add("Projects/Data.csv", 'name,value,note\nalpha,1,"quoted, with comma"\nbeta,2,"multi\nline"\ngamma,3,\n');
  add(
    "Diagram.canvas",
    JSON.stringify(
      {
        // Every diagram shape and arrowhead, for trying the diagram tool in the browser.
        nodes: [
          { id: "s0", type: "text", x: 0, y: 0, width: 180, height: 100, text: "Rectangle", shape: "rectangle" },
          { id: "s1", type: "text", x: 260, y: 0, width: 180, height: 100, text: "Rounded rectangle", shape: "rounded" },
          { id: "s2", type: "text", x: 520, y: 0, width: 180, height: 70, text: "Pill", shape: "pill" },
          { id: "s3", type: "text", x: 780, y: 0, width: 180, height: 110, text: "Ellipse", shape: "ellipse" },
          { id: "s4", type: "text", x: 1040, y: 0, width: 180, height: 130, text: "Diamond", shape: "diamond", color: "3" },
          { id: "s5", type: "text", x: 0, y: 220, width: 200, height: 100, text: "Parallelogram", shape: "parallelogram" },
          { id: "s6", type: "text", x: 260, y: 220, width: 200, height: 100, text: "Hexagon", shape: "hexagon" },
          { id: "s7", type: "text", x: 520, y: 220, width: 150, height: 130, text: "Cylinder", shape: "cylinder", color: "5" },
          { id: "s8", type: "text", x: 780, y: 220, width: 180, height: 120, text: "Document", shape: "document" },
          { id: "s9", type: "text", x: 1040, y: 220, width: 200, height: 100, text: "Predefined process", shape: "process" },
          { id: "s10", type: "text", x: 0, y: 440, width: 200, height: 130, text: "Cloud", shape: "cloud" },
          { id: "s11", type: "text", x: 260, y: 440, width: 180, height: 140, text: "Note", shape: "note", border: "dashed" },
          { id: "s12", type: "text", x: 520, y: 440, width: 100, height: 140, text: "Actor", shape: "actor" },
        ],
        edges: [
          { id: "e1", fromNode: "s0", toNode: "s1", label: "arrow" },
          { id: "e2", fromNode: "s1", toNode: "s2", toEnd: "triangle", label: "inherits" },
          { id: "e3", fromNode: "s2", toNode: "s3", toEnd: "open", line: "dashed", label: "depends" },
          { id: "e4", fromNode: "s5", toNode: "s6", fromEnd: "diamond", toEnd: "none", fromLabel: "1", toLabel: "1..*" },
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
          { id: "t1", type: "text", x: 0, y: 0, width: 260, height: 140, text: "# Humans\nWrite **Markdown** here and link [[Ideas]].", color: "4" },
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
        edges: [{ id: "e1", fromNode: "t1", fromSide: "right", toNode: "f1", toSide: "left", label: "links to", keepMe: true }],
        customTopLevel: "preserved",
      },
      null,
      "\t",
    ),
  );
  add("Charts/Sales.vl.json", JSON.stringify({ data: { url: "sales.csv" }, mark: "line", encoding: { x: { field: "month", type: "ordinal", sort: null }, y: { field: "amount", type: "quantitative" } } }, null, 2));
  add("Charts/sales.csv", "month,amount\nJan,12\nFeb,19\nMar,15\nApr,26\n");
  add("Graph.dot", "digraph G {\n  rankdir=LR;\n  node [shape=box, style=rounded];\n  Human -> Vault; AI -> Vault; Vault -> Docs;\n}\n");
  // Binary files are stored as data URLs in the mock.
  add("Attachments/diagram.svg", "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTIwIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjEyMCIgcng9IjE0IiBmaWxsPSIjNDA5Y2ZmIi8+PHRleHQgeD0iMTYwIiB5PSI3MCIgZm9udC1zaXplPSIyOCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIj5kaWFncmFtLnN2ZzwvdGV4dD48L3N2Zz4=");
  add("Docs/sample.pdf", "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA0MjAgMzAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNiAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA4OCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDQwIDIwMCBUZCAoTW9zYWljIHNhbXBsZSBQREYpIFRqIEVUIEJUIC9GMSAxNCBUZiA0MCAxNjAgVGQgKFBhZ2Ugb25lKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA0MjAgMzAwXSAvQ29udGVudHMgNyAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNiAwIFIgPj4gPj4gPj4KZW5kb2JqCjYgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago3IDAgb2JqCjw8IC9MZW5ndGggNDIgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiA0MCAyMDAgVGQgKFNlY29uZCBwYWdlKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwMzg1IDAwMDAwIG4gCjAwMDAwMDA1MTEgMDAwMDAgbiAKMDAwMDAwMDU4MSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDggL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjY3MwolJUVPRgo=");
  add("Docs/page.html", '<!doctype html><html><head><style>body{font-family:sans-serif;padding:20px} h1{color:#4078f2}</style></head><body><h1>HTML page</h1><p>Rendered in a <b>sandbox</b>.</p><img src="../Attachments/diagram.svg" width="200"><script>document.body.append("SCRIPT RAN")</script></body></html>');
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

export async function mockInvoke(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "open_vault":
      opened = true;
      return { root: "/mock/vault", name: "Mock vault" };
    case "current_vault":
      return opened ? { root: "/mock/vault", name: "Mock vault" } : null;
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
    case "set_update_source":
      updateSource = (a.path as string | null) ?? null;
      return updateStatus();
    case "check_updates":
      await new Promise((r) => setTimeout(r, 600));
      return {
        branch: "main",
        upstream: "origin/main",
        latest_version: "0.2.0",
        releases: [
          {
            version: "0.2.0",
            date: "2026-10-01",
            notes: [
              "The window can be moved again by dragging the sidebar header, the tab bar or the welcome screen.",
              "A running update can be cancelled; the installed app stays as it was.",
            ],
          },
        ],
        behind: [
          { hash: "9a1c2e7", subject: "M10: settings panel and in-app updates" },
          { hash: "41d0b3a", subject: "Fix tree drag onto collapsed folders" },
        ],
        ahead: 0,
        source_head: "5320ff4",
        installed_outdated: false,
        dirty: false,
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
        path: p, kind, size: f.content.length, mtime: f.mtime, hash: hash(f.content),
        content: text ? f.content : null,
      };
      return out;
    }
    case "unlinked_mentions": {
      // Simplified: whole-word, case-insensitive title matches outside [[links]].
      const target = norm(a.path);
      const title = target.split("/").pop()!.replace(/\.md$/, "");
      const word = new RegExp(`(^|[^\\p{L}\\p{N}])(${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^\\p{L}\\p{N}])`, "iu");
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
      lines[Number(a.line) - 1] = lines[Number(a.line) - 1].replace(text, text === title ? `[[${title}]]` : `[[${title}|${text}]]`);
      return write(p, lines.join("\n"));
    }
    case "get_agent_rules":
      return agentRules;
    case "set_agent_rules":
      agentRules = a.rules as typeof agentRules;
      return null;
    case "file_history":
      return versions.filter((v) => v.path === norm(a.path)).reverse().map(({ content: _c, ...v }) => v);
    case "version_content":
      return versions.find((v) => v.id === a.id)?.content ?? "";
    case "ai_activity":
      return versions.filter((v) => (v.source === "agent" || v.source === "cli") && v.action !== "before").reverse().map(({ content: _c, ...v }) => v);
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
        if (cur && hash(cur.content) !== v.hash) throw { code: "conflict", message: `${v.path} changed since`, current_hash: hash(cur.content) };
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
      for (const [p, f] of [...files]) if (under(p)) { files.delete(p); files.set(move(p), f); }
      for (const d of [...dirs]) if (under(d)) { dirs.delete(d); dirs.add(move(d)); }
      addParents(to);
      track(to, "renamed", null, { from_path: from });
      return { path: to, updated_links_in: [], review: null };
    }
    case "delete_path": {
      const p = norm(a.path);
      if (!exists(p)) throw err("not_found", `not found: ${p}`);
      const under = (x: string) => x === p || x.startsWith(`${p}/`);
      for (const k of [...files.keys()]) if (under(k)) { track(k, "deleted", files.get(k)!.content); files.delete(k); }
      for (const d of [...dirs]) if (under(d)) dirs.delete(d);
      return null;
    }
    case "search": {
      const terms = String(a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return [];
      const hits: SearchHit[] = [];
      for (const [path, f] of files) {
        const hay = `${path}\n${f.content}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
        const i = f.content.toLowerCase().indexOf(terms[0]);
        const snippet = i < 0 ? "" : `…${f.content.slice(Math.max(0, i - 40), i)}**${f.content.slice(i, i + terms[0].length)}**${f.content.slice(i + terms[0].length, i + 60)}…`;
        hits.push({ path, title: path.split("/").pop()!.replace(/\.md$/, ""), snippet: snippet.replace(/\n/g, " "), score: 1 });
      }
      return hits;
    }
    case "proposals": {
      const list = proposals.filter((p) => a.includeDecided || p.status === "pending").map(({ content: _c, ...p }) => ({ ...p, overwrote: false, stale: p.status === "pending" && (files.has(p.path) ? hash(files.get(p.path)!.content) : null) !== p.base_hash }));
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
      Object.assign(p, { status: cmd === "accept_proposal" ? "accepted" : "rejected", reason: (a.reason as string | null) ?? null, decided: Date.now() });
      return cmd === "accept_proposal" ? p.path : null;
    }
    case "set_task": {
      const f = files.get(a.path as string);
      if (!f) throw err("not_found", String(a.path));
      const lines = f.content.split("\n");
      const i = (a.line as number) - 1;
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\].*)$/.exec(lines[i] ?? "");
      if (!m) throw err("conflict", String(a.path));
      lines[i] = `${m[1]}${a.done ? "x" : " "}${m[3]}`;
      f.content = lines.join("\n");
      f.mtime = Date.now();
      emit("vault-changed", { paths: [a.path] });
      return { path: a.path, hash: hash(f.content) };
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
        { kind: "text", text: a.agent ? `Running the **${a.agent}** agent.` : `You asked: *${String(a.message).slice(0, 80)}*.${a.selectionText ? " I also received the selected text." : ""}${a.model ? ` Model: ${a.model}.` : ""}` },
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
      return { paused: tesseraPaused, max_chain_depth: tesseraMaxDepth, agents: mockAgents().map(a=>({name:a.name,title:a.title,schedule:a.schedule,on:a.on,model:a.model,paused:tesseraPausedAgents.includes(a.name),running:tesseraRuns.some(r=>r.agent===a.name&&r.status==="running"),queued:0,error:null})), runs: tesseraRuns };
    case "tessera_pause_all":
      tesseraPaused = Boolean(a.paused); return null;
    case "tessera_pause_agent": {
      const name = String(a.name); const i = tesseraPausedAgents.indexOf(name);
      if (i >= 0) tesseraPausedAgents.splice(i, 1); if (a.paused) tesseraPausedAgents.push(name); return null;
    }
    case "tessera_set_max_chain_depth": tesseraMaxDepth=Number(a.depth); return null;
    case "tessera_run": {
      const agent=mockAgents().find(agent=>agent.name === a.name);
      if (!agent) throw err("not_found", "Agent not found");
      const id=++chatRuns;
      tesseraRuns.unshift({id,agent:agent.name,title:agent.title,started:Math.floor(Date.now()/1000),finished:Math.floor(Date.now()/1000),late:false,status:"done",answer:"Mock run completed. No files were changed.",error:null,proposals:0,changes:[],changed_paths:[],proposal_ids:[]});
      emit("tessera-changed",{}); return id;
    }
    case "tessera_test_event": {
      const agent=mockAgents().find(agent=>agent.name === a.name);
      if (!agent) throw err("not_found", "Agent not found");
      const id=++chatRuns;
      tesseraRuns.unshift({id,agent:agent.name,title:agent.title,started:Math.floor(Date.now()/1000),finished:Math.floor(Date.now()/1000),late:false,status:"done",trigger:`Test · ${a.path}`,trigger_path:String(a.path),chain_id:`test-${id}`,chain_depth:0,model:agent.model,attempts:1,answer:"Mock event run completed.",error:null,proposals:0,changes:[],changed_paths:[],proposal_ids:[]});
      emit("tessera-changed",{}); return id;
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
            if (m[2].split("/").pop()!.toLowerCase() === target) out.push({ source: path, line: i + 1, context: l.trim(), embed: m[1] === "!" });
          }
        });
      }
      return out;
    }
    case "tags": {
      const counts = new Map<string, number>();
      for (const f of files.values()) for (const m of f.content.matchAll(/(?:^|\s)#([\w/-]+)/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      return [...counts].map(([tag, count]) => ({ tag, count }));
    }
    case "aliases":
      return [];
    case "cli_info":
    case "install_cli":
      return { path: "/Applications/Mosaic.app/Contents/MacOS/mosaic", link: "~/.local/bin/mosaic", installed: cmd === "install_cli" };
    case "read_raw": {
      const f = files.get(norm(a.path));
      if (!f) throw err("not_found", `not found: ${a.path}`);
      return f.content;
    }
    case "absolute_path":
      return `/mock/vault/${norm(a.path)}`;
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
    const tags = [...(Array.isArray(props.tags) ? props.tags.map(String) : []), ...[...f.content.matchAll(/(?:^|\s)#([\w/-]+)/g)].map((m) => m[1])];
    return { path, title: path.split("/").pop()!.replace(/\.md$/, ""), modified: f.mtime, tags, props };
  });
  const columns: string[] = [];
  const sort: [string, boolean][] = [];
  let limit = 100;
  const value = (r: QueryRow, f: string) => (f === "title" ? r.title : f === "path" ? r.path : r.props[f]);
  for (const tok of tokens) {
    const t = tok.replace(/"/g, "");
    let m: RegExpExecArray | null;
    if ((m = /^(-?)tag:(.+)$/.exec(t))) {
      const want = m[2].split("|");
      rows = rows.filter((r) => r.tags.some((x) => want.some((w) => x === w || x.startsWith(`${w}/`))) !== (m![1] === "-"));
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
        return op === "=" ? x === y : op === "!=" ? x !== y : op === ">" ? x > y : op === "<" ? x < y && x !== "" : x.includes(y);
      });
    } else rows = rows.filter((r) => files.get(r.path)!.content.toLowerCase().includes(t.toLowerCase()));
  }
  for (const [f, desc] of sort.reverse()) rows.sort((a, b) => String(value(a, f) ?? "").localeCompare(String(value(b, f) ?? "")) * (desc ? -1 : 1));
  return { columns, rows: rows.slice(0, limit), total: rows.length };
}
