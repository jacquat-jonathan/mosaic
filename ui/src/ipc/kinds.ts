import type { FileKind } from "./types";

/** Same rules as mosaic-core `FileKind::of`. */
export function kindOf(path: string): FileKind {
  const name = path.toLowerCase();
  if (name.endsWith(".vl.json")) return "json";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const map: Record<string, FileKind> = {
    md: "markdown", markdown: "markdown", canvas: "canvas", excalidraw: "excalidraw",
    html: "html", htm: "html", png: "image", jpg: "image", jpeg: "image", gif: "image",
    webp: "image", svg: "image", pdf: "pdf", csv: "csv", tsv: "csv", json: "json",
    yaml: "yaml", yml: "yaml", dot: "graphviz", gv: "graphviz", txt: "text",
    js: "code", ts: "code", tsx: "code", py: "code", rs: "code", swift: "code", kt: "code",
    css: "code", sh: "code", sql: "code", toml: "code", xml: "code",
  };
  return map[ext] ?? "other";
}

export const isTextKind = (k: FileKind) => !["image", "pdf", "other"].includes(k);
