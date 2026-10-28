// @vitest-environment jsdom
import { expect, test } from "vitest";
import { cellMarkdown, renderCellMarkdown } from "./tableCell";
import { renderInlineMarkdown } from "../markdown";
import { formatTable, parseTable } from "./tableEdit";

test("edited rich cells retain formatting, wikilinks, code, math and line breaks as Markdown", () => {
  const cell = document.createElement("td");
  renderCellMarkdown(cell, "**Bold** and *italic*, ~~old~~, `a` [[Notes/Plan|the plan]] $x^2$<br>next");
  const source = cellMarkdown(cell);
  expect(source).toContain("**Bold**");
  expect(source).toContain("*italic*");
  expect(source).toContain("~~old~~");
  expect(source).toContain("`a`");
  expect(source).toContain("[[Notes/Plan|the plan]]");
  expect(source).toContain("$x^2$");
  expect(source).toContain("<br>next");
});
test("literal punctuation and pipes survive rich editing and table round trips", () => {
  const cell = document.createElement("td");
  cell.textContent = "literal *stars* and a|b [x]";
  const source = cellMarkdown(cell);
  const t = { header: ["Cell"], align: [null], rows: [[source]] };
  const next = parseTable(formatTable(t));
  const rendered = document.createElement("div");
  rendered.innerHTML = renderInlineMarkdown(next.rows[0][0]);
  expect(rendered.textContent).toBe(cell.textContent);
  expect(rendered.querySelector("em")).toBeNull();
});

test("native placeholder breaks and whitespace at formatting boundaries stay valid Markdown", () => {
  const cell = document.createElement("td");
  cell.innerHTML = "<br>";
  expect(cellMarkdown(cell)).toBe("");
  cell.innerHTML = "<b>bold </b>next <i> italic </i>";
  expect(cellMarkdown(cell)).toBe("**bold** next  *italic* ");
  cell.innerHTML = "<b></b>";
  expect(cellMarkdown(cell)).toBe("");
});
