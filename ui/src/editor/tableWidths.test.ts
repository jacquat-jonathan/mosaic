import { afterEach, expect, test, vi } from "vitest";
import { columnWidth, loadTableWidths, saveTableWidths, tableWidthKey } from "./tableWidths";
afterEach(() => vi.unstubAllGlobals());
test("widths persist by vault, note and table, with invalid storage rejected", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
  const key = tableWidthKey("/vault", "Note.md", 0);
  saveTableWidths(key, [10, 250.6, 5000]);
  expect(loadTableWidths(key, 3)).toEqual([64, 251, 1200]);
  expect(loadTableWidths(key, 2)).toBeNull();
  expect(loadTableWidths(tableWidthKey("/other", "Note.md", 0), 3)).toBeNull();
  expect(loadTableWidths(tableWidthKey("/vault", "Note.md", 1), 3)).toBeNull();
  values.set(key, '["bad",200,300]'); expect(loadTableWidths(key, 3)).toBeNull();
  values.set(key, 'oops'); expect(loadTableWidths(key, 3)).toBeNull();
  saveTableWidths(key, null); expect(values.has(key)).toBe(false);
  expect(columnWidth(143.4)).toBe(143);
});
test("unavailable storage leaves resizing usable", () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("Blocked"); }, setItem() { throw new Error("Full"); } });
  expect(loadTableWidths("key", 2)).toBeNull();
  expect(() => saveTableWidths("key", [100, 200])).not.toThrow();
});
