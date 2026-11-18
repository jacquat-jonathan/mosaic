// Renderers shared by editor widgets and viewers: KaTeX and Mermaid, with caching.

import katex from "katex";
import "katex/dist/katex.min.css";
import { HIGH_CONTRAST, paletteVariables } from "../colorThemes";
import { isDark, visualTheme } from "../theme";

export function renderMath(src: string, display: boolean): string {
  return katex.renderToString(src, { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
}

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
let mermaidTheme = "";
const mermaidCache = new Map<string, string>();
let seq = 0;

/** Mermaid's built-in themes, or solid palette colours with full-strength lines for High contrast. */
function mermaidColors() {
  const dark = isDark();
  if (!visualTheme().startsWith("high-contrast")) return { theme: dark ? "dark" : "default" } as const;
  const c = paletteVariables(HIGH_CONTRAST, dark, "theme");
  return {
    theme: "base",
    themeVariables: {
      darkMode: dark,
      background: c.bg,
      fontSize: "16px",
      primaryColor: c.bg,
      primaryTextColor: c.fg,
      primaryBorderColor: c.fg,
      secondaryColor: c["bg-side"],
      secondaryTextColor: c.fg,
      secondaryBorderColor: c.fg,
      tertiaryColor: c["bg-side"],
      tertiaryTextColor: c.fg,
      tertiaryBorderColor: c.fg,
      lineColor: c.fg,
      textColor: c.fg,
      mainBkg: c.bg,
      nodeBorder: c.fg,
      clusterBkg: c["bg-side"],
      clusterBorder: c.fg,
      edgeLabelBackground: c.bg,
      titleColor: c.fg,
      noteBkgColor: c["bg-side"],
      noteTextColor: c.fg,
      noteBorderColor: c.fg,
      actorBkg: c.bg,
      actorBorder: c.fg,
      actorTextColor: c.fg,
      signalColor: c.fg,
      signalTextColor: c.fg,
      labelTextColor: c.fg,
    },
  } as const;
}

/** Renders a Mermaid diagram to SVG markup. Loaded lazily: Mermaid is large. */
export async function renderMermaid(src: string): Promise<string> {
  const visual = visualTheme();
  const key = `${visual}\n${src}`;
  const hit = mermaidCache.get(key);
  if (hit) return hit;
  mermaidReady ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidReady;
  if (mermaidTheme !== visual) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", fontFamily: "inherit", ...mermaidColors() });
    mermaidTheme = visual;
  }
  const { svg } = await mermaid.render(`mermaid-${++seq}`, src);
  mermaidCache.set(key, svg);
  return svg;
}
