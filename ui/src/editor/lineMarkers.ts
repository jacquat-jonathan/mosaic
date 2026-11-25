// A line's own markup (`## `, `- `, `> `, `- [ ] `) stays rendered while the caret is on the line (see
// `markerTouched` in livePreview.ts), so the caret must never sit in front of that hidden markup: typing there
// would write before `## ` and break the heading. These rules keep it at the start of the content.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension, Prec, type Text } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

const PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}(?:[ \t]+|$)|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
const MARKUP = new Set(["HeaderMark", "ListMark", "QuoteMark", "TaskMarker"]);

/** Where a line's text starts after its hidden markup, or null when it has none (or is code). */
export function contentStart(state: EditorState, doc: Text, pos: number): number | null {
  const line = doc.lineAt(pos);
  const prefix = PREFIX.exec(line.text)?.[0] ?? "";
  if (!prefix.trim()) return null;
  // Only real markup counts: not `- ` in a code block or `#hashtag`.
  const tree = syntaxTree(state);
  let markup = false;
  tree.iterate({
    from: line.from,
    to: line.from + prefix.length,
    enter: (node) => {
      if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
      if (MARKUP.has(node.name) && node.from >= line.from && node.to <= line.from + prefix.length) markup = true;
    },
  });
  return markup ? line.from + prefix.length : null;
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

/** Backspace at the start of a heading's text turns it into a paragraph (lists and quotes: lang-markdown). */
export function deleteHeadingMark(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const m = /^#{1,6}[ \t]+/.exec(line.text);
  if (!m || range.head !== line.from + m[0].length || contentStart(state, state.doc, range.head) === null) return false;
  view.dispatch({
    changes: { from: line.from, to: range.head },
    selection: { anchor: line.from },
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
