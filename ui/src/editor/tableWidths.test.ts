import { afterEach, expect, test, vi } from "vitest";
import { resizeTableBoundary, loadTableWidths, saveTableWidths, tableWidthKey } from "./tableWidths";
afterEach(() => vi.unstubAllGlobals());
test("widths persist by vault, note and table, with invalid storage rejected", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
  const key = tableWidthKey("/vault", "Note.md", 0);
  saveTableWidths(key, [60.25, 250.6, 1500]);
  expect(loadTableWidths(key, 3)).toEqual([60.25, 250.6, 1500]);
  expect(loadTableWidths(key, 2)).toBeNull();
  expect(loadTableWidths(tableWidthKey("/other", "Note.md", 0), 3)).toBeNull();
  expect(loadTableWidths(tableWidthKey("/vault", "Note.md", 1), 3)).toBeNull();
  values.set(key, '["bad",200,300]'); expect(loadTableWidths(key, 3)).toBeNull();
  values.set(key, '[0,200,300]'); expect(loadTableWidths(key, 3)).toBeNull();
  values.set(key, '[-10,200,300]'); expect(loadTableWidths(key, 3)).toBeNull();
  values.set(key, 'oops'); expect(loadTableWidths(key, 3)).toBeNull();
  saveTableWidths(key, null); expect(values.has(key)).toBe(false);
});

test("resizing redistributes adjacent widths while preserving the table and other columns", () => {
  const widths = [180.25, 240.5, 100.75];
  const resized = resizeTableBoundary(widths, 0, 35.5);
  expect(resized).toEqual([215.75, 205, 100.75]);
  expect(resized.reduce((a, b) => a + b, 0)).toBe(521.5);
  expect(widths).toEqual([180.25, 240.5, 100.75]);
  expect(resizeTableBoundary(resized, 0, -35.5)).toEqual(widths);
  expect(resizeTableBoundary(widths, 1, -10)).toEqual([180.25, 230.5, 110.75]);
});

test("boundaries stop when either neighbor reaches its minimum or maximum", () => {
  expect(resizeTableBoundary([100, 100], 0, 1000)).toEqual([136, 64]);
  expect(resizeTableBoundary([100, 100], 0, -1000)).toEqual([64, 136]);
  expect(resizeTableBoundary([1190, 200], 0, 40)).toEqual([1200, 190]);
  expect(resizeTableBoundary([200, 1190], 0, -40)).toEqual([190, 1200]);
});

test("natural widths are captured without jumps, including columns outside preferred limits", () => {
  expect(resizeTableBoundary([50.5, 1500.25], 0, 0)).toEqual([50.5, 1500.25]);
  expect(resizeTableBoundary([50.5, 1500.25], 0, -10)).toEqual([50.5, 1500.25]);
  expect(resizeTableBoundary([50.5, 1500.25], 0, 10)).toEqual([60.5, 1490.25]);
});

test("there is no resize boundary at the table's outer edge or in a single-column table", () => {
  expect(resizeTableBoundary([200], 0, 40)).toEqual([200]);
  expect(resizeTableBoundary([100, 200], 1, 40)).toEqual([100, 200]);
  expect(resizeTableBoundary([100, 200], -1, 40)).toEqual([100, 200]);
  expect(resizeTableBoundary([100, 200], 0, NaN)).toEqual([100, 200]);
});
test("unavailable storage leaves resizing usable", () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("Blocked"); }, setItem() { throw new Error("Full"); } });
  expect(loadTableWidths("key", 2)).toBeNull();
  expect(() => saveTableWidths("key", [100, 200])).not.toThrow();
});
