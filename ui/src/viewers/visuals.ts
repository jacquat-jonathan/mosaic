// Chart (Vega-Lite) and graph (Graphviz) rendering. Both libraries are bundled and run fully offline;
// chart data referenced by URL is loaded from the vault, never from the network.

import Papa from "papaparse";
import { api } from "../ipc/api";
import { parentOf } from "../state/vault";

const isDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

function resolveRelative(fromFile: string, rel: string): string {
  const parts = parentOf(fromFile).split("/").filter(Boolean);
  for (const seg of rel.replace(/^\//, "").split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Replaces every `data: { url }` in a spec with inline values read from the vault. */
async function inlineData(spec: unknown, fromFile: string): Promise<void> {
  if (!spec || typeof spec !== "object") return;
  const obj = spec as Record<string, unknown>;
  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data.url === "string") {
    const url = data.url;
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) throw new Error(`Remote data isn't loaded (Mosaic works offline): ${url}`);
    const path = resolveRelative(fromFile, decodeURI(url));
    const text = (await api.read(path)).content ?? "";
    const type = (data.format as { type?: string } | undefined)?.type ?? (/\.(csv|tsv)$/i.test(path) ? "csv" : "json");
    const values =
      type === "csv" || type === "tsv"
        ? Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true, delimiter: type === "tsv" ? "\t" : "" }).data
        : JSON.parse(text);
    const property = (data.format as { property?: string } | undefined)?.property;
    obj.data = { ...Object.fromEntries(Object.entries(data).filter(([k]) => k !== "url" && k !== "format")), values: property ? values[property] : values };
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) for (const item of v) await inlineData(item, fromFile);
    else if (v && typeof v === "object") await inlineData(v, fromFile);
  }
}

const offlineLoader = {
  load: async (uri: string) => {
    throw new Error(`Network access is disabled: ${uri}`);
  },
  sanitize: async (uri: string) => {
    throw new Error(`Network access is disabled: ${uri}`);
  },
  http: async (uri: string) => {
    throw new Error(`Network access is disabled: ${uri}`);
  },
  file: async (uri: string) => {
    throw new Error(`Network access is disabled: ${uri}`);
  },
};

export async function renderChart(source: string, el: HTMLElement, fromFile: string): Promise<void> {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(source);
  } catch (e) {
    throw new Error(`Chart spec is not valid JSON: ${(e as Error).message}`);
  }
  await inlineData(spec, fromFile);
  const { default: embed } = await import("vega-embed");
  el.innerHTML = "";
  const target = document.createElement("div");
  el.appendChild(target);
  await embed(target, spec as never, {
    actions: false,
    renderer: "svg",
    theme: isDark() ? "dark" : undefined,
    config: { background: "transparent", view: { continuousWidth: 520, continuousHeight: 300, step: 44 } },
    loader: offlineLoader as never,
  });
}

let vizInstance: Promise<import("@viz-js/viz").Viz> | null = null;

export async function renderGraphviz(source: string, el: HTMLElement): Promise<void> {
  vizInstance ??= import("@viz-js/viz").then((m) => m.instance());
  const viz = await vizInstance;
  const fg = isDark() ? "#e4e5ea" : "#1d1f26";
  const result = viz.render(source, {
    format: "svg",
    graphAttributes: { bgcolor: "transparent", color: fg, fontcolor: fg, fontname: "Helvetica" },
    nodeAttributes: { color: fg, fontcolor: fg, fontname: "Helvetica" },
    edgeAttributes: { color: fg, fontcolor: fg, fontname: "Helvetica" },
  });
  if (result.status !== "success") {
    throw new Error(result.errors.map((e) => e.message).join("\n") || "Graphviz couldn't render this graph.");
  }
  el.innerHTML = result.output;
}
