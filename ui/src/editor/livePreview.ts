// Obsidian-style live preview: Markdown syntax is hidden and rendered everywhere except where the
// selection is, so the file on disk stays plain Markdown while the screen reads like a document.

import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { editorContext, type EditorContext } from "./context";
import { parseWikiLink, linkLabel } from "../links";
import { kindOf } from "../ipc/kinds";
import {
  blockRenderers,
  BulletWidget,
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
const MATH_INLINE_RE = /(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g;
const MATH_BLOCK_RE = /^\$\$[ \t]*\n([\s\S]*?)\n\$\$[ \t]*$/gm;
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

function build(state: EditorState): DecorationSet {
  const ctx = state.facet(editorContext);
  const doc = state.doc;
  const text = doc.toString();
  const out: Range<Decoration>[] = [];
  const blocked: Span[] = []; // replaced by block widgets: nothing else may decorate inside
  const code: Span[] = []; // code and URLs: no wikilink/tag/math parsing inside

  // 1. Frontmatter (the Markdown parser would otherwise read it as a setext heading).
  let bodyStart = 0;
  const fm = FRONTMATTER_RE.exec(text);
  if (fm) {
    const end = fm.index + fm[0].length;
    bodyStart = end;
    code.push({ from: 0, to: end });
    if (!touches(state, 0, end)) {
      out.push(Decoration.replace({ widget: new PropertiesWidget(fm[1]), block: true }).range(0, end));
      blocked.push({ from: 0, to: end });
    } else {
      for (let p = 0; p <= end; ) {
        const l = doc.lineAt(p);
        out.push(line("cm-frontmatter").range(l.from));
        p = l.to + 1;
      }
    }
  }

  // 2. Display math blocks ($$ … $$ on their own lines).
  for (const m of text.matchAll(MATH_BLOCK_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (from < bodyStart) continue;
    code.push({ from, to });
    if (!touches(state, from, to)) {
      out.push(Decoration.replace({ widget: new MathWidget(m[1], true), block: true }).range(from, to));
      blocked.push({ from, to });
    }
  }

  // Wikilinks look like nested reference links to CommonMark; find them first so the tree pass leaves them alone.
  const wikiSpans: Span[] = [...text.matchAll(WIKI_RE)].map((m) => ({ from: m.index!, to: m.index! + m[0].length }));

  // 3. Syntax-tree driven decorations.
  const tree = syntaxTree(state);
  tree.iterate({
    from: bodyStart,
    enter: (ref) => {
      const { name, from, to } = ref;
      if (to <= bodyStart) return false;
      if (name === "Document") return undefined;
      if (from < bodyStart || inside(blocked, from, to)) return false;
      const node = ref.node;
      switch (name) {
        case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
        case "ATXHeading4": case "ATXHeading5": case "ATXHeading6":
          out.push(line(`cm-h cm-h${name.slice(-1)}`).range(doc.lineAt(from).from));
          break;
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
          for (let p = from; p <= to; ) {
            const l = doc.lineAt(p);
            out.push(line("cm-quote").range(l.from));
            p = l.to + 1;
          }
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
        case "FencedCode":
          decorateFence(state, ctx, node, out, code, blocked);
          return false;
        case "CodeBlock":
          code.push({ from, to });
          for (let p = from; p <= to; ) {
            const l = doc.lineAt(p);
            out.push(line("cm-codeblock").range(l.from));
            p = l.to + 1;
          }
          return false;
        case "Table":
          code.push({ from, to });
          if (!touches(state, from, to)) {
            const start = doc.lineAt(from).from;
            const end = doc.lineAt(to).to;
            out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(start, end)), block: true }).range(start, end));
            blocked.push({ from: start, to: end });
          } else {
            for (let p = from; p <= to; ) {
              const l = doc.lineAt(p);
              out.push(line("cm-table-src").range(l.from));
              p = l.to + 1;
            }
          }
          return false;
        case "HTMLBlock": case "Comment": case "CommentBlock": case "HTMLTag":
          code.push({ from, to });
          return false;
      }
      return undefined;
    },
  });

  // 4. Obsidian syntax the CommonMark parser doesn't know: wikilinks, embeds, tags, math, highlights.
  const skip = (from: number, to: number) => inside(blocked, from, to) || inside(code, from, to);
  for (const m of text.matchAll(WIKI_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (from < bodyStart || skip(from, to)) continue;
    const link = parseWikiLink(m[2]);
    const embed = m[1] === "!";
    const resolved = ctx.resolve(link.target);
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
            : new NoteEmbedWidget(resolved, link.target, ctx);
      out.push(Decoration.replace({ widget }).range(from, to));
    } else {
      const target = m[2].split("|")[0];
      out.push(Decoration.replace({ widget: new LinkWidget(linkLabel(link), target, resolved !== null) }).range(from, to));
    }
    code.push({ from, to });
  }
  for (const m of text.matchAll(TAG_RE)) {
    const from = m.index! + m[1].length;
    const to = from + 1 + m[2].length;
    if (from < bodyStart || skip(from, to)) continue;
    out.push(mark("cm-tag", { "data-tag": m[2] }).range(from, to));
  }
  for (const m of text.matchAll(MATH_INLINE_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (from < bodyStart || skip(from, to)) continue;
    if (touches(state, from, to)) out.push(mark("cm-math-src").range(from, to));
    else out.push(Decoration.replace({ widget: new MathWidget(m[1], false) }).range(from, to));
  }
  for (const m of text.matchAll(HIGHLIGHT_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (from < bodyStart || skip(from, to)) continue;
    out.push(mark("cm-highlight").range(from, to));
    if (!touches(state, from, to)) out.push(hide.range(from, from + 2), hide.range(to - 2, to));
  }

  return Decoration.set(out, true);
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
    : new ImageWidget(ctx.resolve(src), alt || src, embedWidth(alt.split("|")[1] ?? null), ctx);
  out.push(Decoration.replace({ widget }).range(node.from, node.to));
}

function decorateFence(
  state: EditorState,
  ctx: EditorContext,
  node: SyntaxNode,
  out: Range<Decoration>[],
  code: Span[],
  blocked: Span[],
) {
  const doc = state.doc;
  const { from, to } = node;
  code.push({ from, to });
  const info = node.getChild("CodeInfo");
  const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
  const start = doc.lineAt(from);
  const end = doc.lineAt(to);
  const active = touches(state, start.from, end.to);
  if (!active && blockRenderers.has(lang) && end.number > start.number) {
    const body = end.number - start.number >= 2 ? doc.sliceString(doc.line(start.number + 1).from, doc.line(end.number - 1).to) : "";
    out.push(Decoration.replace({ widget: new RenderedBlockWidget(lang, body, ctx), block: true }).range(start.from, end.to));
    blocked.push({ from: start.from, to: end.to });
    return;
  }
  for (let n = start.number; n <= end.number; n++) {
    const l = doc.line(n);
    const cls = n === start.number ? "cm-codeblock cm-codeblock-begin" : n === end.number ? "cm-codeblock cm-codeblock-end" : "cm-codeblock";
    out.push(line(cls).range(l.from));
  }
  if (!active) {
    for (const m of node.getChildren("CodeMark")) out.push(hide.range(m.from, m.to));
    if (info) out.push(mark("cm-codeinfo").range(info.from, info.to));
  }
}

/** Dispatch to re-render after something outside the document changed (e.g. files were created). */
export const refreshPreview = StateEffect.define<null>();

const livePreviewField = StateField.define<DecorationSet>({
  create: build,
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.reconfigured || tr.effects.some((e) => e.is(refreshPreview))) {
      return build(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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

export function livePreview(): Extension {
  return [livePreviewField, linkClicks];
}
