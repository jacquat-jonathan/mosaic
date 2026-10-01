// Auto-layout for a selection of cards (dagre, bundled, offline): ranks follow the connections,
// top-down or left-right, and the laid-out cards keep their current top-left corner.

import { Graph, layout } from "@dagrejs/dagre";

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function autoLayout(boxes: LayoutBox[], links: { from: string; to: string }[], direction: "TB" | "LR"): Map<string, { x: number; y: number }> {
  const g = new Graph();
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 90, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(boxes.map((b) => b.id));
  for (const b of boxes) g.setNode(b.id, { width: b.width, height: b.height });
  for (const l of links) if (ids.has(l.from) && ids.has(l.to) && l.from !== l.to) g.setEdge(l.from, l.to);
  layout(g);
  const originX = Math.min(...boxes.map((b) => b.x));
  const originY = Math.min(...boxes.map((b) => b.y));
  // dagre gives centres; turn them into top-left corners, then move the whole result to the origin.
  const placed = boxes.map((b) => {
    const n = g.node(b.id);
    return { id: b.id, x: n.x - b.width / 2, y: n.y - b.height / 2 };
  });
  const minX = Math.min(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  return new Map(placed.map((p) => [p.id, { x: Math.round(p.x - minX + originX), y: Math.round(p.y - minY + originY) }]));
}
