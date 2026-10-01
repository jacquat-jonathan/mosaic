// Static Markdown → HTML for places that aren't the editor (canvas cards, embeds). Output is always
// sanitised: vault content may come from anywhere (including AI agents) and must never run code here.

import { Marked, type TokenizerAndRendererExtension } from "marked";
import DOMPurify from "dompurify";
import { parseWikiLink, linkLabel } from "./links";
import { renderMath } from "./editor/render";

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

const marked = new Marked({ gfm: true, breaks: false, extensions: [mathBlock, mathInline] });

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Markdown → HTML, not yet sanitised. Use `renderMarkdown`; this is exported for tests. */
export function markdownToHtml(src: string, resolve?: (target: string) => string | null): string {
  // Wikilinks become spans the host can make clickable; embeds become a labelled chip.
  const withLinks = src.replace(/(!?)\[\[([^[\]\n]+?)\]\]/g, (_m, bang: string, inner: string) => {
    const l = parseWikiLink(inner);
    const resolved = resolve ? resolve(l.target) !== null : true;
    const cls = `md-wikilink${resolved ? "" : " unresolved"}${bang ? " embed" : ""}`;
    return `<span class="${cls}" data-target="${escapeAttr(l.target)}">${escapeAttr(linkLabel(l))}</span>`;
  });
  return marked.parse(withLinks, { async: false });
}

export function renderMarkdown(src: string, resolve?: (target: string) => string | null): string {
  return DOMPurify.sanitize(markdownToHtml(src, resolve), { ADD_ATTR: ["data-target"], FORBID_TAGS: ["style", "iframe", "form"] });
}
