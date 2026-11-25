// The blocks of a note, as the `+` and drag handles see them, and how a block moves among its
// siblings. Everything here works on the Markdown text, which stays the document: a move changes
// only the moved text and the separators around it, so the file an agent reads keeps its shape.
//
// Top-level blocks are the children of the Markdown document (paragraphs, headings, tables, code,
// quotes, rules…). Lists aren't blocks themselves: each list item is, with its nested items, and it
// moves among the items of its own list. A heading drags with its section.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { renumberMovedSection } from "../views/outline";
import { parseWidths } from "./tableWidths";

export interface Block {
  /** Start of the block's first line. */
  from: number;
  /** End of the block's last line (before its newline). */
  to: number;
  /** The Lezer node name (`Paragraph`, `ATXHeading2`, `ListItem`, `Table`…). */
  kind: string;
  /** Blocks with the same group are siblings: -1 for top-level blocks, the list's start for items. */
  group: number;
  /** ATX heading level, or 0. */
  heading: number;
  /** Nesting depth: 0 at the top level, 1 for a top-level list's items, and so on. */
  depth: number;
}

/** A run of text that moves as one: a block, or a heading with its whole section. */
interface Unit {
  from: number;
  to: number;
  heading: number;
}

const LIST = new Set(["BulletList", "OrderedList"]);

/** Where YAML front matter ends (the offset after its closing line), or 0 when there is none. */
function frontMatterEnd(doc: Text): number {
  if (doc.lines < 2 || !/^---\s*$/.test(doc.line(1).text)) return 0;
  for (let n = 2; n <= doc.lines; n++) if (/^---\s*$/.test(doc.line(n).text)) return doc.line(n).to;
  return 0;
}

/** The line range a node covers, without trailing blank lines. */
function lineRange(doc: Text, node: SyntaxNode): { from: number; to: number } {
  const from = doc.lineAt(node.from).from;
  let end = doc.lineAt(node.to);
  if (end.from === node.to && node.to > node.from) end = doc.lineAt(node.to - 1);
  while (end.number > 1 && end.from > from && !end.text.trim()) end = doc.line(end.number - 1);
  return { from, to: end.to };
}

/** Every block of the note, in document order (a list item comes before its nested items). */
export function blockRanges(state: EditorState): Block[] {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);
  const skip = frontMatterEnd(doc);
  const out: Block[] = [];
  const items = (list: SyntaxNode, depth: number) => {
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (item.name !== "ListItem") continue;
      out.push({ ...lineRange(doc, item), kind: "ListItem", group: list.from, heading: 0, depth });
      for (let child = item.firstChild; child; child = child.nextSibling)
        if (LIST.has(child.name)) items(child, depth + 1);
    }
  };
  let widths: number | null = null;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.to <= skip || (skip && node.from < skip)) continue;
    if (LIST.has(node.name)) {
      widths = null;
      items(node, 1);
      continue;
    }
    const range = lineRange(doc, node);
    // A widths comment belongs to the table on the next line.
    if (node.name === "Table" && widths !== null && doc.lineAt(range.from).number === doc.lineAt(widths).number + 1) {
      out.pop();
      range.from = widths;
    }
    const isWidths =
      (node.name === "HTMLBlock" || node.name === "CommentBlock") &&
      doc.lineAt(range.from).number === doc.lineAt(range.to).number &&
      parseWidths(doc.sliceString(range.from, range.to)) !== null;
    widths = isWidths ? range.from : null;
    const heading = /^ATXHeading(\d)$/.exec(node.name);
    out.push({ ...range, kind: node.name, group: -1, heading: heading ? Number(heading[1]) : 0, depth: 0 });
  }
  return out;
}

/** The innermost block containing `pos`, or null. */
export function blockAt(blocks: readonly Block[], pos: number): Block | null {
  let found: Block | null = null;
  for (const block of blocks) {
    if (block.from > pos) break;
    if (pos <= block.to) found = block;
  }
  return found;
}

/** The top-level blocks covered by a heading's section (the heading and everything under it). */
function sectionEnd(siblings: readonly Block[], index: number): number {
  const level = siblings[index].heading;
  let end = index;
  while (end + 1 < siblings.length && !(siblings[end + 1].heading && siblings[end + 1].heading <= level)) end++;
  return end;
}

export interface Siblings {
  /** The units of the source's group, the source's own unit included (a section collapsed into one). */
  units: Unit[];
  /** The source's index in `units`. */
  index: number;
  /** `gaps[k]` is true when the source may move to just before unit k (`k === units.length`: the end). */
  gaps: boolean[];
}

