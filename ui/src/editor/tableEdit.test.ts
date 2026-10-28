import { expect, test } from "vitest";
import {
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumn,
  insertRow,
  parseTable,
  pasteCells,
  setAlign,
  setCell,
} from "./tableEdit";

const src = "| Name | Qty |\n|:--|--:|\n| Apple | 3 |\n| Kiwi |\n";

test("spreadsheet paste expands a table, preserves alignment, and escapes literal pipes", () => {
  const t = parseTable(src);
  const next = pasteCells(t, 1, 1, "x|y\tnew\r\nlast\tcell\r\n");
  expect(next.header).toEqual(["Name", "Qty", ""]);
  expect(next.align).toEqual(["left", "right", null]);
  expect(next.rows).toEqual([
    ["Apple", "3", ""],
    ["Kiwi", "x|y", "new"],
    ["", "last", "cell"],
  ]);
  expect(parseTable(formatTable(next))).toEqual(next);
  expect(t.rows[1]).toEqual(["Kiwi", ""]);
  expect(pasteCells(t, -1, 0, "Title\tCount\nPear\t5").header).toEqual(["Title", "Count"]);
});

test("parses cells and alignment, padding short rows", () => {
  const t = parseTable(src);
  expect(t.header).toEqual(["Name", "Qty"]);
  expect(t.align).toEqual(["left", "right"]);
  expect(t.rows).toEqual([
    ["Apple", "3"],
    ["Kiwi", ""],
  ]);
});

test("writes aligned Markdown back, escaping pipes", () => {
  const t = setCell(parseTable(src), 1, 1, "a|b");
  expect(formatTable(t)).toBe("| Name  |  Qty |\n| :---- | ---: |\n| Apple |    3 |\n| Kiwi  | a\\|b |");
  // And reads back the same.
  expect(parseTable(formatTable(t))).toEqual(t);
});

test("rows and columns are added and removed", () => {
  let t = parseTable(src);
  t = insertRow(t, 1);
  expect(t.rows).toEqual([
    ["Apple", "3"],
    ["", ""],
    ["Kiwi", ""],
  ]);
  t = deleteRow(t, 0);
  expect(t.rows.map((r) => r[0])).toEqual(["", "Kiwi"]);
  t = insertColumn(t, 1);
  expect(t.header).toEqual(["Name", "", "Qty"]);
  expect(t.align).toEqual(["left", null, "right"]);
  t = deleteColumn(deleteColumn(deleteColumn(t, 0), 0), 0);
  expect(t.header).toEqual(["Qty"]); // the last column stays
  t = setAlign(t, 0, "center");
  expect(formatTable(t)).toBe("| Qty |\n| :-: |\n|     |\n|     |");
});

test("a header-only table and cells with line breaks", () => {
  const t = setCell(parseTable("| A | B |\n|---|---|"), -1, 0, "two\nlines");
  expect(formatTable(t)).toBe("| two lines | B   |\n| --------- | --- |");
});

test("reordering keeps headers, alignment and body values together without mutating the source", async () => {
  const { moveRow, moveColumn } = await import("./tableEdit");
  const t = parseTable(src);
  expect(moveRow(t, 0, 2).rows.map((r) => r[0])).toEqual(["Kiwi", "Apple"]);
  const next = moveColumn(t, 0, 2);
  expect(next.header).toEqual(["Qty", "Name"]);
  expect(next.align).toEqual(["right", "left"]);
  expect(next.rows[0]).toEqual(["3", "Apple"]);
  expect(parseTable(formatTable(next))).toEqual(next);
  expect(t.header).toEqual(["Name", "Qty"]);
  expect(moveRow(t, -1, 0)).toBe(t);
});
