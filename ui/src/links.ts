// Obsidian-style link parsing and resolution against the vault file list.
// The core index (M3) applies the same rules for backlinks; keep them in sync.

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

/**
 * Resolves a link target to a vault path, or null if unresolved. Rules (Obsidian-compatible):
 * case-insensitive; `.md` optional for notes; an exact vault path wins, then a file in the same
 * folder as the source, then the shortest path.
 */
export function resolveLink(target: string, entries: Entry[], fromPath: string | null): string | null {
  if (!target) return fromPath;
  let t = target.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
  if (t.startsWith("../") && fromPath) {
    // Relative markdown links: resolve against the source folder.
    const parts = parentOf(fromPath).split("/").filter(Boolean);
    for (const seg of t.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    t = parts.join("/").toLowerCase();
  }
  const files = entries.filter((e) => !e.is_dir);
  const dir = fromPath ? parentOf(fromPath).toLowerCase() : "";
  // Notes are linked without ".md"; other files (and notes written with it) by full name.
  for (const name of /\.md$/.test(t) ? [t] : [`${t}.md`, t]) {
    const exact = files.find((e) => e.path.toLowerCase() === name);
    if (exact) return exact.path;
    const matches = files.filter((e) => e.path.toLowerCase().endsWith(`/${name}`));
    if (matches.length === 0) continue;
    const same = matches.find((e) => parentOf(e.path).toLowerCase() === dir);
    if (same) return same.path;
    return matches.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))[0].path;
  }
  return null;
}

/** Link text to write for a path, shortest form that still resolves uniquely (Obsidian default). */
export function linkTextFor(path: string, entries: Entry[]): string {
  const noExt = path.replace(/\.md$/i, "");
  const base = noExt.split("/").pop()!;
  const baseName = /\.md$/i.test(path) ? base : path.split("/").pop()!;
  const clash = entries.filter((e) => !e.is_dir && e.path !== path && e.name.toLowerCase() === path.split("/").pop()!.toLowerCase());
  return clash.length ? noExt : baseName;
}
