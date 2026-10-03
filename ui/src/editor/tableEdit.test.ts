import { expect, test } from "vitest";
import { deleteColumn, deleteRow, formatTable, insertColumn, insertRow, parseTable, setAlign, setCell } from "./tableEdit";

const src = "| Name | Qty |\n|:--|--:|\n| Apple | 3 |\n| Kiwi |\n";

test("parses cells and alignment, padding short rows", () => {
  const t = parseTable(src);
  expect(t.header).toEqual(["Name", "Qty"]);
  expect(t.align).toEqual(["left", "right"]);
  expect(t.rows).toEqual([["Apple", "3"], ["Kiwi", ""]]);
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
  expect(t.rows).toEqual([["Apple", "3"], ["", ""], ["Kiwi", ""]]);
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
