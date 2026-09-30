// Static Markdown → HTML for places that aren't the editor (canvas cards, embeds). Output is always
// sanitised: vault content may come from anywhere (including AI agents) and must never run code here.

import { Marked } from "marked";
import DOMPurify from "dompurify";
import { parseWikiLink, linkLabel } from "./links";

const marked = new Marked({ gfm: true, breaks: false });

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function renderMarkdown(src: string, resolve?: (target: string) => string | null): string {
  // Wikilinks become spans the host can make clickable; embeds become a labelled chip.
  const withLinks = src.replace(/(!?)\[\[([^[\]\n]+?)\]\]/g, (_m, bang: string, inner: string) => {
    const l = parseWikiLink(inner);
    const resolved = resolve ? resolve(l.target) !== null : true;
    const cls = `md-wikilink${resolved ? "" : " unresolved"}${bang ? " embed" : ""}`;
    return `<span class="${cls}" data-target="${escapeAttr(l.target)}">${escapeAttr(linkLabel(l))}</span>`;
  });
  const html = marked.parse(withLinks, { async: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-target"], FORBID_TAGS: ["style", "iframe", "form"] });
}
