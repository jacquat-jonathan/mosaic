// A canvas drawn as one standalone SVG: for diagrams embedded in notes and for SVG / PNG export.
// It draws the same shapes, connections and arrowheads as the editor, with labels as plain text
// (Markdown emphasis removed), so the file opens anywhere without fonts or scripts.

import { colorOf, type CanvasDoc, type CanvasEdge, type CanvasNode, type Side } from "../viewers/canvas/jsonCanvas";
import { CSS_SHAPES, OUTLINES, SOLID, dashArray, isEnd, isShape, LABELLESS, type EndName, type ShapeName } from "./shapes";
import { iconMarkup } from "./icons";
import { midpoint, roundedPath, routeAround } from "./route";
import { timingSvg } from "./timing";

/** A card's icon, centred near the top; returns the markup and how much height it takes. */
function iconSvg(n: CanvasNode, color: string): { svg: string; height: number } {
  const markup = n.icon ? iconMarkup(n.icon, color, 34) : null;
  if (!markup) return { svg: "", height: 0 };
  return { svg: markup.replace("<svg ", `<svg x="${n.x + n.width / 2 - 17}" y="${n.y + 10}" `), height: 48 };
}

interface Theme {
  bg: string;
  fg: string;
  muted: string;
  stroke: string;
  card: string;
}

const LIGHT: Theme = { bg: "#ffffff", fg: "#1f2328", muted: "#6b7080", stroke: "#8a8f9c", card: "#d0d4dc" };
const DARK: Theme = { bg: "#1e1f24", fg: "#e6e7ea", muted: "#9a9fad", stroke: "#8a8f9c", card: "#3a3d45" };

