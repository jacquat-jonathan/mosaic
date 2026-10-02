import { expect, test } from "vitest";
import { canvasToSvg, plainLines } from "./canvasToSvg";

test("labels lose Markdown but keep their words", () => {
  expect(plainLines("# Title\n**bold** and [[Note|alias]]\n- item <b>x</b>")).toEqual(["Title", "bold and alias", "• item x"]);
  expect(plainLines("`~/Library/Caches/mosaic/<hash>/` and ~~old~~")).toEqual(["~/Library/Caches/mosaic/<hash>/ and old"]);
});

test("draws shapes, groups, connections with arrowheads and escaped labels", () => {
  const svg = canvasToSvg({
    nodes: [
      { id: "g", type: "group", x: -20, y: -20, width: 500, height: 200, label: "Team" },
      { id: "a", type: "text", x: 0, y: 0, width: 160, height: 80, text: "A < B & <script>", shape: "diamond" },
      { id: "b", type: "text", x: 300, y: 0, width: 160, height: 80, text: "B", shape: "cylinder" },
    ],
    edges: [{ id: "e", fromNode: "a", toNode: "b", toEnd: "triangle", label: "uses", line: "dashed" }],
  });
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain("A &lt; B &amp;");
  expect(svg).not.toContain("<script>");
  expect(svg).toContain('marker-end="url(#m-triangle-');
  expect(svg).toContain("stroke-dasharray");
  expect(svg).toContain(">Team<");
  expect(svg).toContain(">uses<");
  // viewBox covers everything plus padding.
  expect(svg).toMatch(/viewBox="-60 -60 580 280"/);
});

test("an empty canvas still makes a valid picture", () => {
  expect(canvasToSvg({ nodes: [], edges: [] })).toContain("Empty diagram");
});
