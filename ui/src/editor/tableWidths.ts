export const MIN_COLUMN_WIDTH = 64;
export const MAX_COLUMN_WIDTH = 1200;
export const tableWidthKey = (root: string, path: string, ordinal: number) => `mosaic:table-widths:${JSON.stringify([root, path, ordinal])}`;

/** Shrink columns proportionally until the table fits its viewport. Small viewports may go below
 *  the preferred column minimum so the table itself never makes the note wider than its pane. */
export function fitTableWidths(widths: readonly number[], available: number): number[] {
  const next = [...widths];
  if (!next.length || !Number.isFinite(available) || available <= 0) return next;
  const total = next.reduce((sum, width) => sum + width, 0);
  if (total <= available) return next;
  const floor = Math.min(MIN_COLUMN_WIDTH, available / next.length);
  const shrinkable = next.reduce((sum, width) => sum + Math.max(0, width - floor), 0);
  if (shrinkable <= 0) return next.map(() => available / next.length);
  const excess = total - available;
  return next.map((width) => width - excess * (Math.max(0, width - floor) / shrinkable));
}

/** Resize one column without making its neighbours jump. Growth stops at the pane edge. */
export function resizeTableColumn(widths: readonly number[], column: number, delta: number, available: number): number[] {
  const next = fitTableWidths(widths, available);
  if (column < 0 || column >= next.length || !Number.isFinite(delta)) return next;
  const total = next.reduce((sum, width) => sum + width, 0);
  // Old or very narrow layouts may already be outside the preferred bounds. Keep them stable and
  // allow a drag back towards the bounds instead of forcing a jump on the first interaction.
  const minimum = Math.min(next[column], MIN_COLUMN_WIDTH, available / next.length);
  const maximum = Math.max(next[column], Math.min(MAX_COLUMN_WIDTH, next[column] + Math.max(0, available - total)));
  next[column] = Math.max(minimum, Math.min(maximum, next[column] + delta));
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
