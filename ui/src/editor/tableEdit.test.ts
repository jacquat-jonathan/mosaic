import { describe, expect, test } from "vitest";
import {
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumn,
  insertRow,
  moveRow,
  parseTable,
  pasteCells,
  setAlign,
  setCell,
  updateTable,
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

describe("updateTable keeps unchanged lines byte for byte", () => {
  // Hand-written spacing (not what formatTable would produce) to prove it survives.
  const source = "| Name | Qty |\n|:--|--:|\n| Apple   | 3 |\n| Kiwi | 12 |\n| Pear | 1 |";
  const lines = source.split("\n");

  test("no change writes the same text", () => {
    expect(updateTable(source, parseTable(source))).toBe(source);
  });

  test("editing one cell rewrites only that row", () => {
    const out = updateTable(source, setCell(parseTable(source), 1, 1, "13")).split("\n");
    expect(out.filter((l, i) => l !== lines[i])).toEqual([out[3]]);
    expect(parseTable(out.join("\n")).rows[1]).toEqual(["Kiwi", "13"]);
  });

  test("a long cell doesn't re-pad the other rows", () => {
    const out = updateTable(source, setCell(parseTable(source), 0, 0, "A very long apple name")).split("\n");
    expect(out.slice(0, 2)).toEqual(lines.slice(0, 2));
    expect(out.slice(3)).toEqual(lines.slice(3));
  });

  test("inserting and deleting rows keep the other rows", () => {
    const inserted = updateTable(source, insertRow(parseTable(source), 1)).split("\n");
    expect(inserted).toEqual([...lines.slice(0, 3), inserted[3], ...lines.slice(3)]);
    expect(updateTable(source, deleteRow(parseTable(source), 1))).toBe([...lines.slice(0, 3), lines[4]].join("\n"));
  });

  test("moving a row moves its original line", () => {
    expect(updateTable(source, moveRow(parseTable(source), 2, 0))).toBe(
      [lines[0], lines[1], lines[4], lines[2], lines[3]].join("\n"),
    );
  });

  test("changing alignment rewrites only the rule line", () => {
    const out = updateTable(source, setAlign(parseTable(source), 0, "center")).split("\n");
    expect(out[1]).toBe("| :-: | --: |");
    expect(out.filter((l, i) => l !== lines[i])).toEqual([out[1]]);
  });

  test("new rows are padded to the rule line's widths", () => {
    const padded = "| Name  | Qty |\n| ----- | --- |\n| Apple | 3   |";
    expect(updateTable(padded, insertRow(parseTable(padded), 1)).split("\n")[3]).toBe("|       |     |");
  });

  test("adding a column rewrites the table", () => {
    const next = insertColumn(parseTable(source), 2);
    expect(updateTable(source, next)).toBe(formatTable(next));
  });
});
