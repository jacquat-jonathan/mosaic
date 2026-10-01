// Canvas → Mermaid flowchart, to paste a diagram into a note as a text-first ```mermaid block.
// Shapes and connection styles Mermaid can't draw fall back to its nearest equivalent.

import type { CanvasDoc, CanvasNode } from "../viewers/canvas/jsonCanvas";

/** Mermaid node syntax for each shape: [open, close] around the label, or a Mermaid 11+ `@{ shape }`. */
const BRACKETS: Record<string, [string, string] | { shape: string }> = {
  rectangle: ["[", "]"],
  rounded: ["(", ")"],
  pill: ["([", "])"],
  ellipse: ["((", "))"],
  diamond: ["{", "}"],
  hexagon: ["{{", "}}"],
  parallelogram: ["[/", "/]"],
  cylinder: ["[(", ")]"],
  process: ["[[", "]]"],
  document: { shape: "doc" },
  cloud: { shape: "cloud" },
  note: { shape: "notch-rect" },
  initial: { shape: "sm-circ" },
  final: { shape: "fr-circ" },
  bar: { shape: "fork" },
};

/** Plain one-line label: Markdown emphasis removed, line breaks kept as <br>, quotes escaped. */
function label(text: string): string {
  return text
    .split(/^[ \t]*-{3,}[ \t]*$/m)[0]
    .replace(/[*_`]/g, "")
    .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, target: string, _a, alias?: string) => alias ?? target)
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("<br>")
    .replace(/"/g, "#quot;");
}

function nodeLine(id: string, n: CanvasNode): string {
  const text = label(n.text ?? n.file ?? n.url ?? "");
  const b = BRACKETS[n.shape ?? ""] ?? BRACKETS.rounded;
  if (!Array.isArray(b)) return text ? `${id}@{ shape: ${b.shape}, label: "${text}" }` : `${id}@{ shape: ${b.shape} }`;
  return `${id}${b[0]}"${text || " "}"${b[1]}`;
}

const inside = (n: CanvasNode, g: CanvasNode) => n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;

export function canvasToMermaid(doc: CanvasDoc): string {
  const groups = doc.nodes.filter((n) => n.type === "group");
  const cards = doc.nodes.filter((n) => n.type !== "group");
  const ids = new Map(cards.map((n, i) => [n.id, `n${i + 1}`]));
  const xs = cards.flatMap((n) => [n.x, n.x + n.width]);
  const ys = cards.flatMap((n) => [n.y, n.y + n.height]);
  const wide = Math.max(...xs) - Math.min(...xs) > Math.max(...ys) - Math.min(...ys);
  const lines = [`flowchart ${wide ? "LR" : "TD"}`];
  const placed = new Set<string>();
  // Each card goes in the smallest group that contains it.
  const bySize = [...groups].sort((a, b) => a.width * a.height - b.width * b.height);
  const home = new Map(cards.map((c) => [c.id, bySize.find((g) => inside(c, g))?.id]));
  groups.forEach((g, i) => {
    const members = cards.filter((c) => home.get(c.id) === g.id);
    if (!members.length) return;
    lines.push(`  subgraph g${i + 1} ["${label(g.label ?? "")}"]`);
    for (const c of members) {
      lines.push(`    ${nodeLine(ids.get(c.id)!, c)}`);
      placed.add(c.id);
    }
    lines.push("  end");
  });
  for (const c of cards) if (!placed.has(c.id)) lines.push(`  ${nodeLine(ids.get(c.id)!, c)}`);
  for (const e of doc.edges) {
    let a = ids.get(e.fromNode);
    let b = ids.get(e.toNode);
    if (!a || !b) continue;
    let to = e.toEnd ?? "arrow";
    let from = e.fromEnd ?? "none";
    // Mermaid draws heads at the end; an arrow only at the start is the same link the other way.
    if (to === "none" && from !== "none") [a, b, to, from] = [b, a, from, to];
    const thick = typeof e.thickness === "number" && e.thickness >= 4;
    const dashed = e.line === "dashed" || e.line === "dotted";
    const head = to === "none" ? "" : to === "circle" ? "o" : ">";
    const tail = from === "none" ? "" : from === "circle" ? "o" : "<";
    // Mermaid has no thick dashed line: dashed wins.
    const body = dashed ? "-.-" : thick ? (head ? "==" : "===") : head ? "--" : "---";
    lines.push(`  ${a} ${tail}${body}${head}${e.label ? `|"${label(e.label)}"|` : ""} ${b}`);
  }
  return lines.join("\n") + "\n";
}
