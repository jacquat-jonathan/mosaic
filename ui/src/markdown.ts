// Static Markdown → HTML for places that aren't the editor (canvas cards, embeds). Output is always
// sanitised: vault content may come from anywhere (including AI agents) and must never run code here.

import { Marked, type RendererExtension, type TokenizerAndRendererExtension, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { parseWikiLink, linkLabel } from "./links";
import { renderMath } from "./editor/render";
import { CALLOUT_KINDS, parseCalloutHeader } from "./callouts";

/** Inline math `$…$`, as in notes: no space inside the dollars, and `$5` prices don't count. */
export const MATH_INLINE_RE = /(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g;

const mathInline: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start: (src) => src.indexOf("$"),
  tokenizer(src) {
    const m = /^\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/.exec(src);
    return m ? { type: "mathInline", raw: m[0], text: m[1] } : undefined;
  },
  renderer: (t) => renderMath(t.text, false),
};

/** Display math: `$$` on its own line … `$$` on its own line. */
const mathBlock: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start: (src) => src.match(/^\$\$/m)?.index,
  tokenizer(src) {
    const m = /^\$\$[ \t]*\n([\s\S]*?)\n\$\$[ \t]*(?:\n|$)/.exec(src);
    return m ? { type: "mathBlock", raw: m[0], text: m[1] } : undefined;
  },
  renderer: (t) => `<div class="md-math">${renderMath(t.text, true)}</div>`,
};

/** Obsidian highlights: `==text==`. */
const highlight: TokenizerAndRendererExtension = {
  name: "highlight",
  level: "inline",
  start: (src) => src.indexOf("=="),
  tokenizer(src) {
    const m = /^==(?!\s)([^=\n]+?)(?<!\s)==/.exec(src);
    return m ? { type: "highlight", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
  },
  renderer(t) {
    return `<mark>${this.parser.parseInline(t.tokens ?? [])}</mark>`;
  },
};

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Panels: a blockquote whose first line is `[!type] title` (see callouts.ts); others render as quotes. */
const callout: RendererExtension = {
  name: "blockquote",
  renderer(token) {
    const quote = token as Tokens.Blockquote;
    // A quote inside a quote stays a quote, as in the editor.
    if ((quote as Tokens.Blockquote & { nested?: boolean }).nested) return false;
    const header = parseCalloutHeader(quote.raw.split("\n", 1)[0]);
    if (!header) return false;
    // The header shares its paragraph with any body lines right below it: cut its line off and
    // render the rest of the quote's text as the body.
    const newline = quote.text.indexOf("\n");
    const body = newline < 0 ? "" : quote.text.slice(newline + 1);
    const style = CALLOUT_KINDS[header.kind];
    const breaks = this.parser.options.breaks;
    const title = header.title
      ? marked.parseInline(header.title, { async: false, breaks })
      : escapeText(header.defaultTitle);
    const inner = body.trim() ? this.parser.parse(marked.lexer(body, { breaks })) : "";
    return (
      `<div class="callout callout-${header.kind}" data-callout="${escapeAttr(header.type)}">` +
      `<div class="callout-title"><span class="callout-icon" aria-hidden="true">${escapeText(style.icon)}</span>` +
      `<span>${title}</span></div>${inner ? `<div class="callout-body">${inner}</div>` : ""}</div>\n`
    );
  },
};

const marked = new Marked({
  gfm: true,
  breaks: false,
  extensions: [mathBlock, mathInline, highlight, callout],
  walkTokens(token) {
    if (token.type !== "blockquote") return;
    for (const child of (token as Tokens.Blockquote).tokens)
      if (child.type === "blockquote") (child as Tokens.Blockquote & { nested?: boolean }).nested = true;
  },
});

function withWikiLinks(src: string, resolve?: (target: string) => string | null): string {
  return src.replace(/(!?)\[\[([^[\]\n]+?)\]\]/g, (_m, bang: string, inner: string) => {
    const l = parseWikiLink(inner);
    const resolved = resolve ? resolve(l.target) !== null : true;
    const cls = `md-wikilink${resolved ? "" : " unresolved"}${bang ? " embed" : ""}`;
    return `<span class="${cls}" data-target="${escapeAttr(l.target)}">${escapeAttr(linkLabel(l))}</span>`;
  });
}

/** Markdown → HTML, not yet sanitised. Use `renderMarkdown`; this is exported for tests. */
export function markdownToHtml(src: string, resolve?: (target: string) => string | null, breaks = false): string {
  // Wikilinks become spans the host can make clickable; embeds become a labelled chip.
  const withLinks = src.replace(/(!?)\[\[([^[\]\n]+?)\]\]/g, (_m, bang: string, inner: string) => {
    const l = parseWikiLink(inner);
    const resolved = resolve ? resolve(l.target) !== null : true;
    const cls = `md-wikilink${resolved ? "" : " unresolved"}${bang ? " embed" : ""}`;
    return `<span class="${cls}" data-target="${escapeAttr(l.target)}">${escapeAttr(linkLabel(l))}</span>`;
  });
  return marked.parse(withLinks, { async: false, breaks });
}

/** `breaks`: every line break is kept (diagram shape labels are written line by line). */
export function renderMarkdown(src: string, resolve?: (target: string) => string | null, breaks = false): string {
  return DOMPurify.sanitize(markdownToHtml(src, resolve, breaks), {
    ADD_ATTR: ["data-target", "data-callout"],
    FORBID_TAGS: ["style", "iframe", "form"],
  });
}

/** Inline Markdown for table cells and labels, without a wrapping paragraph. */
export const inlineMarkdownToHtml = (src: string, resolve?: (target: string) => string | null) =>
  marked.parseInline(withWikiLinks(src, resolve), { async: false });
export function renderInlineMarkdown(src: string, resolve?: (target: string) => string | null): string {
  return DOMPurify.sanitize(inlineMarkdownToHtml(src, resolve), {
    ADD_ATTR: ["data-target"],
    FORBID_TAGS: ["style", "iframe", "form"],
  });
}
