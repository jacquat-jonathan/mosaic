// A note's ```mermaid block → an editable canvas, keeping the layout Mermaid computed. Flowcharts,
// state and class diagrams are supported: Mermaid renders the block, and the positions, sizes, labels
// and connections are read back from its SVG. Class boxes and relations come from the source itself
// (members, stereotypes, arrowheads, multiplicities), with only their positions taken from the SVG.

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

type Kind = "flowchart" | "state" | "class";

export function diagramKind(src: string): Kind | null {
  const first = src.trim().split("\n")[0].trim();
  if (/^(flowchart|graph)\b/.test(first)) return "flowchart";
  if (/^stateDiagram(-v2)?\b/.test(first)) return "state";
  if (/^classDiagram(-v2)?\b/.test(first)) return "class";
  return null;
}

/** Spread Mermaid's compact layout a little: canvas cards use larger text. */
const SPREAD = 1.35;

export async function mermaidToCanvas(src: string): Promise<CanvasDoc> {
  const kind = diagramKind(src);
  if (!kind) throw new Error("Only flowcharts, state and class diagrams can be opened as diagrams for now.");
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
    if (kind === "class") return classCanvas(src, host, box);
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

export interface ClassInfo {
  name: string;
  stereotypes: string[];
  attributes: string[];
  methods: string[];
}

export interface Relation {
  from: string;
  to: string;
  fromEnd: string;
  toEnd: string;
  dashed: boolean;
  fromLabel?: string;
  toLabel?: string;
  label?: string;
}

const LEFT_END: Record<string, string> = { "<|": "triangle", "*": "diamond", o: "diamond-open", "<": "arrow" };
const RIGHT_END: Record<string, string> = { "|>": "triangle", "*": "diamond", o: "diamond-open", ">": "arrow" };
const RELATION = /^([\w~]+)(?:\s+"([^"]*)")?\s+(<\||\*|o|<)?(--|\.\.)(\|>|\*|o|>)?\s+(?:"([^"]*)"\s+)?([\w~]+)\s*(?::\s*(.+))?$/;

/** Canvas member style: `+total() Money` → `+ total(): Money`. */
const memberText = (m: string) => m.trim().replace(/^([-+#~])\s*/, "$1 ").replace(/\)\s*([^\s:$*].*)$/, "): $1");

/** Classes (in order of appearance) and relations of a Mermaid class diagram. */
export function parseClassDiagram(src: string): { classes: ClassInfo[]; relations: Relation[] } {
  const classes = new Map<string, ClassInfo>();
  const get = (name: string) => {
    if (!classes.has(name)) classes.set(name, { name, stereotypes: [], attributes: [], methods: [] });
    return classes.get(name)!;
  };
  const addMember = (c: ClassInfo, m: string) => {
    const t = m.trim();
    if (!t) return;
    const st = /^<<(.+)>>$/.exec(t);
    if (st) c.stereotypes.push(st[1]);
    else (t.includes("(") ? c.methods : c.attributes).push(memberText(t));
  };
  const relations: Relation[] = [];
  let open: ClassInfo | null = null;
  for (const raw of src.split("\n").slice(1)) {
    const line = raw.replace(/%%.*$/, "").trim();
    if (!line) continue;
    if (open) {
      if (line === "}") open = null;
      else addMember(open, line);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^class\s+([\w~]+)\s*(\{)?\s*(\})?$/.exec(line))) {
      const c = get(m[1]);
      if (m[2] && !m[3]) open = c;
    } else if ((m = /^<<(.+)>>\s+([\w~]+)$/.exec(line))) {
      get(m[2]).stereotypes.push(m[1]);
    } else if ((m = RELATION.exec(line))) {
      const [, from, fromLabel, left, body, right, toLabel, to, label] = m;
      get(from);
      get(to);
      // A dashed plain arrow is a dependency: UML draws it with an open head.
      const end = (e: string) => (e === "arrow" && body === ".." ? "open" : e);
      relations.push({
        from,
        to,
        fromEnd: end(left ? LEFT_END[left] : "none"),
        toEnd: end(right ? RIGHT_END[right] : "none"),
        dashed: body === "..",
        ...(fromLabel ? { fromLabel } : {}),
        ...(toLabel ? { toLabel } : {}),
        ...(label ? { label: label.trim() } : {}),
      });
    } else if ((m = /^([\w~]+)\s*:\s*(.+)$/.exec(line))) {
      addMember(get(m[1]), m[2]);
    }
  }
  return { classes: [...classes.values()], relations };
}

/** A class box's card text: «stereotypes», the bold name, then attributes and operations (empty compartments left out). */
export function classText(c: ClassInfo): string {
  const head = [...c.stereotypes.map((s) => `«${s}»`), `**${c.name.replace(/~([^~]*)~/g, "<$1>")}**`].join("\n");
  const parts = [head];
  if (c.attributes.length) parts.push(c.attributes.join("\n"));
  if (c.methods.length) parts.push(c.methods.join("\n"));
  return parts.join("\n---\n");
}

function classCanvas(src: string, host: HTMLElement, box: (el: Element) => { x: number; y: number; w: number; h: number }): CanvasDoc {
  const { classes, relations } = parseClassDiagram(src);
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const g of host.querySelectorAll("g.node")) {
    const m = /classId-(.+)-\d+$/.exec(g.id);
    if (m) placed.set(m[1], box(g));
  }
  const nodes: CanvasNode[] = [];
  const ids = new Map<string, string>();
  classes.forEach((c, i) => {
    const lines = c.stereotypes.length + 1 + c.attributes.length + c.methods.length;
    const width = Math.max(160, ...[c.name, ...c.attributes, ...c.methods].map((l) => Math.round(l.length * 8 + 40)));
    const height = 40 + lines * 20 + (c.attributes.length ? 10 : 0) + (c.methods.length ? 10 : 0);
    const b = placed.get(c.name) ?? { x: (i % 4) * 280, y: Math.floor(i / 4) * 240, w: width / SPREAD, h: height / SPREAD };
    const id = newId();
    ids.set(c.name, id);
    nodes.push({ id, type: "text", x: Math.round(b.x + (b.w * SPREAD) / 2 - width / 2), y: Math.round(b.y + (b.h * SPREAD) / 2 - height / 2), width, height, text: classText(c), shape: "class" });
  });
  const edges: CanvasEdge[] = relations.map((r) => {
    const e: CanvasEdge = { id: newId(), fromNode: ids.get(r.from)!, toNode: ids.get(r.to)!, toEnd: r.toEnd };
    if (r.fromEnd !== "none") e.fromEnd = r.fromEnd;
    if (r.dashed) e.line = "dashed";
    if (r.fromLabel) e.fromLabel = r.fromLabel;
    if (r.toLabel) e.toLabel = r.toLabel;
    if (r.label) e.label = r.label;
    return e;
  });
  return { nodes, edges };
}
