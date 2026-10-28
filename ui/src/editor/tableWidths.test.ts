import { afterEach, expect, test, vi } from "vitest";
import { resizeTableColumn, loadTableWidths, saveTableWidths, tableWidthKey } from "./tableWidths";
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

test("resizing changes only the selected column", () => {
  const widths = [180.25, 240.5, 100.75];
  expect(resizeTableColumn(widths, 0, 35.5)).toEqual([215.75, 240.5, 100.75]);
  expect(resizeTableColumn(widths, 1, -10)).toEqual([180.25, 230.5, 100.75]);
  expect(widths).toEqual([180.25, 240.5, 100.75]);
});

test("columns can grow freely beyond the pane and the old maximum, with only a usable minimum", () => {
  expect(resizeTableColumn([100, 100], 0, 2000)).toEqual([2100, 100]);
  expect(resizeTableColumn([100, 100], 0, -1000)).toEqual([64, 100]);
  expect(resizeTableColumn([1190, 200], 0, 40)).toEqual([1230, 200]);
  expect(resizeTableColumn([10, 40], 0, 20)).toEqual([64, 40]);
  expect(resizeTableColumn([1500, 100], 0, -20)).toEqual([1480, 100]);
});

test("invalid resize requests leave widths unchanged", () => {
  expect(resizeTableColumn([100, 200], 2, 40)).toEqual([100, 200]);
  expect(resizeTableColumn([100, 200], -1, 40)).toEqual([100, 200]);
  expect(resizeTableColumn([100, 200], 0, NaN)).toEqual([100, 200]);
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
