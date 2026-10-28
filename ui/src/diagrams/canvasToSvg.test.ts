import { expect, test } from "vitest";
import { canvasToSvg, plainLines } from "./canvasToSvg";
import { ENDS, SHAPES } from "./shapes";
import type { CanvasEdge, CanvasNode } from "../viewers/canvas/jsonCanvas";

test("labels lose Markdown but keep their words", () => {
  expect(plainLines("# Title\n**bold** and [[Note|alias]]\n- item <b>x</b>")).toEqual([
    "Title",
    "bold and alias",
    "• item x",
  ]);
  expect(plainLines("`~/Library/Caches/mosaic/<hash>/` and ~~old~~")).toEqual([
    "~/Library/Caches/mosaic/<hash>/ and old",
  ]);
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

test("renders every shape, card kind, route, side, label and arrow end in both themes", () => {
  const shapes: CanvasNode[] = SHAPES.map((shape, index) => ({
    id: `shape-${shape.name}`,
    type: "text",
    x: (index % 8) * 190,
    y: Math.floor(index / 8) * 150,
    width: shape.name === "actor" ? 80 : 160,
    height: shape.name === "lifeline" ? 130 : 100,
    text:
      shape.name === "class"
        ? "**Person**\n---\n- name: String\n---\n+ greet(): void"
        : shape.name === "timing"
          ? "clock: 0 1 0\ndata: idle,active,idle"
          : `# ${shape.name}\n\nA very long line that wraps into more than one line inside this shape`,
    shape: shape.name,
    color: index % 2 ? "1" : "#c04080",
    border: index % 3 === 0 ? "none" : index % 3 === 1 ? "dashed" : "dotted",
    icon: index === 0 ? "star" : undefined,
  }));
  const cards: CanvasNode[] = [
    { id: "file", type: "file", file: "Folder/Note.md", x: 0, y: 900, width: 180, height: 100 },
    { id: "empty-file", type: "file", x: 200, y: 900, width: 180, height: 100 },
    { id: "link", type: "link", url: "https://example.test/?a=1&b=2", x: 400, y: 900, width: 180, height: 100 },
    { id: "empty-link", type: "link", x: 600, y: 900, width: 180, height: 100 },
    {
      id: "card",
      type: "text",
      text: "# Heading\n\n- list\n\n```js\ncode\n```",
      icon: "heart",
      color: "2",
      x: 800,
      y: 900,
      width: 180,
      height: 100,
    },
    { id: "group-label", type: "group", label: "Group & label", x: -20, y: 880, width: 1200, height: 160 },
    { id: "group-empty", type: "group", x: 1200, y: 880, width: 200, height: 160 },
  ];
  const connectable = shapes.filter((node) => node.shape !== "frame").slice(0, ENDS.length + 4);
  const edges: CanvasEdge[] = ENDS.map((end, index) => ({
    id: `edge-${end.name}`,
    fromNode: connectable[index % connectable.length].id,
    toNode: connectable[(index + 1) % connectable.length].id,
    fromSide: (["top", "bottom", "left", "right"] as const)[index % 4],
    toSide: (["bottom", "top", "right", "left"] as const)[index % 4],
    fromOffset: 0.25,
    toOffset: 0.75,
    fromEnd: index % 2 ? end.name : "none",
    toEnd: end.name,
    route: index % 3 === 0 ? "straight" : index % 3 === 1 ? "orthogonal" : undefined,
    line: index % 2 ? "dotted" : "dashed",
    thickness: index + 1,
    color: index % 2 ? "3" : "#336699",
    label: `middle-${index}`,
    fromLabel: `from-${index}`,
    toLabel: `to-${index}`,
  }));
  edges.push(
    { id: "vertical-up", fromNode: connectable.at(-1)!.id, toNode: connectable[0].id },
    { id: "missing", fromNode: "missing", toNode: connectable[0].id, toEnd: "not-an-end" },
  );
  const doc = { nodes: [...cards, ...shapes], edges };
  const light = canvasToSvg(doc);
  const dark = canvasToSvg(doc, true);
  expect(light).toContain("Group &amp; label");
  expect(light).toContain("marker-start");
  expect(light).toContain("marker-end");
  expect(light).toContain("stroke-dasharray");
  expect(light).toContain("Folder/Note.md");
  expect(light).toContain("https://example.test/?a=1&amp;b=2");
  expect(light).not.toContain("not-an-end");
  expect(dark).toContain("#1e1f24");
});

test("plain text conversion covers aliases, bare links, HTML, blank lines and hard wrapping", () => {
  expect(plainLines("[[Bare]] ![[Target|Alias]] [web](https://x)\n\n<div>HTML</div>\n___")).toEqual([
    "Bare Alias web",
    "",
    "HTML",
    "",
  ]);
  const svg = canvasToSvg({
    nodes: [
      {
        id: "n",
        type: "text",
        x: 0,
        y: 0,
        width: 50,
        height: 42,
        text: "one two three four five six seven eight nine",
      },
    ],
    edges: [],
  });
  expect(svg.match(/<text /g)?.length).toBe(1);
});
