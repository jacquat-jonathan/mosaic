// Canvas → Mermaid, to paste a diagram into a note as a text-first ```mermaid block: a sequence diagram
// when the canvas has lifelines, a class diagram when it has class boxes, otherwise a flowchart.
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
  if (doc.nodes.some((n) => n.shape === "lifeline")) return sequenceToMermaid(doc);
  if (doc.nodes.some((n) => n.shape === "class")) return classToMermaid(doc);
  return flowchartToMermaid(doc);
}

function flowchartToMermaid(doc: CanvasDoc): string {
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

const oneLine = (text: string) => label(text).replace(/<br>/g, " ");

/** Lifelines are participants (left to right); messages are ordered by height; alt / loop / opt… frames wrap the messages inside them. */
function sequenceToMermaid(doc: CanvasDoc): string {
  const lifelines = doc.nodes.filter((n) => n.shape === "lifeline").sort((a, b) => a.x - b.x);
  const ids = new Map(lifelines.map((n, i) => [n.id, `p${i + 1}`]));
  // Messages may attach to an activation bar: it belongs to the lifeline it sits on.
  for (const a of doc.nodes.filter((n) => n.shape === "activation")) {
    const cx = a.x + a.width / 2;
    const owner = lifelines.find((l) => cx >= l.x && cx <= l.x + l.width);
    if (owner) ids.set(a.id, ids.get(owner.id)!);
  }
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const lines = ["sequenceDiagram"];
  for (const l of lifelines) lines.push(`  participant ${ids.get(l.id)} as ${oneLine(l.text ?? "") || ids.get(l.id)}`);
  type Event = { y: number; order: number; line: string; indent: number };
  const events: Event[] = [];
  for (const e of doc.edges) {
    const from = ids.get(e.fromNode);
    const to = ids.get(e.toNode);
    const node = byId.get(e.fromNode);
    if (!from || !to || !node) continue;
    const y = node.y + node.height * (typeof e.fromOffset === "number" ? e.fromOffset : 0.5);
    // Mermaid draws the head at the end: an arrow only at the start is the same message the other way.
    let head = e.toEnd ?? "arrow";
    const tail = e.fromEnd ?? "none";
    const swap = head === "none" && tail !== "none";
    if (swap) head = tail;
    const [a, b] = swap ? [to, from] : [from, to];
    const dashed = e.line === "dashed" || e.line === "dotted";
    const arrow = head === "none" ? (dashed ? "-->" : "->") : head === "open" && !dashed ? "-)" : dashed ? "-->>" : "->>";
    events.push({ y, order: 1, line: `${a}${arrow}${b}: ${oneLine(e.label ?? "")}`, indent: 0 });
  }
  const KEYWORDS = new Set(["alt", "opt", "loop", "par", "critical", "break", "rect"]);
  for (const f of doc.nodes.filter((n) => n.shape === "frame")) {
    const [keyword, ...rest] = oneLine(f.text ?? "").split(" ");
    if (!KEYWORDS.has(keyword.toLowerCase())) continue;
    const top = f.y;
    const bottom = f.y + f.height;
    if (!events.some((ev) => ev.order === 1 && ev.y >= top && ev.y <= bottom)) continue;
    const cond = rest.join(" ").replace(/^\[(.*)\]$/, "$1");
    // Opens sort before messages at the same height (bigger frames first), closes after.
    events.push({ y: top, order: 0 - f.height / 1e6, line: `${keyword.toLowerCase()} ${cond}`.trimEnd(), indent: 1 });
    events.push({ y: bottom, order: 2 + f.height / 1e6, line: "end", indent: -1 });
  }
  events.sort((a, b) => a.y - b.y || a.order - b.order);
  let depth = 1;
  for (const ev of events) {
    if (ev.indent < 0) depth--;
    lines.push(`${"  ".repeat(depth)}${ev.line}`);
    if (ev.indent > 0) depth++;
  }
  return lines.join("\n") + "\n";
}

/** A class member as Mermaid writes it: `+ total(): Money` → `+total() Money`. */
function member(line: string): string {
  return line
    .replace(/\*\*|`/g, "")
    .replace(/^\s*([-+#~])\s+/, "$1")
    .replace(/\)\s*:\s*(.+)$/, ") $1")
    .trim();
}

const END_LEFT: Record<string, string> = { triangle: "<|", diamond: "*", "diamond-open": "o", arrow: "<", open: "<" };
const END_RIGHT: Record<string, string> = { triangle: "|>", diamond: "*", "diamond-open": "o", arrow: ">", open: ">" };

/** Class boxes with their compartments; connections become relations (arrowheads → inheritance, composition…). */
function classToMermaid(doc: CanvasDoc): string {
  const classes = doc.nodes.filter((n) => n.shape === "class");
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const lines = ["classDiagram"];
  for (const c of classes) {
    const [head = "", ...parts] = (c.text ?? "").split(/^[ \t]*-{3,}[ \t]*$/m);
    const headLines = head.split("\n").map((l) => l.trim()).filter(Boolean);
    const stereotypes = headLines.filter((l) => /^(«.*»|<<.*>>)$/.test(l)).map((l) => l.replace(/^(«|<<)|(»|>>)$/g, ""));
    const name = headLines.filter((l) => !/^(«.*»|<<.*>>)$/.test(l)).map((l) => l.replace(/[*_`]/g, "")).join(" ") || "Class";
    let id = name.replace(/<([^>]*)>/g, "~$1~").replace(/[^\w~]/g, "_");
    for (let k = 2; used.has(id); k++) id = `${id}${k}`;
    used.add(id);
    ids.set(c.id, id);
    const members = parts.flatMap((p) => p.split("\n").map(member).filter(Boolean));
    if (!members.length && !stereotypes.length) {
      lines.push(`  class ${id}`);
      continue;
    }
    lines.push(`  class ${id} {`);
    for (const s of stereotypes) lines.push(`    <<${s}>>`);
    for (const m of members) lines.push(`    ${m}`);
    lines.push("  }");
  }
  for (const e of doc.edges) {
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) continue;
    const fromEnd = e.fromEnd ?? "none";
    const toEnd = e.toEnd ?? "arrow";
    const line = e.line === "dashed" || e.line === "dotted" ? ".." : "--";
    const card = (l: string | undefined) => (l ? ` "${l.replace(/"/g, "'")}"` : "");
    const text = e.label ? ` : ${oneLine(e.label)}` : "";
    lines.push(`  ${ids.get(e.fromNode)}${card(e.fromLabel)} ${END_LEFT[fromEnd] ?? ""}${line}${END_RIGHT[toEnd] ?? ""}${card(e.toLabel)} ${ids.get(e.toNode)}${text}`);
  }
  return lines.join("\n") + "\n";
}
