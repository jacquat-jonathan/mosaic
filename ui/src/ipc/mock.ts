// In-memory stand-in for mosaic-core, used when the UI runs outside Tauri (browser dev, Vitest).
// It mirrors the core's semantics closely enough for UI work; it is not a second implementation to keep in sync
// feature-for-feature.

import type { Backlink, CoreError, Entry, FileContent, SearchHit } from "./types";
import { kindOf } from "./kinds";

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
  add("Ideas.md", "# Ideas\n\nBack to [[Welcome]].\n\n## Later\n\n- Graph view\n");
  add("Projects/Mosaic/Plan.md", "# Plan\n\n1. Build it\n");
  add("Projects/Data.csv", 'name,value,note\nalpha,1,"quoted, with comma"\nbeta,2,"multi\nline"\ngamma,3,\n');
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
      return write(p, String(a.content ?? ""));
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
      return { path: to, updated_links_in: [] };
    }
    case "delete_path": {
      const p = norm(a.path);
      if (!exists(p)) throw err("not_found", `not found: ${p}`);
      const under = (x: string) => x === p || x.startsWith(`${p}/`);
      for (const k of [...files.keys()]) if (under(k)) files.delete(k);
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
