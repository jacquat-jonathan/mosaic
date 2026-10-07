import { Compartment, EditorSelection, EditorState, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate, drawSelection, dropCursor, keymap, highlightSpecialChars, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, type LanguageSupport } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { editorContext, type EditorContext } from "./context";
import { livePreview } from "./livePreview";
import "./blocks"; // registers the diagram renderers used by code blocks
import { prefs, useSettings } from "../state/settings";


const highlight = HighlightStyle.define([
  { tag: t.keyword, class: "tok-keyword" },
  { tag: [t.string, t.special(t.string)], class: "tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "tok-number" },
  { tag: t.comment, class: "tok-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tok-function" },
  { tag: [t.typeName, t.className], class: "tok-type" },
  { tag: [t.propertyName, t.attributeName], class: "tok-property" },
  { tag: [t.operator, t.punctuation], class: "tok-punct" },
  { tag: t.tagName, class: "tok-tag" },
  { tag: t.heading, class: "tok-heading" },
  { tag: t.monospace, class: "tok-mono" },
  { tag: t.link, class: "tok-link" },
  { tag: t.url, class: "tok-url" },
  { tag: t.processingInstruction, class: "tok-meta" },
]);

/**
 * Live-preview decorations can change a line's height or replace a block as the caret moves. When
 * CodeMirror calculates Up/Down from screen coordinates during that change it may land several
 * Markdown lines away. One key press must never cross more than one logical line; wrapped text still
 * uses CodeMirror's normal visual movement whenever it stays on this or the adjacent line.
 */
export function clampVerticalTarget(state: EditorState, start: SelectionRange, moved: SelectionRange, forward: boolean): SelectionRange {
  const from = state.doc.lineAt(start.head);
  const to = state.doc.lineAt(moved.head);
  if (Math.abs(to.number - from.number) <= 1) return moved;
  const target = state.doc.line(from.number + (forward ? 1 : -1));
  const head = target.from + Math.min(start.head - from.from, target.length);
  return EditorSelection.cursor(head, forward ? -1 : 1, moved.bidiLevel ?? undefined, moved.goalColumn ?? undefined);
}

function moveLine(view: EditorView, forward: boolean, extend: boolean): boolean {
  const selection = EditorSelection.create(view.state.selection.ranges.map((original) => {
    if (!extend && !original.empty) return EditorSelection.cursor(forward ? original.to : original.from);
    let range = original;
    if (extend && range.undirectional && (range.head >= range.anchor) !== forward) range = EditorSelection.range(range.head, range.anchor);
    const moved = clampVerticalTarget(view.state, range, view.moveVertically(range, forward), forward);
    return extend
      ? EditorSelection.range(range.anchor, moved.head, moved.goalColumn ?? undefined, moved.bidiLevel ?? undefined, moved.assoc)
      : moved;
  }), view.state.selection.mainIndex);
  if (selection.eq(view.state.selection, true)) return false;
  view.dispatch({ selection, scrollIntoView: true, userEvent: "select" });
  return true;
}

const stableVerticalKeys = [
  { key: "ArrowUp", run: (view: EditorView) => moveLine(view, false, false) },
  { key: "ArrowDown", run: (view: EditorView) => moveLine(view, true, false) },
  { key: "Shift-ArrowUp", run: (view: EditorView) => moveLine(view, false, true) },
  { key: "Shift-ArrowDown", run: (view: EditorView) => moveLine(view, true, true) },
];

/**
 * Reports the document to the store shortly after typing pauses (serialising a large note on every
 * keystroke is what makes big files feel slow). Pending changes are flushed when the editor closes.
 */
function changeReporter(onChange: (text: string) => void) {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {}
      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), u.state.doc.length > 50_000 ? 150 : 0);
      }
      flush() {
        if (this.timer === undefined) return;
        clearTimeout(this.timer);
        this.timer = undefined;
        onChange(this.view.state.doc.toString());
      }
      destroy() {
        this.flush();
      }
    },
  );
}

function base(onChange: (text: string) => void): Extension {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.allowMultipleSelections.of(true),
    syntaxHighlighting(highlight),
    keymap.of([...stableVerticalKeys, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    changeReporter(onChange),
  ];
}

/** `[[` completion: vault notes and files. */
function wikiCompletion(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/!?\[\[[^[\]|#\n]*/);
  if (!m) return null;
  const start = m.from + m.text.indexOf("[[") + 2;
  const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
  const ectx = ctx.state.facet(editorContext);
  return {
    from: start,
    options: ectx.linkCandidates().map((c) => ({
      label: c.label,
      detail: c.detail,
      apply: after === "]]" ? (c.insert ?? c.label) : `${c.insert ?? c.label}]]`,
    })),
    validFor: /^[^[\]|#\n]*$/,
  };
}

const spellcheck = new Compartment();
export const spellcheckAttributes = (on: boolean) => ({ spellcheck: on ? "true" : "false", autocorrect: "off", autocapitalize: "off" });
const spellcheckAttrs = (on: boolean) => EditorView.contentAttributes.of(spellcheckAttributes(on));

/** Applies the Spellcheck setting to editors that are already open. */
const spellcheckFollower = ViewPlugin.define((view) => {
  let on = prefs().spellcheck;
  const stop = useSettings.subscribe(() => {
    if (prefs().spellcheck === on) return;
    on = prefs().spellcheck;
    view.dispatch({ effects: spellcheck.reconfigure(spellcheckAttrs(on)) });
  });
  return { destroy: stop };
});

/** Files dropped from Finder are copied into the vault and embedded where they were dropped. */
/** The text a paste or drop resolved to, inserted where it happened (or at the cursor). */
function insertWhenReady(view: EditorView, pending: Promise<string>, at: number) {
  void pending.then((embeds) => {
    if (!embeds) return;
    const pos = Math.min(at, view.state.doc.length);
    // At the start of a line with text on it, keep that text on its own line (a heading stays a heading).
    const line = view.state.doc.lineAt(pos);
    const text = pos === line.from && line.length > 0 ? `${embeds}\n` : embeds;
    view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
    view.focus();
  });
}

const finderDrop = EditorView.domEventHandlers({
  paste(e, view) {
    const ctx = view.state.facet(editorContext);
    const pending = e.clipboardData && ctx.importPaste?.(e.clipboardData);
    if (!pending) return false;
    e.preventDefault();
    insertWhenReady(view, pending, view.state.selection.main.head);
    return true;
  },
  drop(e, view) {
    if (!e.dataTransfer || view.state.readOnly) return false;
    const pending = view.state.facet(editorContext).importDrop(e.dataTransfer);
    if (!pending) return false;
    e.preventDefault();
    insertWhenReady(view, pending, view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head);
    return true;
  },
});

export function markdownExtensions(ctx: EditorContext, onChange: (text: string) => void, readOnly: boolean): Extension {
  return [
    base(onChange),
    editorContext.of(ctx),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    autocompletion({ override: [wikiCompletion], icons: false }),
    livePreview(),
    finderDrop,
    spellcheck.of(spellcheckAttrs(prefs().spellcheck)),
    spellcheckFollower,
    EditorState.readOnly.of(readOnly),
  ];
}

export function codeExtensions(lang: LanguageSupport | null, onChange: (text: string) => void, readOnly: boolean, wrap = false): Extension {
  return [
    base(onChange),
    lang ?? [],
    wrap ? EditorView.lineWrapping : [],
    EditorState.readOnly.of(readOnly),
  ];
}
