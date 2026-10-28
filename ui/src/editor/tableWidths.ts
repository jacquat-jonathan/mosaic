export const MIN_COLUMN_WIDTH = 64;
export const tableWidthKey = (root: string, path: string, ordinal: number) =>
  `mosaic:table-widths:${JSON.stringify([root, path, ordinal])}`;

/** Resize one column independently. Overflow belongs to the table's horizontal scroller. */
export function resizeTableColumn(widths: readonly number[], column: number, delta: number): number[] {
  const next = [...widths];
  if (column < 0 || column >= next.length || !Number.isFinite(delta)) return next;
  next[column] = Math.max(MIN_COLUMN_WIDTH, next[column] + delta);
  return next;
}

export function loadTableWidths(key: string, columns: number): number[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      Array.isArray(value) &&
      value.length === columns &&
      value.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)
    )
      return value;
  } catch {
    /* Invalid or unavailable storage uses natural widths. */
  }
  return null;
}
export function saveTableWidths(key: string, widths: number[] | null) {
  try {
    if (widths) localStorage.setItem(key, JSON.stringify(widths));
    else localStorage.removeItem(key);
  } catch {
    /* Resizing still works for this open editor. */
  }
}
