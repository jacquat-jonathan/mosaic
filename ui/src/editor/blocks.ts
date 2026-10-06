// Renderers for fenced code blocks by language (Mermaid, math, Vega-Lite, Graphviz, queries), shared by the
// note editor and by static Markdown (canvas cards, file-card previews).

import { renderMath, renderMermaid } from "./render";
import { renderChart, renderGraphviz } from "../viewers/visuals";
import { renderQuery } from "./queryBlock";
import { errorMessage } from "../ipc/types";

/** Renders `source` into `el`; `path` is the file it's in (charts load their data relative to it).
 * `replaceSource` is present for an editable fenced block in the note editor. */
export type BlockRenderer = (
  source: string,
  el: HTMLElement,
  ctx: { path: string; replaceSource?: (source: string) => void },
) => void | Promise<void>;
export const blockRenderers = new Map<string, BlockRenderer>();

export function registerBlockRenderer(langs: string[], r: BlockRenderer) {
  for (const l of langs) blockRenderers.set(l, r);
}

registerBlockRenderer(["mermaid"], async (src, el) => {
  el.innerHTML = await renderMermaid(src);
  addFlowHover(el);
});

/**
 * Hovering a node of a rendered Mermaid flowchart animates its connections in their direction and
 * dims the rest, like on canvases. Flowchart edges are named `L_<from>_<to>_<n>`.
 */
export function addFlowHover(root: HTMLElement): void {
  const svg = root.querySelector("svg");
  if (!svg) return;
  const nodes = new Map<string, Element>();
  for (const g of svg.querySelectorAll("g.node")) {
    const m = /flowchart-(.+)-\d+$/.exec(g.id);
    if (m) nodes.set(m[1], g);
  }
  if (!nodes.size) return;
  const edges: { path: Element; from: string; to: string }[] = [];
  for (const p of svg.querySelectorAll<SVGPathElement>("path[data-edge]")) {
    const named = /^L_(.+)_\d+$/.exec(p.dataset.id ?? "");
    if (!named) continue;
    const parts = named[1].split("_");
    for (let i = 1; i < parts.length; i++) {
      const from = parts.slice(0, i).join("_");
      const to = parts.slice(i).join("_");
      if (nodes.has(from) && nodes.has(to)) {
        edges.push({ path: p, from, to });
        break;
      }
    }
  }
  for (const [id, g] of nodes) {
    g.addEventListener("mouseenter", () => {
      const mine = edges.filter((e) => e.from === id || e.to === id);
      if (!mine.length) return;
      svg.classList.add("flow-hover");
      g.classList.add("flow-near");
      for (const e of mine) {
        e.path.classList.add("flow-on");
        nodes.get(e.from)!.classList.add("flow-near");
        nodes.get(e.to)!.classList.add("flow-near");
      }
    });
    g.addEventListener("mouseleave", () => {
      svg.classList.remove("flow-hover");
      for (const el of svg.querySelectorAll(".flow-on, .flow-near")) el.classList.remove("flow-on", "flow-near");
    });
  }
}
registerBlockRenderer(["math", "latex", "tex"], (src, el) => {
  el.innerHTML = renderMath(src, true);
});
registerBlockRenderer(["vega-lite", "vegalite", "chart"], (src, el, ctx) => renderChart(src, el, ctx.path));
registerBlockRenderer(["dot", "graphviz"], (src, el) => renderGraphviz(src, el));
registerBlockRenderer(["query"], (src, el, ctx) => renderQuery(src, el, ctx.replaceSource));

export function showRenderError(el: HTMLElement, err: unknown) {
  el.classList.add("cm-render-error");
  // Core errors arrive as { code, message }, not as Error objects.
  el.textContent = errorMessage(err);
}

/**
 * Replaces the fenced diagram blocks in rendered Markdown (`<pre><code class="language-…">`) with the
 * rendered diagram. Blocks in other languages stay as code.
 */
export function renderBlocksIn(root: HTMLElement, path: string): void {
  void renderBlocksAll(root, path);
}

/** Like `renderBlocksIn`, resolving once every diagram has finished drawing (for exports). */
export async function renderBlocksAll(root: HTMLElement, path: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const code of root.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
    const lang = /language-(\S+)/.exec(code.className)?.[1]?.toLowerCase() ?? "";
    const render = blockRenderers.get(lang);
    if (!render) continue;
    const el = document.createElement("div");
    el.className = `md-diagram md-lang-${lang}`;
    code.parentElement!.replaceWith(el);
    try {
      const out = render(code.textContent ?? "", el, { path });
      if (out instanceof Promise) pending.push(out.catch((e) => showRenderError(el, e)));
    } catch (e) {
      showRenderError(el, e);
    }
  }
  await Promise.all(pending);
}
