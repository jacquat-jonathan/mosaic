import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, keymap, highlightSpecialChars, rectangularSelection } from "@codemirror/view";
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
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString());
    }),
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
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on" }),
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
