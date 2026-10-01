import { expect, test } from "vitest";
import { canvasToMermaid } from "./canvasToMermaid";
import type { CanvasDoc } from "../viewers/canvas/jsonCanvas";

const n = (id: string, x: number, y: number, extra: object = {}) => ({ id, type: "text", x, y, width: 100, height: 50, text: id, ...extra });

test("shapes, groups and connection styles", () => {
  const doc: CanvasDoc = {
    nodes: [
      { id: "g", type: "group", x: -10, y: -10, width: 500, height: 100, label: "Front" },
      n("A", 0, 0, { text: "**Start**\nhere" }),
      n("B", 300, 0, { shape: "diamond", text: 'Ok "now"?' }),
      n("C", 0, 600, { shape: "cylinder" }),
      n("D", 300, 600, { shape: "document" }),
    ],
    edges: [
      { id: "1", fromNode: "A", toNode: "B", label: "go" },
      { id: "2", fromNode: "B", toNode: "C", line: "dashed" },
      { id: "3", fromNode: "C", toNode: "D", toEnd: "none", thickness: 4 },
      { id: "4", fromNode: "A", toNode: "D", fromEnd: "arrow", toEnd: "none" },
      { id: "5", fromNode: "B", toNode: "D", toEnd: "circle", fromEnd: "arrow" },
    ],
  };
  expect(canvasToMermaid(doc)).toBe(
    [
      "flowchart TD",
      '  subgraph g1 ["Front"]',
      '    n1("Start<br>here")',
      '    n2{"Ok #quot;now#quot;?"}',
      "  end",
      '  n3[("C")]',
      '  n4@{ shape: doc, label: "D" }',
      '  n1 -->|"go"| n2',
      "  n2 -.-> n3",
      "  n3 === n4",
      "  n4 --> n1",
      "  n2 <--o n4",
      "",
    ].join("\n"),
  );
});

test("a wide diagram goes left to right", () => {
  expect(canvasToMermaid({ nodes: [n("A", 0, 0), n("B", 900, 0)], edges: [] }).startsWith("flowchart LR")).toBe(true);
});
