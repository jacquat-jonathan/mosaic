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
  add("Projects/Data.csv", "name,value\nalpha,1\nbeta,2\n");
  add("Board.canvas", '{"nodes":[],"edges":[]}');
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
    case "absolute_path":
      return `/mock/vault/${norm(a.path)}`;
    default:
      throw err("invalid", `mock: unknown command ${cmd}`);
  }
}
