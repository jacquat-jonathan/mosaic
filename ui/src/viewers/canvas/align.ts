// Alignment guides while dragging a card: its left / centre / right (and top / middle / bottom) snap
// to the same lines of other cards when they're within a few pixels, and the line is shown.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Aligned {
  x: number;
  y: number;
  /** Guide lines to draw, in canvas coordinates. */
  guideX?: number;
  guideY?: number;
}

const lines = (start: number, size: number) => [start, start + size / 2, start + size];

/** The closest line within `snap` pixels: how far to move, and where the guide is. */
function nearest(mine: number[], theirs: number[], snap: number): { shift: number; at: number } | null {
  let best: { shift: number; at: number } | null = null;
  for (const a of mine)
    for (const b of theirs) {
      const shift = b - a;
      if (Math.abs(shift) <= snap && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, at: b };
    }
  return best;
}

export function align(moving: Box, others: Box[], snap = 6): Aligned {
  const xs = others.flatMap((o) => lines(o.x, o.width));
  const ys = others.flatMap((o) => lines(o.y, o.height));
  const dx = nearest(lines(moving.x, moving.width), xs, snap);
  const dy = nearest(lines(moving.y, moving.height), ys, snap);
  return { x: moving.x + (dx?.shift ?? 0), y: moving.y + (dy?.shift ?? 0), guideX: dx?.at, guideY: dy?.at };
}
