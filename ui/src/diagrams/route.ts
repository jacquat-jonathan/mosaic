// Routes a connection around other cards: an orthogonal path found by A* on a coarse grid, preferring
// few turns. Mirrored in crates/mosaic-core/src/route.rs for the static renderer.

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const STEP = 10;
/** Room kept around cards. */
const MARGIN = 12;
/** How far a path leaves a card straight out before turning. */
const STUB = 18;
const TURN_COST = 6;
const MAX_VISITS = 40000;

/**
 * Points of an orthogonal path from `a` (leaving in direction `da`) to `b` (arriving from `db`) that
 * avoids `obstacles`. Falls back to a simple elbow when no path is found quickly.
 */
export function routeAround(a: Pt, da: Pt, b: Pt, db: Pt, obstacles: Box[]): Pt[] {
  const s = { x: a.x + da.x * STUB, y: a.y + da.y * STUB };
  const e = { x: b.x + db.x * STUB, y: b.y + db.y * STUB };
  const blocked = obstacles.map((o) => ({ x0: o.x - MARGIN, y0: o.y - MARGIN, x1: o.x + o.width + MARGIN, y1: o.y + o.height + MARGIN }));
  const xs = [s.x, e.x, ...blocked.flatMap((o) => [o.x0, o.x1])];
  const ys = [s.y, e.y, ...blocked.flatMap((o) => [o.y0, o.y1])];
  const minX = Math.min(...xs) - 60;
  const minY = Math.min(...ys) - 60;
  const cols = Math.ceil((Math.max(...xs) + 60 - minX) / STEP) + 1;
  const rows = Math.ceil((Math.max(...ys) + 60 - minY) / STEP) + 1;
  const cell = (p: Pt) => ({ c: Math.round((p.x - minX) / STEP), r: Math.round((p.y - minY) / STEP) });
  const free = (c: number, r: number) => {
    const x = minX + c * STEP;
    const y = minY + r * STEP;
    return c >= 0 && r >= 0 && c < cols && r < rows && !blocked.some((o) => x > o.x0 && x < o.x1 && y > o.y0 && y < o.y1);
  };
  const start = cell(s);
  const goal = cell(e);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  // State: cell and the direction we arrived in (turns cost extra).
  const key = (c: number, r: number, d: number) => (r * cols + c) * 4 + d;
  const best = new Map<number, number>();
  const prev = new Map<number, number>();
  const open: { k: number; c: number; r: number; d: number; g: number; f: number }[] = [];
  const h = (c: number, r: number) => Math.abs(c - goal.c) + Math.abs(r - goal.r);
  const startDir = dirs.findIndex(([dx, dy]) => dx === Math.sign(da.x) && dy === Math.sign(da.y));
  const sd = startDir < 0 ? 0 : startDir;
  const sk = key(start.c, start.r, sd);
  best.set(sk, 0);
  open.push({ k: sk, c: start.c, r: start.r, d: sd, g: 0, f: h(start.c, start.r) });
  let found: number | null = null;
  let visits = 0;
  while (open.length && visits++ < MAX_VISITS) {
    // Small open sets: a linear minimum is fast enough and keeps this dependency-free.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.c === goal.c && cur.r === goal.r) {
      found = cur.k;
      break;
    }
    if (cur.g > (best.get(cur.k) ?? Infinity)) continue;
    dirs.forEach(([dx, dy], d) => {
      const c = cur.c + dx;
      const r = cur.r + dy;
      if (!free(c, r) && !(c === goal.c && r === goal.r)) return;
      const g = cur.g + 1 + (d === cur.d ? 0 : TURN_COST);
      const k = key(c, r, d);
      if (g < (best.get(k) ?? Infinity)) {
        best.set(k, g);
        prev.set(k, cur.k);
        open.push({ k, c, r, d, g, f: g + h(c, r) });
      }
    });
  }
  if (found === null) return simplify([a, s, { x: e.x, y: s.y }, e, b]);
  const cells: Pt[] = [];
  for (let k: number | undefined = found; k !== undefined; k = prev.get(k)) {
    const idx = Math.floor(k / 4);
    cells.push({ x: minX + (idx % cols) * STEP, y: minY + Math.floor(idx / cols) * STEP });
  }
  cells.reverse();
  // Move the first and last straight runs onto the exact stub points (off the grid), so the path
  // meets the cards squarely without a small jog.
  snapRun(cells, 0, 1, s);
  snapRun(cells, cells.length - 1, -1, e);
  return simplify([a, ...squareUp(cells), b]);
}

function snapRun(cells: Pt[], from: number, step: 1 | -1, p: Pt) {
  const g = cells[from];
  const next = cells[from + step];
  if (next) {
    const horizontal = next.y === g.y;
    for (let i = from; i >= 0 && i < cells.length; i += step) {
      if (horizontal ? cells[i].y !== g.y : cells[i].x !== g.x) break;
      cells[i] = horizontal ? { x: cells[i].x, y: p.y } : { x: p.x, y: cells[i].y };
    }
  }
  cells[from] = p;
}

/** Grid snapping can leave a slightly diagonal first or last segment: make it orthogonal. */
function squareUp(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = out[out.length - 1];
    const q = pts[i];
    if (p.x !== q.x && p.y !== q.y) out.push({ x: q.x, y: p.y });
    out.push(q);
  }
  return out;
}

/** Drops repeated points and points in the middle of a straight run. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** An SVG path through `pts` with rounded corners. */
export function roundedPath(pts: Pt[], radius = 8): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p, c, n] = [pts[i - 1], pts[i], pts[i + 1]];
    const r = Math.min(radius, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2);
    const inX = c.x - Math.sign(c.x - p.x) * r;
    const inY = c.y - Math.sign(c.y - p.y) * r;
    const outX = c.x + Math.sign(n.x - c.x) * r;
    const outY = c.y + Math.sign(n.y - c.y) * r;
    d += ` L${inX},${inY} Q${c.x},${c.y} ${outX},${outY}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/** The point halfway along a polyline (where its label goes). */
export function midpoint(pts: Pt[]): Pt {
  const lengths = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  let left = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]) {
      const t = lengths[i] ? left / lengths[i] : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    left -= lengths[i];
  }
  return pts[pts.length - 1];
}
