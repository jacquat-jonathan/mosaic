import { afterEach, expect, test, vi } from "vitest";
import { fitTableWidths, resizeTableColumn, loadTableWidths, saveTableWidths, tableWidthKey } from "./tableWidths";
afterEach(() => vi.unstubAllGlobals());
test("widths persist by vault, note and table, with invalid storage rejected", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
  const key = tableWidthKey("/vault", "Note.md", 0);
  saveTableWidths(key, [60.25, 250.6, 1500]);
  expect(loadTableWidths(key, 3)).toEqual([60.25, 250.6, 1500]);
  expect(loadTableWidths(key, 2)).toBeNull();
  expect(loadTableWidths(tableWidthKey("/other", "Note.md", 0), 3)).toBeNull();
  expect(loadTableWidths(tableWidthKey("/vault", "Note.md", 1), 3)).toBeNull();
  values.set(key, '["bad",200,300]');
  expect(loadTableWidths(key, 3)).toBeNull();
  values.set(key, "[0,200,300]");
  expect(loadTableWidths(key, 3)).toBeNull();
  values.set(key, "[-10,200,300]");
  expect(loadTableWidths(key, 3)).toBeNull();
  values.set(key, "oops");
  expect(loadTableWidths(key, 3)).toBeNull();
  saveTableWidths(key, null);
  expect(values.has(key)).toBe(false);
});

test("resizing changes only the selected column and can grow the table up to its viewport", () => {
  const widths = [180.25, 240.5, 100.75];
  expect(resizeTableColumn(widths, 0, 35.5, 700)).toEqual([215.75, 240.5, 100.75]);
  expect(resizeTableColumn(widths, 1, -10, 700)).toEqual([180.25, 230.5, 100.75]);
  expect(widths).toEqual([180.25, 240.5, 100.75]);
});

test("resizing stops at the preferred minimum, maximum and viewport edge", () => {
  expect(resizeTableColumn([100, 100], 0, 1000, 260)).toEqual([160, 100]);
  expect(resizeTableColumn([100, 100], 0, -1000, 260)).toEqual([64, 100]);
  expect(resizeTableColumn([1190, 200], 0, 40, 1500)).toEqual([1200, 200]);
  expect(resizeTableColumn([100, 100], 0, 20, 200)).toEqual([100, 100]);
  expect(resizeTableColumn([10, 40], 0, 20, 50)).toEqual([10, 40]);
  expect(resizeTableColumn([1500, 100], 0, -20, 2000)).toEqual([1480, 100]);
});

test("tables shrink proportionally to their viewport without growing smaller tables", () => {
  expect(fitTableWidths([100, 200], 400)).toEqual([100, 200]);
  const fitted = fitTableWidths([200, 300, 100], 420);
  expect(fitted.reduce((a, b) => a + b, 0)).toBeCloseTo(420);
  expect(fitted[1]).toBeGreaterThan(fitted[0]);
  expect(fitted.every((width) => width >= 64)).toBe(true);
  expect(fitTableWidths([100, 100, 100], 120)).toEqual([40, 40, 40]);
});

test("invalid resize requests leave widths unchanged", () => {
  expect(resizeTableColumn([100, 200], 2, 40, 400)).toEqual([100, 200]);
  expect(resizeTableColumn([100, 200], -1, 40, 400)).toEqual([100, 200]);
  expect(resizeTableColumn([100, 200], 0, NaN, 400)).toEqual([100, 200]);
});
test("unavailable storage leaves resizing usable", () => {
  vi.stubGlobal("localStorage", {
    getItem() {
      throw new Error("Blocked");
    },
    setItem() {
      throw new Error("Full");
    },
  });
  expect(loadTableWidths("key", 2)).toBeNull();
  expect(() => saveTableWidths("key", [100, 200])).not.toThrow();
});
