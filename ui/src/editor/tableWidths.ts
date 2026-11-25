// Table column widths live in the note, as a comment on the line directly above the table:
//
//   <!-- widths 20 30 30 20 -->
//   | Date | Time | Issues | Comments |
//
// Each number is a whole percentage of the table, which always spans the editor's width, so tables
// reflow with the window and can never be wider than the page. Other Markdown renderers hide the
// comment. A comment whose count doesn't match the table (an agent added a column) is ignored, and
// the table falls back to automatic widths; nothing rewrites it until the user resizes again.

/** Narrowest a column may be dragged, in pixels. */
export const MIN_COLUMN_PX = 48;

export const WIDTHS_RE = /^<!--\s*widths((?:\s+\d+(?:\.\d+)?)+)\s*-->\s*$/;

/** The percentages in a widths comment line, or null when the line isn't one. */
export function parseWidths(line: string): number[] | null {
  const m = WIDTHS_RE.exec(line.trim());
  if (!m) return null;
  const values = m[1].trim().split(/\s+/).map(Number);
  return values.every((v) => Number.isFinite(v) && v > 0) ? values : null;
}

/** Widths that fit a table of `columns` columns, scaled to 100%, or null when they don't match. */
export function usableWidths(widths: number[] | null, columns: number): number[] | null {
  if (!widths || widths.length !== columns) return null;
  const total = widths.reduce((a, b) => a + b, 0);
  return total > 0 ? widths.map((w) => (w / total) * 100) : null;
}

/** Whole percentages that add up to exactly 100 (largest remainders get the leftover points). */
export function roundWidths(widths: number[]): number[] {
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const exact = widths.map((w) => (w / total) * 100);
  const out = exact.map((w) => Math.max(1, Math.floor(w)));
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((w, i) => [w - Math.floor(w), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  for (let i = out.length - 1; left < 0 && i >= 0; i--)
    while (left < 0 && out[i] > 1) {
      out[i]--;
      left++;
    }
  return out;
}

export const widthsComment = (widths: number[]) => `<!-- widths ${roundWidths(widths).join(" ")} -->`;

/**
 * Drags the border on the right of `column` by `delta` percent: the column and its right-hand
 * neighbour trade width, so the table stays 100% wide. Neither goes below `min` percent.
 */
export function resizeBorder(widths: readonly number[], column: number, delta: number, min: number): number[] {
  const next = [...widths];
  if (column < 0 || column >= next.length - 1 || !Number.isFinite(delta)) return next;
  const pair = next[column] + next[column + 1];
  const floor = Math.min(min, pair / 2);
  const left = Math.min(pair - floor, Math.max(floor, next[column] + delta));
  next[column] = left;
  next[column + 1] = pair - left;
  return next;
}

/** A new column at `at` gets an even share; the others shrink in proportion. */
export function insertWidth(widths: readonly number[], at: number): number[] {
  const share = 100 / (widths.length + 1);
  const next = widths.map((w) => (w * (100 - share)) / 100);
  next.splice(Math.max(0, Math.min(at, next.length)), 0, share);
  return next;
}

/** Removing a column gives its width to the others in proportion. */
export function deleteWidth(widths: readonly number[], at: number): number[] {
  const next = widths.filter((_, i) => i !== at);
  return usableWidths(next, next.length) ?? next;
}

/** Moves a column's width along with the column (`to` is an insertion boundary, as in moveColumn). */
export function moveWidth(widths: readonly number[], from: number, to: number): number[] {
  const next = [...widths];
  const [w] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, w);
  return next;
}
