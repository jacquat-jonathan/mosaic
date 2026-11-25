import { expect, test } from "vitest";
import {
  deleteWidth,
  insertWidth,
  moveWidth,
  parseWidths,
  resizeBorder,
  roundWidths,
  usableWidths,
  widthsComment,
} from "./tableWidths";

test("a widths comment is read from its line", () => {
  expect(parseWidths("<!-- widths 20 30 30 20 -->")).toEqual([20, 30, 30, 20]);
  expect(parseWidths("  <!--widths 50 50-->  ")).toEqual([50, 50]);
  expect(parseWidths("<!-- widths 12.5 87.5 -->")).toEqual([12.5, 87.5]);
  expect(parseWidths("<!-- widths -->")).toBeNull();
  expect(parseWidths("<!-- widths 0 100 -->")).toEqual(null);
  expect(parseWidths("<!-- a comment -->")).toBeNull();
  expect(parseWidths("| a | b |")).toBeNull();
});

test("widths that don't match the table are ignored; others are scaled to 100%", () => {
  expect(usableWidths([20, 30, 50], 2)).toBeNull();
  expect(usableWidths(null, 2)).toBeNull();
  expect(usableWidths([1, 3], 2)).toEqual([25, 75]);
});

test("written widths are whole percentages adding up to 100", () => {
  for (const w of [
    [33.3, 33.3, 33.3],
    [10, 10, 10],
    [99.6, 0.2, 0.2],
    [12.5, 87.5],
  ]) {
    const out = roundWidths(w);
    expect(out.reduce((a, b) => a + b, 0)).toBe(100);
    expect(out.every((v) => Number.isInteger(v) && v >= 1)).toBe(true);
  }
  expect(widthsComment([25, 75])).toBe("<!-- widths 25 75 -->");
});

test("dragging a border trades width with the right-hand neighbour only", () => {
  expect(resizeBorder([25, 25, 50], 0, 10, 5)).toEqual([35, 15, 50]);
  expect(resizeBorder([25, 25, 50], 1, -5, 5)).toEqual([25, 20, 55]);
  // Clamped at the minimum on either side.
  expect(resizeBorder([25, 25, 50], 0, 100, 5)).toEqual([45, 5, 50]);
  expect(resizeBorder([25, 25, 50], 0, -100, 5)).toEqual([5, 45, 50]);
  // The last column has no border to drag.
  expect(resizeBorder([50, 50], 1, 10, 5)).toEqual([50, 50]);
});

test("adding, removing and moving columns keeps the total at 100%", () => {
  const sum = (w: number[]) => Math.round(w.reduce((a, b) => a + b, 0));
  const added = insertWidth([50, 50], 1);
  expect(added.map(Math.round)).toEqual([33, 33, 33]);
  expect(sum(added)).toBe(100);
  expect(deleteWidth([20, 30, 50], 2)).toEqual([40, 60]);
  expect(moveWidth([10, 20, 70], 0, 3)).toEqual([20, 70, 10]);
  expect(moveWidth([10, 20, 70], 2, 0)).toEqual([70, 10, 20]);
});
