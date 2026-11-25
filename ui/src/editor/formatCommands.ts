// The fixed toolbar's commands: block type (Normal text, Heading 1–6), inline marks and lists. Each works on
// the Markdown text directly and is one undo step; the pure `*Edit` functions are what the tests check.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { markdownMarkEdit } from "./selectionToolbar";

export type InlineMark = "**" | "*" | "~~" | "`";
export type ListKind = "bullet" | "ordered" | "task";

/** Quote marks and list markers before a line's text; a heading's `#`s come after them. */
const LEAD = /^([ \t]*(?:>[ \t]?)*[ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
const HEADING = /^#{1,6}(?:[ \t]+|$)/;
const LIST = /^([-*+]|\d{1,9}[.)])[ \t]+(\[[ xX]\][ \t]+)?/;

interface LineParts {
  from: number;
  /** Indentation and quote marks. */
  lead: string;
  /** The list marker with its space (and task box), or "". */
  list: string;
  /** `## ` or "". */
  heading: string;
  text: string;
}

function parts(state: EditorState, lineNumber: number): LineParts {
  const line = state.doc.line(lineNumber);
  const lead = LEAD.exec(line.text)!;
  const prefix = lead[1];
  const list = lead[2] ?? "";
  const rest = line.text.slice(prefix.length + list.length);
  const heading = HEADING.exec(rest)?.[0] ?? "";
  return { from: line.from, lead: prefix, list, heading, text: rest.slice(heading.length) };
}

function inCode(state: EditorState, pos: number) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent!)
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
  return false;
}

/** Line numbers covered by the selection, skipping code. */
function selectedLines(state: EditorState): number[] {
  const out = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A selection ending at the start of a line doesn't include that line.
    if (last > first && range.to === state.doc.line(last).from) last--;
    for (let n = first; n <= last; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b).filter((n) => !inCode(state, state.doc.line(n).from));
}

/** Turns the selected lines into a heading of `level` (1–6), or into normal text with 0. */
export function blockTypeEdit(state: EditorState, level: number): TransactionSpec | null {
  const changes = selectedLines(state).flatMap((n) => {
    const p = parts(state, n);
    const insert = level > 0 ? `${"#".repeat(level)} ` : "";
    if (p.heading === insert) return [];
    const at = p.from + p.lead.length + p.list.length;
    return [{ from: at, to: at + p.heading.length, insert }];
  });
  if (!changes.length) return null;
  const set = state.changes(changes);
  return { changes: set, selection: state.selection.map(set, 1), userEvent: "input.format" };
}

/** The word around an empty caret, or null. */
function wordAt(state: EditorState, pos: number) {
  const word = state.wordAt(pos);
  return word && word.from < word.to ? word : null;
}

/** Wraps or unwraps the selection (or the word at the caret) in an inline mark. */
export function inlineMarkEdit(state: EditorState, mark: InlineMark): TransactionSpec | null {
  const range = state.selection.main;
  const target = range.empty ? wordAt(state, range.head) : range;
  const doc = state.doc.toString();
  if (!target) {
    // Nothing to wrap: insert the pair with the caret between.
    return {
      changes: { from: range.head, insert: mark + mark },
      selection: { anchor: range.head + mark.length },
      userEvent: "input.format",
    };
  }
  if (mark === "**" || mark === "*") {
    const edit = markdownMarkEdit(doc, target.from, target.to, mark);
    return {
      changes: edit.changes,
      selection: EditorSelection.range(edit.selection.anchor, edit.selection.head),
      userEvent: "input.format",
    };
  }
  const n = mark.length;
  const { from, to } = target;
  const outside = doc.slice(from - n, from) === mark && doc.slice(to, to + n) === mark;
  const inside = to - from >= 2 * n && doc.slice(from, from + n) === mark && doc.slice(to - n, to) === mark;
  if (outside)
    return {
      changes: [
        { from: from - n, to: from },
        { from: to, to: to + n },
      ],
      selection: EditorSelection.range(from - n, to - n),
      userEvent: "input.format",
    };
  if (inside)
    return {
      changes: [
        { from, to: from + n },
        { from: to - n, to },
      ],
      selection: EditorSelection.range(from, to - 2 * n),
      userEvent: "input.format",
    };
  return {
    changes: [
      { from, insert: mark },
      { from: to, insert: mark },
    ],
    selection: EditorSelection.range(from + n, to + n),
    userEvent: "input.format",
  };
}

function kindOf(list: string): ListKind | null {
  const m = LIST.exec(list);
  if (!m) return null;
  if (m[2]) return "task";
  return /\d/.test(m[1]) ? "ordered" : "bullet";
}

/** Makes the selected lines a list of `kind`, or plain lines again when they all already are one. */
export function listEdit(state: EditorState, kind: ListKind): TransactionSpec | null {
  const lines = selectedLines(state).map((n) => parts(state, n));
  if (!lines.length) return null;
  const remove = lines.every((p) => kindOf(p.list) === kind);
  let number = 0;
  const changes = lines.flatMap((p) => {
    const at = p.from + p.lead.length;
    if (remove) return [{ from: at, to: at + p.list.length, insert: "" }];
    // Skip blank lines in a multi-line selection.
    if (lines.length > 1 && !p.list && !p.heading && !p.text.trim()) return [];
    const marker = kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : `${++number}. `;
    // A heading's `#`s go: a list item is text.
    return [{ from: at, to: at + p.list.length + p.heading.length, insert: marker }];
  });
  const set = state.changes(changes);
  return { changes: set, selection: state.selection.map(set, 1), userEvent: "input.format" };
}

export interface ToolbarState {
  /** Heading level of the caret's line (0 = normal text), or null inside code. */
  block: number | null;
  list: ListKind | null;
}

export function toolbarState(state: EditorState): ToolbarState {
  const head = state.selection.main.head;
  if (inCode(state, head)) return { block: null, list: null };
  const p = parts(state, state.doc.lineAt(head).number);
  return { block: p.heading ? p.heading.trim().length : 0, list: kindOf(p.list) };
}

/** Runs one of the edits above on a view, as one undo step. */
export function run(view: EditorView, edit: (state: EditorState) => TransactionSpec | null): boolean {
  if (view.state.readOnly) return false;
  const spec = edit(view.state);
  if (!spec) return false;
  view.dispatch({ ...spec, scrollIntoView: true });
  view.focus();
  return true;
}

export const setBlockType = (level: number) => (view: EditorView) => run(view, (s) => blockTypeEdit(s, level));
export const toggleInline = (mark: InlineMark) => (view: EditorView) => run(view, (s) => inlineMarkEdit(s, mark));
export const toggleList = (kind: ListKind) => (view: EditorView) => run(view, (s) => listEdit(s, kind));

const blockKeys = [0, 1, 2, 3, 4, 5, 6].map((level) => ({
  key: `Ctrl-Shift-${level}`,
  mac: `Mod-Alt-${level}`,
  run: setBlockType(level),
  preventDefault: true,
}));

/** Shortcuts beyond the selection toolbar's ⌘B / ⌘I / ⌘K. */
export const formatKeymap = keymap.of([
  { key: "Mod-Shift-x", run: toggleInline("~~"), preventDefault: true },
  { key: "Mod-e", run: toggleInline("`"), preventDefault: true },
  ...blockKeys,
]);
