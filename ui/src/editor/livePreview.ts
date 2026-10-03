// Obsidian-style live preview: Markdown syntax is hidden and rendered everywhere except where the
// selection is, so the file on disk stays plain Markdown while the screen reads like a document.

import { EditorState, StateEffect, StateField, type Extension, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { editorContext, type EditorContext } from "./context";
import { onDarkChange } from "../theme";
import { parseWikiLink, linkLabel } from "../links";
import { kindOf } from "../ipc/kinds";
import { blockRenderers } from "./blocks";
import { outlineNumber } from "./outline";
import { MATH_INLINE_RE } from "../markdown";
import {
  BulletWidget,
  OutlineNumberWidget,
  CanvasEmbedWidget,
  CheckboxWidget,
  ImageWidget,
  LinkWidget,
  MathWidget,
  NoteEmbedWidget,
  PropertiesWidget,
  RenderedBlockWidget,
  RuleWidget,
  TableWidget,
  ReactWidget,
  createElement,
} from "./widgets";
import { PdfViewer } from "../viewers/PdfViewer";

const hide = Decoration.replace({});
const mark = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs });
const line = (cls: string) => Decoration.line({ class: cls });

export const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/;
const WIKI_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const TAG_RE = /(^|[\s(,])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const HIGHLIGHT_RE = /==(?!\s)([^=\n]+?)(?<!\s)==/g;

function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function lineTouches(state: EditorState, pos: number): boolean {
  const l = state.doc.lineAt(pos);
  return touches(state, l.from, l.to);
}

interface Span {
  from: number;
  to: number;
}
const inside = (spans: Span[], from: number, to: number) => spans.some((s) => from < s.to && to > s.from);

/** Width suffix like `|300` in `![[img.png|300]]`. */
function embedWidth(alias: string | null): number | null {
  const m = alias ? /^(\d+)(x\d+)?$/.exec(alias.trim()) : null;
  return m ? Number(m[1]) : null;
}

function isExternal(url: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

interface Blocks {
  decorations: DecorationSet;
  /** Replaced by block widgets: nothing else may decorate inside. */
  blocked: Span[];
  /** Frontmatter, code, math and tables: no wikilink/tag/math parsing inside. */
  code: Span[];
  bodyStart: number;
}

/**
 * Block-level widgets (properties, display math, rendered fences, tables). CodeMirror requires these to
 * come from a state field; there are few of them, so the whole document is scanned cheaply by walking
 * only block-level syntax nodes.
 */
function buildBlocks(state: EditorState): Blocks {
  const ctx = state.facet(editorContext);
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const blocked: Span[] = [];
  const code: Span[] = [];

  let bodyStart = 0;
  const head = doc.sliceString(0, Math.min(doc.length, 64 * 1024));
  const fm = FRONTMATTER_RE.exec(head);
  if (fm) {
    const end = fm.index + fm[0].length;
    bodyStart = end;
    code.push({ from: 0, to: end });
    if (!touches(state, 0, end)) {
      out.push(Decoration.replace({ widget: new PropertiesWidget(fm[1], end), block: true }).range(0, end));
      blocked.push({ from: 0, to: end });
    }
  }

  // Display math: $$ on its own line … $$ on its own line. iterLines is a cheap sequential scan.
  let pos = 0;
  let open: { from: number; bodyFrom: number } | null = null;
  for (const text of doc.iterLines()) {
    const lineFrom = pos;
    pos += text.length + 1;
    if (lineFrom < bodyStart || text.charCodeAt(0) !== 36 /* $ */ || !/^\$\$[ \t]*$/.test(text)) continue;
    if (!open) {
      open = { from: lineFrom, bodyFrom: pos };
      continue;
    }
    const from = open.from;
    const to = lineFrom + text.length;
    code.push({ from, to });
    if (!touches(state, from, to)) {
      out.push(Decoration.replace({ widget: new MathWidget(doc.sliceString(open.bodyFrom, Math.max(open.bodyFrom, lineFrom - 1)), true), block: true }).range(from, to));
      blocked.push({ from, to });
    }
    open = null;
  }

  syntaxTree(state).iterate({
    enter: (ref) => {
      const { name, from, to } = ref;
      if (to <= bodyStart) return false;
      switch (name) {
        case "Document": case "BulletList": case "OrderedList": case "ListItem": case "Blockquote":
          return undefined;
        case "FencedCode": {
          if (from < bodyStart || inside(blocked, from, to)) return false;
          code.push({ from, to });
          const info = ref.node.getChild("CodeInfo");
          const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
          const start = doc.lineAt(from);
          const end = doc.lineAt(to);
          if (blockRenderers.has(lang) && end.number > start.number) {
            const body = end.number - start.number >= 2 ? doc.sliceString(doc.line(start.number + 1).from, doc.line(end.number - 1).to) : "";
            if (!touches(state, start.from, end.to)) {
              out.push(Decoration.replace({ widget: new RenderedBlockWidget(lang, body, ctx), block: true }).range(start.from, end.to));
              blocked.push({ from: start.from, to: end.to });
            } else {
              // Editing the block: its source shows, with a live preview underneath that keeps the
              // last good drawing while the source has an error.
              const widget = new RenderedBlockWidget(lang, body, ctx, undefined, `${ctx.path}:${start.number}`);
              out.push(Decoration.widget({ widget, block: true, side: 1 }).range(end.to));
            }
          }
          return false;
        }
        case "Table": {
          if (from < bodyStart || inside(blocked, from, to)) return false;
          code.push({ from, to });
          if (!touches(state, from, to)) {
            const start = doc.lineAt(from).from;
            const end = doc.lineAt(to).to;
            out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(start, end)), block: true }).range(start, end));
            blocked.push({ from: start, to: end });
          }
          return false;
        }
        case "CodeBlock": case "HTMLBlock": case "CommentBlock":
          code.push({ from, to });
          return false;
        default:
          return false;
      }
    },
  });
  return { decorations: Decoration.set(out, true), blocked, code, bodyStart };
}

