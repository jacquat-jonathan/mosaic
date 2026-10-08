export const MIN_COLUMN_WIDTH = 64;
export const MAX_COLUMN_WIDTH = 1200;
export const tableWidthKey = (root: string, path: string, ordinal: number) => `mosaic:table-widths:${JSON.stringify([root, path, ordinal])}`;

/** Move an internal boundary, preserving the pair's total and all other columns. */
export function resizeTableBoundary(widths: readonly number[], column: number, delta: number): number[] {
  const next = [...widths];
  if (column < 0 || column >= widths.length - 1 || !Number.isFinite(delta)) return next;
  const left = widths[column], right = widths[column + 1];
  // Natural widths may already fall outside the preferred limits. Capturing them must not
  // change the table's size; allow movement towards the limits without forcing a jump.
  const minimum = Math.max(Math.min(MIN_COLUMN_WIDTH, left) - left, right - Math.max(MAX_COLUMN_WIDTH, right));
  const maximum = Math.min(Math.max(MAX_COLUMN_WIDTH, left) - left, right - Math.min(MIN_COLUMN_WIDTH, right));
  const change = Math.max(minimum, Math.min(maximum, delta));
  next[column] = left + change;
  next[column + 1] = right - change;
  return next;
}

export function loadTableWidths(key: string, columns: number): number[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(value) && value.length === columns && value.every(w => typeof w === "number" && Number.isFinite(w) && w > 0)) return value;
  } catch { /* Invalid or unavailable storage uses natural widths. */ }
  return null;
}
export function saveTableWidths(key: string, widths: number[] | null) {
  try { if (widths) localStorage.setItem(key, JSON.stringify(widths)); else localStorage.removeItem(key); }
  catch { /* Resizing still works for this open editor. */ }
}