const FONT = 14;
const LINE = 19;
const PAD = 40;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markdown → plain lines: headings, emphasis, links and list markers removed. */
export function plainLines(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, "[diagram]")
    .split("\n")
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/!?\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, t: string, _a, alias?: string) => alias ?? t)
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<\/?(a|b|br|code|div|em|font|i|kbd|mark|p|s|small|span|strong|sub|sup|u)\b[^<>]*>/gi, "")
        .replace(/~~/g, "")
        .replace(/[*_`]/g, "")
        .trim(),
    );
}

/** Word-wraps to roughly `width` pixels (about 7.2 px per character at 14 px). */
function wrap(lines: string[], width: number): string[] {
  const max = Math.max(4, Math.floor(width / 7.2));
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= max) {
      out.push(line);
      continue;
    }
    let cur = "";
    for (const word of line.split(" ")) {
      if (cur && (cur + " " + word).length > max) {
        out.push(cur);
        cur = word;
      } else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function textBlock(lines: string[], x: number, y: number, w: number, h: number, t: Theme, centred: boolean, bold = false): string {
  const fit = Math.max(1, Math.floor((h - 8) / LINE));
  const shown = wrap(lines, w - 16).filter((l, i, all) => l !== "" || (i > 0 && i < all.length - 1)).slice(0, fit);
  const top = centred ? y + h / 2 - (shown.length * LINE) / 2 + LINE * 0.72 : y + 8 + LINE * 0.72;
  const anchor = centred ? `text-anchor="middle"` : "";
  const tx = centred ? x + w / 2 : x + 10;
  return shown
    .map((l, i) => `<text x="${tx}" y="${(top + i * LINE).toFixed(1)}" ${anchor} font-size="${FONT}" fill="${t.fg}"${bold && i === 0 ? ' font-weight="600"' : ""}>${esc(l)}</text>`)
    .join("");
}

function shapeSvg(n: CanvasNode, shape: ShapeName, t: Theme): string {
  const { x, y, width: w, height: h } = n;
  const color = colorOf(n.color);
  const stroke = n.border === "none" ? "transparent" : (color ?? t.stroke);
  const fill = color ? `${color}24` : t.bg;
  const dash = dashArray(n.border as string | undefined);
  const da = dash ? ` stroke-dasharray="${dash}"` : "";
  const sw = `stroke="${stroke}" stroke-width="2"${da}`;
  let body = "";
  const radius = CSS_SHAPES[shape];
  if (shape === "final") {
    const r = Math.min(w, h) / 2;
    body = `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${r - 1}" fill="${t.bg}" ${sw}/><circle cx="${x + w / 2}" cy="${y + h / 2}" r="${r * 0.58}" fill="${stroke}"/>`;
  } else if (shape === "actor") {
    const s = Math.min(w / 40, (h * 0.72) / 64);
    const ox = x + w / 2 - 20 * s;
    body = `<g transform="translate(${ox},${y}) scale(${s})" fill="none" stroke="${stroke}" stroke-width="${2.5 / s}" stroke-linecap="round"><circle cx="20" cy="10" r="8" fill="${fill}"/><path d="M20,18 L20,42 M6,28 L34,28 M20,42 L8,62 M20,42 L32,62"/></g>`;
  } else if (shape === "timing") {
    body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${sw}/>`;
  } else if (shape === "lifeline") {
    body = `<rect x="${x}" y="${y}" width="${w}" height="44" fill="${fill}" ${sw}/><line x1="${x + w / 2}" y1="${y + 44}" x2="${x + w / 2}" y2="${y + h}" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="6 5"/>`;
  } else if (radius !== undefined) {
    const solid = SOLID.has(shape);
    const f = solid ? stroke : shape === "frame" ? "none" : fill;
    if (radius === "50%") body = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${f}" ${sw}/>`;
    else {
      const r = radius === "9999px" ? h / 2 : parseFloat(radius) || 0;
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${f}" ${sw}/>`;
    }
  } else {
    const o = OUTLINES[shape];
    if (o) {
      const tr = `transform="translate(${x},${y}) scale(${w / 100},${h / 100})"`;
      body = `<g ${tr}><path d="${o.body}" fill="${fill}" ${sw} vector-effect="non-scaling-stroke"/>${o.extra ? `<path d="${o.extra}" fill="none" ${sw} vector-effect="non-scaling-stroke"/>` : ""}</g>`;
    }
  }
  if (LABELLESS.has(shape)) return body;
  const lines = plainLines(n.text ?? "");
  const icon = iconSvg(n, color ?? t.fg);
  if (icon.svg) return body + icon.svg + textBlock(lines, x, y + icon.height, w, h - icon.height, t, true);
  if (shape === "timing") return body + timingSvg(n.text ?? "", x, y, w, h, { stroke: color ?? t.fg, fg: t.fg, muted: t.muted, grid: t.card });
  if (shape === "class") {
    // Compartments: name (centred, bold), then members, divided by lines.
    const parts = (n.text ?? "").split(/^[ \t]*-{3,}[ \t]*$/m).map((p) => plainLines(p.trim()));
    let cy = y;
    const out: string[] = [body];
    parts.forEach((p, i) => {
      const ph = i === 0 ? Math.max(34, p.length * LINE + 12) : i === parts.length - 1 ? y + h - cy : Math.max(LINE + 10, p.length * LINE + 10);
      if (i > 0) out.push(`<line x1="${x}" y1="${cy}" x2="${x + w}" y2="${cy}" stroke="${stroke}" stroke-width="2"/>`);
      out.push(textBlock(p, x, cy, w, ph, t, i === 0, i === 0));
      cy += ph;
    });
    return out.join("");
  }
  if (shape === "frame") {
    const label = lines.filter(Boolean).join(" ");
    const tw = Math.min(w * 0.8, label.length * 7.4 + 28);
    return `${body}<path d="M${x},${y} H${x + tw} V${y + 16} L${x + tw - 10},${y + 26} H${x} Z" fill="${t.bg}" stroke="${stroke}" stroke-width="2"/><text x="${x + 8}" y="${y + 18}" font-size="13" font-weight="600" fill="${t.fg}">${esc(label)}</text>`;
  }
  if (shape === "lifeline") return body + textBlock(lines, x, y, w, 44, t, true);
  if (shape === "actor") return body + textBlock(lines, x, y + h * 0.72, w, h * 0.28, t, true);
  // Keep the label inside the narrower part of pointed shapes.
  const inset = shape === "diamond" ? 0.22 : shape === "hexagon" || shape === "parallelogram" ? 0.15 : 0;
  return body + textBlock(lines, x + w * inset, y, w * (1 - 2 * inset), h, t, true);
}