/** Inline decorations for one visible range: syntax hiding, marks, links, tags, inline math. */
function buildInline(state: EditorState, blocks: Blocks, rangeFrom: number, rangeTo: number, out: Range<Decoration>[]) {
  const ctx = state.facet(editorContext);
  const doc = state.doc;
  const from0 = doc.lineAt(Math.max(rangeFrom, blocks.bodyStart)).from;
  const to0 = doc.lineAt(rangeTo).to;
  if (from0 > to0 || to0 <= blocks.bodyStart) return;
  const { blocked, bodyStart } = blocks;
  const code: Span[] = [...blocks.code.filter((c) => c.to > from0 && c.from < to0)];
  const text = doc.sliceString(from0, to0);

  if (bodyStart > 0 && !inside(blocked, 0, bodyStart) && from0 <= bodyStart) {
    for (let p = 0; p < bodyStart; ) {
      const l = doc.lineAt(p);
      out.push(line("cm-frontmatter").range(l.from));
      p = l.to + 1;
    }
  }

  // Wikilinks look like nested reference links to CommonMark; find them first so the tree pass leaves them alone.
  const wikiMatches = [...text.matchAll(WIKI_RE)].map((m) => ({ m, from: from0 + m.index!, to: from0 + m.index! + m[0].length }));
  const wikiSpans: Span[] = wikiMatches.map(({ from, to }) => ({ from, to }));
  const lines = (from: number, to: number, cls: string) => {
    for (let p = Math.max(from, from0); p <= Math.min(to, to0); ) {
      const l = doc.lineAt(p);
      out.push(line(cls).range(l.from));
      p = l.to + 1;
    }
  };

  syntaxTree(state).iterate({
    from: from0,
    to: to0,
    enter: (ref) => {
      const { name, from, to } = ref;
      if (to <= bodyStart) return false;
      if (name === "Document") return undefined;
      if (from < bodyStart || inside(blocked, from, to)) return false;
      const node = ref.node;
      switch (name) {
        case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
        case "ATXHeading4": case "ATXHeading5": case "ATXHeading6":
        case "SetextHeading1": case "SetextHeading2":
          out.push(line(`cm-h cm-h${name.slice(-1)}`).range(doc.lineAt(from).from));
          break;
        case "HeaderMark": {
          const parent = node.parent?.name ?? "";
          if (parent.startsWith("ATX") && !lineTouches(state, from)) {
            const after = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
            out.push(hide.range(from, after));
          } else if (parent.startsWith("Setext") && !lineTouches(state, from)) {
            out.push(hide.range(from, to));
          }
          break;
        }
        case "Emphasis": out.push(mark("cm-em").range(from, to)); break;
        case "StrongEmphasis": out.push(mark("cm-strong").range(from, to)); break;
        case "Strikethrough": out.push(mark("cm-strike").range(from, to)); break;
        case "EmphasisMark": case "StrikethroughMark":
          if (!touches(state, node.parent!.from, node.parent!.to)) out.push(hide.range(from, to));
          break;
        case "InlineCode":
          code.push({ from, to });
          out.push(mark("cm-inline-code").range(from, to));
          if (!touches(state, from, to)) {
            for (const m of node.getChildren("CodeMark")) out.push(hide.range(m.from, m.to));
          }
          return false;
        case "Link":
          if (inside(wikiSpans, from, to)) return false;
          decorateLink(state, node, out, code);
          return false;
        case "Image":
          if (inside(wikiSpans, from, to)) return false;
          decorateImage(state, ctx, node, out, code);
          return false;
        case "URL": case "Autolink":
          code.push({ from, to });
          out.push(mark("cm-link", { "data-href": doc.sliceString(from, to).replace(/^<|>$/g, "") }).range(from, to));
          return false;
        case "Blockquote":
          lines(from, to, "cm-quote");
          break;
        case "QuoteMark":
          if (!lineTouches(state, from)) {
            const after = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
            out.push(hide.range(from, after));
          }
          break;
        case "HorizontalRule":
          if (!lineTouches(state, from)) out.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
          break;
        case "ListMark": {
          const mk = doc.sliceString(from, to);
          const task = node.nextSibling?.name === "Task";
          if (task && !lineTouches(state, from)) {
            // The task checkbox replaces the bullet.
            const after = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
            out.push(hide.range(from, after));
          } else if (/^[-*+]$/.test(mk) && !lineTouches(state, from)) {
            out.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
          } else if (/^\d+[.)]$/.test(mk) && !lineTouches(state, from)) {
            const label = outlineNumber(node, (a, b) => doc.sliceString(a, b));
            if (label) out.push(Decoration.replace({ widget: new OutlineNumberWidget(label) }).range(from, to));
          }
          break;
        }
        case "TaskMarker": {
          const checked = /x/i.test(doc.sliceString(from, to));
          if (!lineTouches(state, from)) {
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked, from) }).range(from, to));
          }
          const lineEnd = doc.lineAt(from).to;
          if (checked && to + 1 < lineEnd) out.push(mark("cm-task-done").range(to + 1, lineEnd));
          break;
        }
        case "FencedCode": {
          const start = doc.lineAt(from);
          const end = doc.lineAt(to);
          for (let n = Math.max(start.number, doc.lineAt(from0).number); n <= Math.min(end.number, doc.lineAt(to0).number); n++) {
            const cls = n === start.number ? "cm-codeblock cm-codeblock-begin" : n === end.number ? "cm-codeblock cm-codeblock-end" : "cm-codeblock";
            out.push(line(cls).range(doc.line(n).from));
          }
          if (!touches(state, start.from, end.to)) {
            for (const m of node.getChildren("CodeMark")) out.push(hide.range(m.from, m.to));
            const info = node.getChild("CodeInfo");
            if (info) out.push(mark("cm-codeinfo").range(info.from, info.to));
          }
          return false;
        }
        case "CodeBlock":
          lines(from, to, "cm-codeblock");
          return false;
        case "Table":
          lines(from, to, "cm-table-src");
          return false;
        case "HTMLBlock": case "Comment": case "CommentBlock": case "HTMLTag":
          code.push({ from, to });
          return false;
      }
      return undefined;
    },
  });

  // Obsidian syntax the CommonMark parser doesn't know: wikilinks, embeds, tags, math, highlights.
  const skip = (from: number, to: number) => from < bodyStart || inside(blocked, from, to) || inside(code, from, to);
  for (const { m, from, to } of wikiMatches) {
    if (skip(from, to)) continue;
    const link = parseWikiLink(m[2]);
    const embed = m[1] === "!";
    const resolved = ctx.resolve(link.target);
    code.push({ from, to });
    if (touches(state, from, to)) {
      out.push(mark("cm-wikilink-src").range(from, to));
      continue;
    }
    if (embed) {
      const kind = kindOf(resolved ?? link.target);
      const widget =
        kind === "image"
          ? new ImageWidget(resolved, link.target, embedWidth(link.alias), ctx)
          : kind === "pdf" && resolved
            ? new ReactWidget(`pdf:${resolved}`, () => createElement(PdfViewer, { path: resolved, maxPages: 3, compact: true }), "cm-embed-pdf")
            : kind === "canvas" && resolved
              ? new CanvasEmbedWidget(resolved, link.target, ctx)
              : new NoteEmbedWidget(resolved, link.target, ctx);
      out.push(Decoration.replace({ widget }).range(from, to));
    } else {
      const target = m[2].split("|")[0];
      out.push(Decoration.replace({ widget: new LinkWidget(linkLabel(link), target, resolved !== null) }).range(from, to));
    }
  }
  for (const m of text.matchAll(TAG_RE)) {
    const from = from0 + m.index! + m[1].length;
    const to = from + 1 + m[2].length;
    if (skip(from, to)) continue;
    out.push(mark("cm-tag", { "data-tag": m[2] }).range(from, to));
  }
  for (const m of text.matchAll(MATH_INLINE_RE)) {
    const from = from0 + m.index!;
    const to = from + m[0].length;
    if (skip(from, to)) continue;
    if (touches(state, from, to)) out.push(mark("cm-math-src").range(from, to));
    else out.push(Decoration.replace({ widget: new MathWidget(m[1], false) }).range(from, to));
  }
  for (const m of text.matchAll(HIGHLIGHT_RE)) {
    const from = from0 + m.index!;
    const to = from + m[0].length;
    if (skip(from, to)) continue;
    out.push(mark("cm-highlight").range(from, to));
    if (!touches(state, from, to)) out.push(hide.range(from, from + 2), hide.range(to - 2, to));
  }
}

