// Renderers shared by editor widgets and viewers: KaTeX and Mermaid, with caching.

import katex from "katex";
import "katex/dist/katex.min.css";
import { isDark } from "../theme";

export function renderMath(src: string, display: boolean): string {
  return katex.renderToString(src, { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
}


let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
let mermaidTheme = "";
const mermaidCache = new Map<string, string>();
let seq = 0;

/** Renders a Mermaid diagram to SVG markup. Loaded lazily: Mermaid is large. */
export async function renderMermaid(src: string): Promise<string> {
  const theme = isDark() ? "dark" : "default";
  const key = `${theme}\n${src}`;
  const hit = mermaidCache.get(key);
  if (hit) return hit;
  mermaidReady ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidReady;
  if (mermaidTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "inherit" });
    mermaidTheme = theme;
  }
  const { svg } = await mermaid.render(`mermaid-${++seq}`, src);
  mermaidCache.set(key, svg);
  return svg;
}