function cardSvg(n: CanvasNode, t: Theme): string {
  const { x, y, width: w, height: h } = n;
  const color = colorOf(n.color);
  const frame = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${color ? `${color}14` : t.bg}" stroke="${color ?? t.card}" stroke-width="2"/>`;
  if (n.type === "file") {
    const name = (n.file ?? "").split("/").pop()!.replace(/\.md$/, "");
    return frame + `<text x="${x + 10}" y="${y + 22}" font-size="13" font-weight="600" fill="${t.fg}">${esc(name)}</text><text x="${x + 10}" y="${y + 42}" font-size="12" fill="${t.muted}">${esc(n.file ?? "")}</text>`;
  }
  if (n.type === "link") return frame + textBlock([n.url ?? ""], x, y, w, h, { ...t, fg: t.muted }, true);
  const text = n.text ?? "";
  const heading = /^#{1,6}\s/.test(text.trim());
  const icon = iconSvg(n, color ?? t.fg);
  return frame + icon.svg + textBlock(plainLines(text), x, y + icon.height, w, h - icon.height, t, false, heading);
}

function groupSvg(n: CanvasNode, t: Theme): string {
  const color = colorOf(n.color);
  const stroke = color ?? t.stroke;
  return `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="12" fill="${color ? `${color}14` : "none"}" stroke="${stroke}" stroke-width="2" stroke-dasharray="6 4"/>${n.label ? `<text x="${n.x + 4}" y="${n.y - 8}" font-size="14" font-weight="600" fill="${stroke}">${esc(n.label)}</text>` : ""}`;
}

/** Where a connection attaches: a point on a side (lifelines: on their line), and the side's outward direction. */
function anchor(n: CanvasNode, side: Side, offset: number): { x: number; y: number; dx: number; dy: number } {
  const lifeline = n.shape === "lifeline";
  switch (side) {
    case "top":
      return { x: n.x + n.width * offset, y: n.y, dx: 0, dy: -1 };
    case "bottom":
      return { x: n.x + n.width * offset, y: n.y + n.height, dx: 0, dy: 1 };
    case "left":
      return { x: lifeline ? n.x + n.width / 2 : n.x, y: n.y + n.height * offset, dx: -1, dy: 0 };
    default:
      return { x: lifeline ? n.x + n.width / 2 : n.x + n.width, y: n.y + n.height * offset, dx: 1, dy: 0 };
  }
}

function bestSides(a: CanvasNode, b: CanvasNode): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ["right", "left"] : ["left", "right"];
  return dy > 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function markerDef(end: EndName, color: string, id: string, bg: string): string {
  const shapes: Record<string, string> = {
    arrow: `<path d="M2,3 L18,10 L2,17 Z" fill="${color}"/>`,
    triangle: `<path d="M2,3 L18,10 L2,17 Z" fill="${bg}" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`,
    open: `<path d="M3,3 L18,10 L3,17" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>`,
    diamond: `<path d="M1,10 L10,4 L19,10 L10,16 Z" fill="${color}"/>`,
    "diamond-open": `<path d="M1,10 L10,4 L19,10 L10,16 Z" fill="${bg}" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`,
    circle: `<circle cx="11" cy="10" r="6" fill="${bg}" stroke="${color}" stroke-width="1.6"/>`,
  };
  const refX = end === "diamond" || end === "diamond-open" ? 19 : end === "circle" ? 17 : 18;
  return `<marker id="${id}" viewBox="0 0 20 20" refX="${refX}" refY="10" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">${shapes[end] ?? ""}</marker>`;
}