function decorateLink(state: EditorState, node: SyntaxNode, out: Range<Decoration>[], code: Span[]) {
  const doc = state.doc;
  const marks = node.getChildren("LinkMark");
  const url = node.getChild("URL");
  code.push({ from: node.from, to: node.to });
  if (marks.length < 2) return;
  const labelFrom = marks[0].to;
  const labelTo = marks[1].from;
  const href = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, "") : "";
  if (labelTo > labelFrom) out.push(mark("cm-link", { "data-href": href }).range(labelFrom, labelTo));
  if (!touches(state, node.from, node.to) && labelTo > labelFrom) {
    out.push(hide.range(node.from, labelFrom), hide.range(labelTo, node.to));
  }
}

function decorateImage(state: EditorState, ctx: EditorContext, node: SyntaxNode, out: Range<Decoration>[], code: Span[]) {
  const doc = state.doc;
  code.push({ from: node.from, to: node.to });
  if (touches(state, node.from, node.to)) return;
  const marks = node.getChildren("LinkMark");
  const url = node.getChild("URL");
  const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
  const src = url ? decodeURI(doc.sliceString(url.from, url.to).replace(/^<|>$/g, "")) : "";
  const widget = isExternal(src)
    ? new ImageWidget(null, alt, null, ctx, src)
    : new ImageWidget(ctx.resolve(src, true), alt || src, embedWidth(alt.split("|")[1] ?? null), ctx);
  out.push(Decoration.replace({ widget }).range(node.from, node.to));
}

