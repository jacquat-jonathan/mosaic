// @vitest-environment jsdom
import { expect, test } from "vitest";
import { sanitizeSvg } from "./sanitizeSvg";

test("removes scripts, event handlers and javascript links from SVG", () => {
  const out = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>' +
      '<a xlink:href="javascript:alert(3)" href="javascript:alert(4)"><text onclick="alert(5)">hi</text></a></svg>',
  );
  expect(out).not.toMatch(/onload|onclick|<script|javascript:/i);
  expect(out).toContain("<text>hi</text>");
});

test("keeps what diagrams need: styles, markers, gradients and text", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.n{fill:red}</style>' +
    '<defs><marker id="m"><path d="M0,0 L1,1"/></marker><linearGradient id="g"><stop offset="0"/></linearGradient></defs>' +
    '<g class="node"><rect class="n" width="5" height="5" marker-end="url(#m)"/>' +
    '<text x="1" y="1" font-size="3">Label</text></g></svg>';
  const out = sanitizeSvg(svg);
  for (const part of ["<style>", "<marker", "<linearGradient", 'marker-end="url(#m)"', "Label"]) {
    expect(out).toContain(part);
  }
});