function edgeSvg(e: CanvasEdge, byId: Map<string, CanvasNode>, t: Theme, markers: Map<string, string>, obstacles: CanvasNode[] = []): string {
  const a = byId.get(e.fromNode);
  const b = byId.get(e.toNode);
  if (!a || !b) return "";
  const [fs, ts] = bestSides(a, b);
  const p = anchor(a, (e.fromSide as Side) ?? fs, typeof e.fromOffset === "number" ? e.fromOffset : 0.5);
  const q = anchor(b, (e.toSide as Side) ?? ts, typeof e.toOffset === "number" ? e.toOffset : 0.5);
  const d = Math.max(24, Math.hypot(q.x - p.x, q.y - p.y) * 0.3);
  const c1 = { x: p.x + p.dx * d, y: p.y + p.dy * d };
  const c2 = { x: q.x + q.dx * d, y: q.y + q.dy * d };
  const color = colorOf(e.color) ?? t.stroke;
  const width = typeof e.thickness === "number" ? e.thickness : 2;
  const marker = (end: EndName) => {
    if (end === "none") return "";
    const id = `m-${end}-${color.replace(/[^a-z0-9]/gi, "")}`;
    markers.set(id, markerDef(end, color, id, t.bg));
    return `url(#${id})`;
  };
  const toEnd = isEnd(e.toEnd) ? e.toEnd : "arrow";
  const fromEnd = isEnd(e.fromEnd) ? e.fromEnd : "none";
  const ms = marker(fromEnd);
  const me = marker(toEnd);
  const dash = dashArray(e.line as string | undefined, width);
  // Curved (default), straight, or around the other cards.
  let pathD = `M${p.x},${p.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${q.x},${q.y}`;
  let mid = { x: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, y: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8 };
  if (e.route === "straight") {
    pathD = `M${p.x},${p.y} L${q.x},${q.y}`;
    mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  } else if (e.route === "orthogonal") {
    const pts = routeAround(p, { x: p.dx, y: p.dy }, q, { x: q.dx, y: q.dy }, obstacles);
    pathD = roundedPath(pts);
    mid = midpoint(pts);
  }
  let out = `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}${ms ? ` marker-start="${ms}"` : ""}${me ? ` marker-end="${me}"` : ""}/>`;
  const label = (text: string, x: number, y: number, size: number, fill: string) => {
    const w = text.length * size * 0.56 + 10;
    return `<rect x="${x - w / 2}" y="${y - size * 0.8}" width="${w}" height="${size * 1.5}" rx="4" fill="${t.bg}"/><text x="${x}" y="${y + size * 0.35}" text-anchor="middle" font-size="${size}" fill="${fill}">${esc(text)}</text>`;
  };
  if (e.label) out += label(e.label, mid.x, mid.y, 13, t.fg);
  const near = (pt: typeof p, beside: number) =>
    pt.dx !== 0 ? { x: pt.x + pt.dx * 20, y: pt.y + beside } : { x: pt.x + beside * 1.6, y: pt.y + pt.dy * 20 };
  if (typeof e.fromLabel === "string" && e.fromLabel) {
    const at = near(p, -12);
    out += label(e.fromLabel, at.x, at.y, 12, t.muted);
  }
  if (typeof e.toLabel === "string" && e.toLabel) {
    const at = near(q, 12);
    out += label(e.toLabel, at.x, at.y, 12, t.muted);
  }
  return out;
}

export function canvasToSvg(doc: CanvasDoc, dark = false): string {
  const t = dark ? DARK : LIGHT;
  const nodes = doc.nodes;
  if (!nodes.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60"><rect width="200" height="60" fill="${t.bg}"/><text x="100" y="35" text-anchor="middle" font-size="13" fill="${t.muted}" font-family="-apple-system, system-ui, sans-serif">Empty diagram</text></svg>`;
  }
  const minX = Math.min(...nodes.map((n) => n.x)) - PAD;
  const minY = Math.min(...nodes.map((n) => n.y)) - PAD;
  const maxX = Math.max(...nodes.map((n) => n.x + n.width)) + PAD;
  const maxY = Math.max(...nodes.map((n) => n.y + n.height)) + PAD;
  const w = maxX - minX;
  const h = maxY - minY;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const behind = (n: CanvasNode) => n.type === "group" || n.shape === "frame";
  const markers = new Map<string, string>();
  const parts = [
    ...nodes.filter(behind).map((n) => (n.type === "group" ? groupSvg(n, t) : shapeSvg(n, "frame", t))),
    ...doc.edges.map((e) => edgeSvg(e, byId, t, markers, nodes.filter((n) => !behind(n)))),
    ...nodes.filter((n) => !behind(n)).map((n) => (n.type === "text" && isShape(n.shape) ? shapeSvg(n, n.shape, t) : cardSvg(n, t))),
  ];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">`,
    `<defs>${[...markers.values()].join("")}</defs>`,
    `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="${t.bg}"/>`,
    ...parts,
    "</svg>",
  ].join("");
}
