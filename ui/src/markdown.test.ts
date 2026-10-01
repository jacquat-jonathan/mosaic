import { expect, test } from "vitest";
import { markdownToHtml } from "./markdown";

test("inline and display math render with KaTeX, like in notes", () => {
  expect(markdownToHtml("Area: $\\pi r^2$")).toContain('class="katex"');
  expect(markdownToHtml("$$\nE = mc^2\n$$")).toContain('class="katex-display"');
});

test("prices and spaced dollars stay text", () => {
  const html = markdownToHtml("It costs $5 and $6, or $ 7 $.");
  expect(html).not.toContain("katex");
  expect(html).toContain("$5 and $6");
});

test("diagram blocks stay as fenced code for renderBlocksIn to replace", () => {
  expect(markdownToHtml("```mermaid\ngraph LR\nA-->B\n```")).toContain('<code class="language-mermaid">');
});
