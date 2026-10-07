export const MIN_COLUMN_WIDTH = 64;
export const MAX_COLUMN_WIDTH = 1200;
export const columnWidth = (width: number) => Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)));
export const tableWidthKey = (root: string, path: string, ordinal: number) => `mosaic:table-widths:${JSON.stringify([root, path, ordinal])}`;

export function loadTableWidths(key: string, columns: number): number[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(value) && value.length === columns && value.every(w => typeof w === "number" && Number.isFinite(w))) return value.map(columnWidth);
  } catch { /* Invalid or unavailable storage uses natural widths. */ }
  return null;
}
export function saveTableWidths(key: string, widths: number[] | null) {
  try { if (widths) localStorage.setItem(key, JSON.stringify(widths.map(columnWidth))); else localStorage.removeItem(key); }
  catch { /* Resizing still works for this open editor. */ }
}
