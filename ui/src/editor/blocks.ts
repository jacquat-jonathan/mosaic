// Renderers for fenced code blocks by language (Mermaid, math, Vega-Lite, Graphviz), shared by the
// note editor and by static Markdown (canvas cards, file-card previews).

import { renderMath, renderMermaid } from "./render";
import { renderChart, renderGraphviz } from "../viewers/visuals";

/** Renders `source` into `el`; `path` is the file it's in (charts load their data relative to it). */
export type BlockRenderer = (source: string, el: HTMLElement, ctx: { path: string }) => void | Promise<void>;
export const blockRenderers = new Map<string, BlockRenderer>();

export function registerBlockRenderer(langs: string[], r: BlockRenderer) {
  for (const l of langs) blockRenderers.set(l, r);
}

registerBlockRenderer(["mermaid"], async (src, el) => {
  el.innerHTML = await renderMermaid(src);
});
registerBlockRenderer(["math", "latex", "tex"], (src, el) => {
  el.innerHTML = renderMath(src, true);
});
registerBlockRenderer(["vega-lite", "vegalite", "chart"], (src, el, ctx) => renderChart(src, el, ctx.path));
registerBlockRenderer(["dot", "graphviz"], (src, el) => renderGraphviz(src, el));

export function showRenderError(el: HTMLElement, err: unknown) {
  el.classList.add("cm-render-error");
  el.textContent = err instanceof Error ? err.message : String(err);
}

/**
 * Replaces the fenced diagram blocks in rendered Markdown (`<pre><code class="language-…">`) with the
 * rendered diagram. Blocks in other languages stay as code.
 */
export function renderBlocksIn(root: HTMLElement, path: string): void {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
    const lang = /language-(\S+)/.exec(code.className)?.[1]?.toLowerCase() ?? "";
    const render = blockRenderers.get(lang);
    if (!render) continue;
    const el = document.createElement("div");
    el.className = `md-diagram md-lang-${lang}`;
    code.parentElement!.replaceWith(el);
    try {
      const out = render(code.textContent ?? "", el, { path });
      if (out instanceof Promise) out.catch((e) => showRenderError(el, e));
    } catch (e) {
      showRenderError(el, e);
    }
  }
}
