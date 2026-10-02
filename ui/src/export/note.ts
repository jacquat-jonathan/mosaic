// Export a note as one standalone HTML file (diagrams drawn, images and canvases embedded, math as
// MathML, so it opens anywhere without Mosaic or the network), or print it ("Save as PDF").

import { api, fileUrl } from "../ipc/api";
import { kindOf } from "../ipc/kinds";
import { resolveLink, parseWikiLink } from "../links";
import { renderMarkdown } from "../markdown";
import { renderBlocksAll } from "../editor/blocks";
import { useVault, parentOf } from "../state/vault";
import { useWorkspace } from "../state/workspace";

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A light, readable page; KaTeX's HTML layer is hidden so browsers show its MathML (no fonts needed). */
const RULES: [selector: string, declarations: string][] = [
  ["body", 'font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; background: #fff; max-width: 760px; margin: 40px auto; padding: 0 24px'],
  ["h1, h2, h3, h4", "line-height: 1.25; margin: 1.4em 0 0.5em"],
  ["h1", "font-size: 2em"],
  ["h2", "font-size: 1.5em"],
  ["h3", "font-size: 1.2em"],
  ["a, .link", "color: #2f6feb; text-decoration: none"],
  ["code", "font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 0.1em 0.35em; border-radius: 4px"],
  ["pre", "background: #f6f8fa; padding: 12px 16px; border-radius: 8px; overflow: auto"],
  ["pre code", "background: none; padding: 0"],
  ["blockquote", "margin: 1em 0; padding: 0 1em; color: #57606a; border-left: 3px solid #d0d7de"],
  ["table", "border-collapse: collapse; margin: 1em 0"],
  ["th, td", "border: 1px solid #d0d7de; padding: 6px 12px"],
  ["img, svg", "max-width: 100%; height: auto"],
  [".md-diagram, .embed-canvas", "margin: 1em 0; text-align: center"],
  [".katex-html", "display: none"],
  [".properties", "font-size: 0.9em; color: #57606a; border: 1px solid #d0d7de; border-radius: 8px; padding: 8px 14px; margin-bottom: 24px"],
  [".properties dt", "float: left; clear: left; width: 120px; font-weight: 600"],
  [".properties dd", "margin: 0 0 0 130px"],
  [".embed-note", "border-left: 3px solid #d0d7de; padding-left: 1em; margin: 1em 0"],
  [".missing", "color: #8a8f9c; font-style: italic"],
];

/** The page's CSS for a standalone file, or scoped under `prefix` (the print preview inside the app). */
export function exportCss(prefix?: string): string {
  const scope = (sel: string) =>
    sel
      .split(",")
      .map((x) => (prefix ? (x.trim() === "body" ? prefix : `${prefix} ${x.trim()}`) : x.trim()))
      .join(", ");
  return `${prefix ? "" : ":root { color-scheme: light; }\n"}${RULES.map(([sel, decl]) => `${scope(sel)} { ${decl}; }`).join("\n")}\n@page { margin: 18mm; }\n`;
}

