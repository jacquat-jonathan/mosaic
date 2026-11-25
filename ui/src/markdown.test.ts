// @vitest-environment jsdom
import { expect, test } from "vitest";
import { inlineMarkdownToHtml, markdownToHtml, renderMarkdown } from "./markdown";

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

test("shape labels can keep single line breaks", () => {
  expect(markdownToHtml("«interface»\nPayable", undefined, true)).toContain("<br>");
  expect(markdownToHtml("«interface»\nPayable")).not.toContain("<br>");
});

test("==highlights== render as marks, with formatting inside", () => {
  expect(markdownToHtml("a ==**bold** note== b")).toContain("<mark><strong>bold</strong> note</mark>");
  expect(markdownToHtml("a == b == c")).not.toContain("<mark>");
});

test("renders inline Markdown without a paragraph for table cells", () => {
  expect(inlineMarkdownToHtml("*soft* and **strong**")).toBe("<em>soft</em> and <strong>strong</strong>");
});

test("panels render from callouts, with the header line split off its paragraph", () => {
  const html = markdownToHtml("> [!warning] Mind **this**\n> Body text\n> - item\n");
  expect(html).toContain('<div class="callout callout-warning" data-callout="warning">');
  expect(html).toMatch(/<div class="callout-title">.*<span>Mind <strong>this<\/strong><\/span><\/div>/);
  expect(html).toMatch(/<div class="callout-body"><p>Body text<\/p>\s*<ul>\s*<li>item<\/li>/);
  expect(html).not.toContain("[!warning]");
});

test("a panel without a title shows its type's name; a header-only panel has no body", () => {
  const html = markdownToHtml("> [!tip]\n>\n> After a blank line\n");
  expect(html).toContain("callout-success");
  expect(html).toContain("<span>Success</span>");
  expect(html).toContain('<div class="callout-body"><p>After a blank line</p>');
  const empty = markdownToHtml("> [!note]\n");
  expect(empty).toContain("<span>Note</span>");
  expect(empty).not.toContain("callout-body");
});

test("plain quotes stay quotes, and panel titles are sanitised", () => {
  expect(markdownToHtml("> Just a quote\n")).toContain("<blockquote>");
  const html = renderMarkdown('> [!custom] <img src=x onerror="alert(1)"> Title\n> body\n');
  expect(html).toContain("callout-custom");
  expect(html).not.toContain("onerror");
});

test("a callout nested in a quote stays a quote, as in the editor", () => {
  const html = markdownToHtml("> Outer\n>\n> > [!info] Inner\n> > text\n");
  expect(html).not.toContain("callout");
  expect(html.match(/<blockquote>/g)).toHaveLength(2);
});

test("a callout inside a panel stays a quote inside it", () => {
  const html = markdownToHtml("> [!note] Outer\n> > [!info] Inner\n");
  expect(html.match(/class="callout /g)).toHaveLength(1);
  expect(html).toContain("<blockquote>");
});