/** The places a block can move to among its siblings. */
export function siblingsOf(blocks: readonly Block[], source: Block): Siblings {
  const group = blocks.filter((b) => b.group === source.group);
  const units: Unit[] = [];
  let index = -1;
  for (let i = 0; i < group.length; i++) {
    const block = group[i];
    if (block.from === source.from && source.heading) {
      const end = sectionEnd(group, i);
      index = units.length;
      units.push({ from: block.from, to: group[end].to, heading: block.heading });
      i = end;
      continue;
    }
    if (block.from === source.from) index = units.length;
    units.push({ from: block.from, to: block.to, heading: block.heading });
  }
  // A section can only land where a section can start: before a heading or at the end of the note.
  const gaps = units
    .map((unit, k) => k !== index && k !== index + 1 && (!source.heading || unit.heading > 0))
    .concat(units.length !== index + 1);
  return { units, index, gaps };
}

export interface BlockMove {
  text: string;
  /** Where the moved block starts in the new text. */
  focus: number;
}

/** Gives every ordered-list unit the number that was at its position before the move. */
function keepNumbers(old: readonly string[], next: string[]) {
  const number = /^(\s*)(\d+)(?=[.)])/;
  for (let k = 0; k < next.length; k++) {
    const at = number.exec(old[k]);
    if (at && number.test(next[k])) next[k] = next[k].replace(number, `$1${at[2]}`);
  }
}

/**
 * Moves the source block (with its section or nested items) to just before unit `gap` of its
 * siblings (`gap === units.length`: after the last one). Null when that isn't a valid place.
 */
export function moveBlock(text: string, blocks: readonly Block[], source: Block, gap: number): BlockMove | null {
  const { units, index, gaps } = siblingsOf(blocks, source);
  if (index < 0 || !gaps[gap]) return null;
  const start = units[0].from;
  const end = units[units.length - 1].to;
  const pieces = units.map((u) => text.slice(u.from, u.to));
  const seps = units.slice(1).map((u, k) => text.slice(units[k].to, u.from));
  const order = units.map((_, k) => k);
  order.splice(index, 1);
  order.splice(gap > index ? gap - 1 : gap, 0, index);
  const moved = order.map((k) => pieces[k]);
  if (source.kind === "ListItem") {
    keepNumbers(pieces, moved);
  } else {
    // A single newline next to the moved block would merge it into its neighbour.
    const at = order.indexOf(index);
    const wide = (k: number) => {
      if (k >= 0 && k < seps.length && (seps[k].match(/\n/g)?.length ?? 0) < 2) seps[k] = "\n\n";
    };
    wide(at - 1);
    wide(at);
  }
  let region = moved[0];
  let focus = start;
  for (let k = 1; k < moved.length; k++) {
    region += seps[k - 1];
    if (order[k] === index) focus = start + region.length;
    region += moved[k];
  }
  const next = text.slice(0, start) + region + text.slice(end);
  // Numbered sibling sections keep their numbering (`## 1. First`, `## 2. Second`).
  return source.heading ? renumberMovedSection(next, focus) : { text: next, focus };
}

/** The gap one place up or down from the source, skipping places it can't go; null at the ends. */
export function stepGap(siblings: Siblings, direction: -1 | 1): number | null {
  const { index, gaps } = siblings;
  if (direction < 0) {
    for (let k = index - 1; k >= 0; k--) if (gaps[k]) return k;
  } else {
    for (let k = index + 2; k < gaps.length; k++) if (gaps[k]) return k;
  }
  return null;
}

export interface Insertion {
  from: number;
  insert: string;
  /** Caret after the insertion. */
  caret: number;
  /** Whether the inserted line is a bare `/` that opens the slash menu. */
  slash: boolean;
}

/** What the `+` beside a block inserts: a sibling list item, or a new paragraph opening the slash menu. */
export function insertionAfter(doc: Text, blocks: readonly Block[], block: Block): Insertion {
  if (block.kind === "ListItem") {
    const nested = blocks.filter((b) => b.from > block.from && b.to <= block.to && b.kind === "ListItem");
    const to = nested.length ? Math.max(block.to, ...nested.map((b) => b.to)) : block.to;
    const first = doc.lineAt(block.from).text;
    const m = /^(\s*(?:>\s*)*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/.exec(first);
    const indent = m?.[1] ?? "";
    const marker = m?.[3] ? `${Number(m[3]) + 1}${m[4]}` : (m?.[2] ?? "-");
    const insert = `\n${indent}${marker} ${m?.[6] ? "[ ] " : ""}`;
    return { from: to, insert, caret: to + insert.length, slash: false };
  }
  const at = block.heading ? doc.lineAt(block.from).to : block.to;
  const after = doc.sliceString(at, at + 2);
  const next = after.length === 2 && after[0] === "\n" && after[1] !== "\n";
  const insert = next ? "\n\n/\n" : "\n\n/";
  return { from: at, insert, caret: at + 3, slash: true };
}
