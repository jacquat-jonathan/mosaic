// Obsidian-style link parsing and resolution against the vault file list.
// Mirrors crates/mosaic-core/src/links.rs; both are tested against fixtures/links.json.

import type { Entry } from "./ipc/types";
import { parentOf } from "./state/vault";

export interface WikiLink {
  /** Note or file name/path as written, without #heading, ^block or |alias. */
  target: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
}

export function parseWikiLink(inner: string): WikiLink {
  let rest = inner;
  let alias: string | null = null;
  const bar = rest.indexOf("|");
  if (bar >= 0) {
    alias = rest.slice(bar + 1).trim() || null;
    rest = rest.slice(0, bar);
  }
  let block: string | null = null;
  const caret = rest.indexOf("^");
  if (caret >= 0) {
    block = rest.slice(caret + 1).trim() || null;
    rest = rest.slice(0, caret);
  }
  let heading: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    heading = rest.slice(hash + 1).trim() || null;
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), heading, block, alias };
}

/** Text shown for a rendered link. */
export function linkLabel(l: WikiLink): string {
  if (l.alias) return l.alias;
  const base = l.target.split("/").pop() ?? l.target;
  const sub = l.heading ? ` › ${l.heading}` : l.block ? ` › ^${l.block}` : "";
  return (base || "") + sub || l.heading || "";
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Joins `rel` (which may contain `..` and `.`) onto `dir`; null if it climbs above the vault root. */
function joinRelative(dir: string, rel: string): string | null {
  const parts = dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** Notes are linked without ".md"; other files (and notes written with it) by full name. */
const candidates = (lower: string) => (lower.endsWith(".md") ? [lower] : [`${lower}.md`, lower]);

/** Byte order, like Rust's string comparison (upper case before lower case). */
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** An exact vault path, else a file whose path ends with `/name`: in `fromDir` first, then the shortest. */
function lookup(name: string, files: Entry[], fromDir: string): string | null {
  const exact = files.find((e) => e.path.toLowerCase() === name);
  if (exact) return exact.path;
  const matches = files
    .filter((e) => e.path.toLowerCase().endsWith(`/${name}`))
    .map((e) => e.path)
    .sort((a, b) => a.length - b.length || byteOrder(a, b));
  return matches.find((p) => parentOf(p).toLowerCase() === fromDir.toLowerCase()) ?? matches[0] ?? null;
}

/**
 * Resolves a link target to a vault path, or null if unresolved. Rules (Obsidian-compatible):
 * case-insensitive; `.md` optional for notes; an exact vault path wins, then a file in the source's
 * folder, then the shortest path (ties in byte order). Markdown links (and `../`) try the path
 * relative to the source first. Aliases from frontmatter resolve as a last resort.
 */
export function resolveLink(
  target: string,
  entries: Entry[],
  fromPath: string | null,
  aliases: [string, string][] = [],
  markdown = false,
): string | null {
  const fromDir = fromPath ? parentOf(fromPath) : "";
  let t = target.trim().replace(/\\/g, "/");
  if (!t) return fromPath;
  if (t.startsWith("./")) t = t.slice(2);
  const files = entries.filter((e) => !e.is_dir);
  if (t.startsWith("/")) {
    t = t.replace(/^\/+/, "");
  } else if (markdown || t.startsWith("../")) {
    const rel = joinRelative(fromDir, t);
    if (rel !== null) {
      for (const name of candidates(rel.toLowerCase())) {
        const exact = files.find((e) => e.path.toLowerCase() === name);
        if (exact) return exact.path;
      }
    }
    if (t.startsWith("../")) return null;
  }
  const lower = t.toLowerCase();
  for (const name of candidates(lower)) {
    const found = lookup(name, files, fromDir);
    if (found) return found;
  }
  if (!lower.includes("/")) {
    const alias = aliases.find(([a]) => a.toLowerCase() === lower);
    if (alias) return alias[1];
  }
  return null;
}

/** Link text to write for `path` from `fromPath`: the shortest form that resolves back to it. */
export function linkTextFor(path: string, entries: Entry[], fromPath: string | null = null): string {
  const strip = (s: string) => (/\.md$/i.test(path) ? s.slice(0, -3) : s);
  const short = strip(fileName(path));
  return resolveLink(short, entries, fromPath) === path ? short : strip(path);
}
