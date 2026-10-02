import { expect, test } from "vitest";
import { exportCss } from "./note";

test("the export CSS can be scoped to the print preview", () => {
  const page = exportCss();
  expect(page).toContain("body { font:");
  expect(page).toContain("color-scheme: light");
  const scoped = exportCss(".print-page");
  expect(scoped).toContain(".print-page { font:");
  expect(scoped).toContain(".print-page h1, .print-page h2, .print-page h3, .print-page h4 {");
  expect(scoped).not.toContain("color-scheme");
});