async function asDataUrl(path: string): Promise<string | null> {
  try {
    const url = await fileUrl(path);
    if (url.startsWith("data:")) return url;
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function propertiesHtml(yaml: string): string {
  const rows = yaml
    .split("\n")
    .map((l) => /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && m[2] !== "");
  if (!rows.length) return "";
  return `<dl class="properties">${rows.map((m) => `<dt>${escapeHtml(m[1])}</dt><dd>${escapeHtml(m[2].replace(/^\[|\]$/g, ""))}</dd>`).join("")}</dl>`;
}

/** The note's body as standalone HTML (no <html> wrapper). `depth` stops embedded notes recursing. */
async function noteBody(path: string, text: string, depth = 0): Promise<string> {
  const fm = FRONTMATTER.exec(text);
  const body = fm ? text.slice(fm[0].length) : text;
  const entries = useVault.getState().entries;
  const host = document.createElement("div");
  // Laid out off screen: Mermaid measures text while drawing.
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:760px";
  host.innerHTML = renderMarkdown(body, (t) => resolveLink(t, entries, path));
  document.body.appendChild(host);
  try {
    await renderBlocksAll(host, path);
    for (const span of [...host.querySelectorAll<HTMLElement>(".md-wikilink")]) {
      const target = span.dataset.target ?? "";
      const resolved = resolveLink(target, entries, path);
      if (!span.classList.contains("embed")) {
        span.outerHTML = `<span class="link">${escapeHtml(span.textContent ?? target)}</span>`;
        continue;
      }
      if (!resolved) {
        span.outerHTML = `<span class="missing">${escapeHtml(target)} (missing)</span>`;
        continue;
      }
      const kind = kindOf(resolved);
      if (kind === "image") {
        const data = await asDataUrl(resolved);
        span.outerHTML = data ? `<img src="${data}" alt="${escapeHtml(parseWikiLink(target).target)}">` : `<span class="missing">${escapeHtml(target)}</span>`;
      } else if (kind === "canvas") {
        const [{ parseCanvas }, { canvasToSvg }] = await Promise.all([import("../viewers/canvas/jsonCanvas"), import("../diagrams/canvasToSvg")]);
        span.outerHTML = `<div class="embed-canvas">${canvasToSvg(parseCanvas((await api.read(resolved)).content ?? ""), false)}</div>`;
      } else if (kind === "markdown" && depth < 1) {
        const inner = await noteBody(resolved, (await api.read(resolved)).content ?? "", depth + 1);
        span.outerHTML = `<div class="embed-note">${inner}</div>`;
      } else {
        span.outerHTML = `<span class="link">${escapeHtml(target)}</span>`;
      }
    }
    // Markdown images ![](picture.png) point at vault files: embed them too.
    for (const img of [...host.querySelectorAll<HTMLImageElement>("img")]) {
      const src = img.getAttribute("src") ?? "";
      if (/^(data:|https?:)/.test(src)) continue;
      const resolved = resolveLink(decodeURI(src), entries, path, [], true);
      const data = resolved && (await asDataUrl(resolved));
      if (data) img.src = data;
    }
    return (fm && depth === 0 ? propertiesHtml(fm[1]) : "") + host.innerHTML;
  } finally {
    host.remove();
  }
}

function noteText(path: string): Promise<string> {
  const buf = useWorkspace.getState().buffers[path];
  return buf?.content != null ? Promise.resolve(buf.content) : api.read(path).then((f) => f.content ?? "");
}

const titleOf = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");

/** A complete HTML document for the note. */
export async function noteToHtml(path: string): Promise<string> {
  const body = await noteBody(path, await noteText(path));
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(titleOf(path))}</title><style>${exportCss()}</style></head><body>${body}</body></html>\n`;
}

/** Writes `<note>.html` next to the note (never overwriting) and opens it. */
export async function exportNoteHtml(path: string): Promise<string> {
  const html = await noteToHtml(path);
  const dir = parentOf(path);
  const name = `${titleOf(path)}.html`;
  const written = await api.importFile(dir ? `${dir}/${name}` : name, new TextEncoder().encode(html));
  await useWorkspace.getState().open(written.path, { newTab: true });
  return written.path;
}

/**
 * A print preview of the note over the app; "Print / Save as PDF" opens the macOS print dialog.
 * Print CSS shows only the preview's page.
 */
export async function printNote(path: string): Promise<void> {
  const body = await noteBody(path, await noteText(path));
  document.querySelector(".print-root")?.remove();
  const root = document.createElement("div");
  root.className = "print-root";
  root.innerHTML = `<div class="print-toolbar"><span>${escapeHtml(titleOf(path))}</span><span class="spacer"></span><button class="secondary" data-act="close">Close</button><button class="primary" data-act="print">Print / Save as PDF</button></div><div class="print-page"><style>${exportCss(".print-page")}</style>${body}</div>`;
  const close = () => root.remove();
  root.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") close();
    if (act === "print") void api.printWindow().catch((err) => useVault.getState().setError(String(err?.message ?? err)));
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey);
    }
  };
  window.addEventListener("keydown", onKey);
  document.body.appendChild(root);
}