/** Dispatch to re-render after something outside the document changed (e.g. files were created). */
export const refreshPreview = StateEffect.define<null>();

const needsRebuild = (tr: Transaction) =>
  tr.docChanged || !!tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.reconfigured || tr.effects.some((e) => e.is(refreshPreview));

const blockField = StateField.define<Blocks>({
  create: buildBlocks,
  update: (value, tr) => (needsRebuild(tr) ? buildBlocks(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f, (b) => b.decorations),
});

/** Inline decorations, computed only for what's on screen so large notes stay fast. */
const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.viewportChanged || u.transactions.some(needsRebuild)) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const blocks = view.state.field(blockField);
      const out: Range<Decoration>[] = [];
      for (const r of view.visibleRanges) buildInline(view.state, blocks, r.from, r.to, out);
      return Decoration.set(out, true);
    }
  },
  { decorations: (p) => p.decorations },
);

/** Opens links on click. Rendered links open on a plain click; source links need ⌘-click. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    const tag = (e.target as HTMLElement).closest<HTMLElement>(".cm-tag");
    if (tag?.dataset.tag && e.button === 0 && (e.metaKey || !lineTouches(view.state, view.posAtDOM(tag)))) {
      e.preventDefault();
      view.state.facet(editorContext).openTag(tag.dataset.tag);
      return true;
    }
    const el = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink, .cm-link");
    if (!el || e.button !== 0) return false;
    const ctx = view.state.facet(editorContext);
    const rendered = el.classList.contains("cm-wikilink") || !lineTouches(view.state, view.posAtDOM(el));
    if (!rendered && !e.metaKey) return false;
    e.preventDefault();
    if (el.dataset.target !== undefined) ctx.openLink(el.dataset.target, e.metaKey);
    else if (el.dataset.href) {
      const href = el.dataset.href;
      if (isExternal(href)) ctx.openExternal(href);
      else ctx.openLink(decodeURI(href).replace(/\.md$/i, ""), e.metaKey);
    }
    return true;
  },
});

/** Redraws diagrams when the theme flips, since they bake their colours in. */
const themeRedraw = ViewPlugin.define((view) => {
  const stop = onDarkChange(() => view.dispatch({ effects: refreshPreview.of(null) }));
  return { destroy: stop };
});

export function livePreview(): Extension {
  return [blockField, inlinePlugin, linkClicks, themeRedraw];
}

