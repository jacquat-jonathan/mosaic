import type { Entry } from "./ipc/types";
import { parseWikiLink, resolveLink } from "./links";

/** Binary assets that usually add noise beside notes in the ordinary file tree. */
export const isQuietAttachment = (entry: Entry) => !entry.is_dir && (entry.kind === "image" || entry.kind === "pdf");

function localTarget(raw: string): string | null {
  const target = raw.trim().replace(/^<|>$/g, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return null;
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

/** Existing non-note files embedded by a Markdown note, in first-use order. */
export function noteAttachments(
  text: string,
  notePath: string,
  entries: Entry[],
  aliases: [string, string][] = [],
): string[] {
  const found: string[] = [];
  const add = (target: string, markdown = false) => {
    const local = localTarget(target);
    if (!local) return;
    const path = resolveLink(local, entries, notePath, aliases, markdown);
    const entry = path && entries.find((item) => item.path === path && !item.is_dir);
    if (entry && entry.kind !== "markdown" && !found.includes(entry.path)) found.push(entry.path);
  };
  const targets: { index: number; target: string; markdown: boolean }[] = [];
  for (const match of text.matchAll(/!\[\[([^[\]\n]+?)\]\]/g))
    targets.push({ index: match.index, target: parseWikiLink(match[1]).target, markdown: false });
  for (const match of text.matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+["'][^\n)]*["'])?\s*\)/g))
    targets.push({ index: match.index, target: match[1] ?? match[2], markdown: true });
  for (const target of targets.sort((a, b) => a.index - b.index)) add(target.target, target.markdown);
  return found;
}
