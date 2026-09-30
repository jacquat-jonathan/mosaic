import { EditorState, type Extension } from "@codemirror/state";
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
import { registerBlockRenderer } from "./widgets";
import { renderMath, renderMermaid } from "./render";
import { renderChart, renderGraphviz } from "../viewers/visuals";
import { prefs } from "../state/settings";

registerBlockRenderer(["mermaid"], async (src, el) => {
  el.innerHTML = await renderMermaid(src);
});
registerBlockRenderer(["math", "latex", "tex"], (src, el) => {
  el.innerHTML = renderMath(src, true);
});
registerBlockRenderer(["vega-lite", "vegalite", "chart"], (src, el, ctx) => renderChart(src, el, ctx.path));
registerBlockRenderer(["dot", "graphviz"], (src, el) => renderGraphviz(src, el));

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
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
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

export function markdownExtensions(ctx: EditorContext, onChange: (text: string) => void, readOnly: boolean): Extension {
  return [
    base(onChange),
    editorContext.of(ctx),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    autocompletion({ override: [wikiCompletion], icons: false }),
    livePreview(),
    EditorView.contentAttributes.of({ spellcheck: prefs().spellcheck ? "true" : "false", autocorrect: prefs().spellcheck ? "on" : "off" }),
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
