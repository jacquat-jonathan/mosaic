// A note's ```mermaid block → an editable canvas, keeping the layout Mermaid computed. Flowcharts and
// state diagrams are supported: Mermaid renders the block, and the positions, sizes, labels and
// connections are read back from its SVG.

import { renderMermaid } from "../editor/render";
import { newId, type CanvasDoc, type CanvasEdge, type CanvasNode } from "../viewers/canvas/jsonCanvas";

/** Flowchart node shapes from their brackets in the source: `A[(DB)]` is a cylinder, `B{x}` a diamond… */
export function flowchartShapes(src: string): Map<string, string> {
  const openers: [string, string][] = [
    ["[(", "cylinder"],
    ["([", "pill"],
    ["[[", "process"],
    ["((", "ellipse"],
    ["{{", "hexagon"],
    ["[/", "parallelogram"],
    ["[\\", "parallelogram"],
    ["{", "diamond"],
    ["(", "rounded"],
    ["[", "rectangle"],
    [">", "rectangle"],
  ];
  const shapes = new Map<string, string>();
  for (const m of src.matchAll(/(?:^|[\s;&>-])([A-Za-z0-9_]+)\s*(\[\(|\(\[|\[\[|\(\(|\{\{|\[\/|\[\\|\{|\(|\[|>)/g)) {
    const [, id, open] = m;
    if (!shapes.has(id)) shapes.set(id, openers.find(([o]) => o === open)![1]);
  }
  for (const m of src.matchAll(/([A-Za-z0-9_]+)@\{\s*shape:\s*([\w-]+)/g)) {
    const named: Record<string, string> = { doc: "document", cloud: "cloud", "sm-circ": "initial", "fr-circ": "final", fork: "bar", cyl: "cylinder", diam: "diamond", hex: "hexagon", circle: "ellipse" };
    if (named[m[2]]) shapes.set(m[1], named[m[2]]);
  }
  return shapes;
}

type Kind = "flowchart" | "state";

export function diagramKind(src: string): Kind | null {
  const first = src.trim().split("\n")[0].trim();
  if (/^(flowchart|graph)\b/.test(first)) return "flowchart";
  if (/^stateDiagram(-v2)?\b/.test(first)) return "state";
  return null;
}

/** Spread Mermaid's compact layout a little: canvas cards use larger text. */
const SPREAD = 1.35;

export async function mermaidToCanvas(src: string): Promise<CanvasDoc> {
  const kind = diagramKind(src);
  if (!kind) throw new Error("Only flowcharts and state diagrams can be opened as diagrams for now.");
  const svgText = await renderMermaid(src);
  // Laid out at 1:1 off screen, so client rectangles are in the SVG's own units.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
  host.innerHTML = svgText;
  document.body.appendChild(host);
  try {
    const svg = host.querySelector("svg")!;
    const [, , vw, vh] = (svg.getAttribute("viewBox") ?? "0 0 0 0").split(/[\s,]+/).map(Number);
    svg.removeAttribute("style");
    svg.setAttribute("width", String(vw));
    svg.setAttribute("height", String(vh));
    const origin = svg.getBoundingClientRect();
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: (r.left - origin.left) * SPREAD, y: (r.top - origin.top) * SPREAD, w: r.width, h: r.height };
    };
    const shapes = kind === "flowchart" ? flowchartShapes(src) : new Map<string, string>();
    const nodes: CanvasNode[] = [];
    const byMermaidId = new Map<string, CanvasNode>();
    for (const g of host.querySelectorAll("g.cluster")) {
      const b = box(g);
      nodes.push({ id: newId(), type: "group", x: Math.round(b.x - 10), y: Math.round(b.y - 10), width: Math.round(b.w * SPREAD + 20), height: Math.round(b.h * SPREAD + 20), label: g.textContent?.trim() ?? "" });
    }
    for (const g of host.querySelectorAll("g.node")) {
      const m = /(?:flowchart|state)-(.+)-\d+$/.exec(g.id);
      if (!m) continue;
      const id = m[1];
      const b = box(g);
      const text = g.textContent?.trim() ?? "";
      let shape = shapes.get(id) ?? "rounded";
      if (kind === "state") shape = id.endsWith("_start") ? "initial" : id.endsWith("_end") ? "final" : "pill";
      const small = shape === "initial" || shape === "final";
      const width = small ? 30 : Math.max(100, Math.round(b.w * 1.15));
      const height = small ? 30 : Math.max(50, Math.round(b.h * 1.15));
      // Keep the centre where Mermaid put it.
      const node: CanvasNode = { id: newId(), type: "text", x: Math.round(b.x + (b.w * SPREAD) / 2 - width / 2), y: Math.round(b.y + (b.h * SPREAD) / 2 - height / 2), width, height, text, shape };
      nodes.push(node);
      byMermaidId.set(id, node);
    }
    const centre = (n: CanvasNode) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });
    const nearest = (p: { x: number; y: number }) =>
      [...byMermaidId.values()].reduce((best, n) => (Math.hypot(centre(n).x - p.x, centre(n).y - p.y) < Math.hypot(centre(best).x - p.x, centre(best).y - p.y) ? n : best));
    const labels = new Map<string, string>();
    for (const l of host.querySelectorAll(".edgeLabel [data-id]")) labels.set(l.getAttribute("data-id")!, l.textContent?.trim() ?? "");
    const edges: CanvasEdge[] = [];
    for (const p of host.querySelectorAll<SVGPathElement>("path[data-edge]")) {
      const dataId = p.dataset.id ?? "";
      let from: CanvasNode | undefined;
      let to: CanvasNode | undefined;
      // Flowchart edges are named L_<from>_<to>_<n>; node ids may contain "_", so try every split.
      const named = /^L_(.+)_\d+$/.exec(dataId);
      if (named) {
        const parts = named[1].split("_");
        for (let i = 1; i < parts.length && !from; i++) {
          const a = byMermaidId.get(parts.slice(0, i).join("_"));
          const b = byMermaidId.get(parts.slice(i).join("_"));
          if (a && b) [from, to] = [a, b];
        }
      }
      if ((!from || !to) && byMermaidId.size) {
        // State diagram edges aren't named after their ends: match the path's ends to the nearest states.
        const ctm = p.getCTM();
        const at = (len: number) => {
          const pt = p.getPointAtLength(len).matrixTransform(ctm ?? undefined);
          return { x: pt.x * SPREAD, y: pt.y * SPREAD };
        };
        from = nearest(at(0));
        to = nearest(at(p.getTotalLength()));
      }
      if (!from || !to) continue;
      const cls = p.getAttribute("class") ?? "";
      const end = (marker: string | null) => (!marker ? "none" : /circle/i.test(marker) ? "circle" : "arrow");
      const e: CanvasEdge = { id: newId(), fromNode: from.id, toNode: to.id };
      const toEnd = end(p.getAttribute("marker-end"));
      const fromEnd = end(p.getAttribute("marker-start"));
      if (toEnd !== "arrow") e.toEnd = toEnd;
      if (fromEnd !== "none") e.fromEnd = fromEnd;
      if (/pattern-(dotted|dashed)/.test(cls)) e.line = "dashed";
      if (/thickness-thick/.test(cls)) e.thickness = 4;
      const label = labels.get(dataId);
      if (label) e.label = label;
      edges.push(e);
    }
    return { nodes, edges };
  } finally {
    host.remove();
  }
}
