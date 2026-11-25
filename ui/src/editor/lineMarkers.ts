// A line's own markup (`## `, `- `, `> `, `- [ ] `) stays rendered while the caret is on the line (see
// `markerTouched` in livePreview.ts), so the caret must never sit in front of that hidden markup: typing there
// would write before `## ` and break the heading. These rules keep it at the start of the content.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension, Prec, type Text } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

const MARKUP = new Set(["HeaderMark", "ListMark", "QuoteMark", "TaskMarker"]);

interface Markup {
  /** Where the line's text starts, after all its leading markup and the spaces after it. */
  start: number;
  /** The last markup node before the text (a heading's `##` when the line is a heading). */
  last: { name: string; from: number };
}

/** The leading markup of the line at `pos` (`- `, `> `, `## `, `- [ ] `, nested in any order), or null. */
function leadingMarkup(state: EditorState, doc: Text, pos: number): Markup | null {
  const line = doc.lineAt(pos);
  const nodes: { name: string; from: number; to: number }[] = [];
  let code = false;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name === "FencedCode" || node.name === "CodeBlock") code = true;
      if (!MARKUP.has(node.name) || node.from < line.from || node.to > line.to) return;
      // A Setext underline (`===`) is a whole line of markup, not a prefix.
      if (node.name === "HeaderMark" && !node.node.parent?.name.startsWith("ATX")) return;
      nodes.push({ name: node.name, from: node.from, to: node.to });
    },
  });
  if (code) return null;
  nodes.sort((x, y) => x.from - y.from);
  const text = line.text;
  const skip = (at: number) => {
    while (at < line.to && (text[at - line.from] === " " || text[at - line.from] === "\t")) at++;
    return at;
  };
  let cursor = skip(line.from);
  let last: Markup["last"] | null = null;
  for (const node of nodes) {
    if (node.from !== cursor) break;
    last = { name: node.name, from: node.from };
    cursor = skip(node.to);
  }
  return last ? { start: cursor, last } : null;
}

/** Where a line's text starts after its hidden markup, or null when it has none (or is code). */
export function contentStart(state: EditorState, doc: Text, pos: number): number | null {
  return leadingMarkup(state, doc, pos)?.start ?? null;
}

/**
 * Keeps an empty caret off hidden line markup: a click, Home or a vertical move that lands in front of it goes to
 * the start of the content (ArrowLeft from there is handled by `leftFromContent`).
 */
const caretAfterMarkup = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || !tr.isUserEvent("select")) return tr;
  const state = tr.state;
  const doc = state.doc;
  let changed = false;
  const ranges = tr.selection.ranges.map((range) => {
    if (!range.empty) return range;
    const start = contentStart(state, doc, range.head);
    if (start === null || range.head >= start) return range;
    changed = true;
    return EditorSelection.cursor(start);
  });
  if (!changed) return tr;
  return [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }];
});

/** ArrowLeft at the start of a line's text goes on to the end of the previous line, past the hidden markup. */
export function leftFromContent(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  if (contentStart(state, state.doc, range.head) !== range.head) return false;
  const line = state.doc.lineAt(range.head);
  view.dispatch({
    selection: { anchor: line.number > 1 ? line.from - 1 : range.head },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

/**
 * Backspace at the start of a heading's text turns it into normal text, also inside a list item or a quote
 * (`- ## x` → `- x`); list and quote markup itself is lang-markdown's `deleteMarkupBackward`.
 */
export function deleteHeadingMark(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const markup = leadingMarkup(state, state.doc, range.head);
  if (!markup || markup.start !== range.head || markup.last.name !== "HeaderMark") return false;
  view.dispatch({
    changes: { from: markup.last.from, to: range.head },
    selection: { anchor: markup.last.from },
    userEvent: "delete.backward",
  });
  return true;
}

export const lineMarkers: Extension = [
  caretAfterMarkup,
  Prec.high(
    keymap.of([
      { key: "Backspace", run: deleteHeadingMark },
      { key: "ArrowLeft", run: leftFromContent },
    ]),
  ),
];
