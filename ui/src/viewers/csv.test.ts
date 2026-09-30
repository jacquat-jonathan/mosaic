import { expect, test } from "vitest";
import { parseCsv, serializeCsv } from "./CsvEditor";

test("quoted newlines, commas and trailing newline round-trip", () => {
  const src = 'name,value,note\nalpha,1,"quoted, with comma"\nbeta,2,"multi\nline"\n';
  const doc = parseCsv(src, "a.csv");
  expect(doc.rows).toEqual([
    ["name", "value", "note"],
    ["alpha", "1", "quoted, with comma"],
    ["beta", "2", "multi\nline"],
  ]);
  expect(serializeCsv(doc)).toBe(src);
});

test("BOM, semicolons and CRLF are preserved", () => {
  const src = "﻿a;b\r\n1;2\r\n";
  const doc = parseCsv(src, "a.csv");
  expect(doc.delimiter).toBe(";");
  expect(doc.bom).toBe(true);
  expect(serializeCsv(doc)).toBe(src);
});

test("ragged rows parse without padding", () => {
  const doc = parseCsv("a,b,c\n1\n2,3\n", "a.csv");
  expect(doc.rows[1]).toEqual(["1"]);
  expect(doc.rows[2]).toEqual(["2", "3"]);
});

test("tsv uses tabs", () => {
  expect(parseCsv("a\tb\n1\t2\n", "x.tsv").delimiter).toBe("\t");
});
