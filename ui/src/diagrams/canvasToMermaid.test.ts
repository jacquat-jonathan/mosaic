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

test("lifelines become a sequence diagram, frames wrap their messages", async () => {
  const { parseCanvas } = await import("../viewers/canvas/jsonCanvas");
  const fs = await import("node:fs");
  const doc = parseCanvas(fs.readFileSync(new URL("./templates/uml/Sequence.canvas", import.meta.url), "utf8"));
  expect(canvasToMermaid(doc)).toBe(
    [
      "sequenceDiagram",
      "  participant p1 as User",
      "  participant p2 as Web shop",
      "  participant p3 as Payment",
      "  p1->>p2: 1: checkout()",
      "  p2->>p3: 2: charge(card)",
      "  p3-->>p2: ok",
      "  alt card declined",
      "    p2->>p3: 3: retry()",
      "  end",
      "  p2-->>p1: receipt",
      "",
    ].join("\n"),
  );
});

test("class boxes become a class diagram with relations", async () => {
  const { parseCanvas } = await import("../viewers/canvas/jsonCanvas");
  const fs = await import("node:fs");
  const doc = parseCanvas(fs.readFileSync(new URL("./templates/uml/Class.canvas", import.meta.url), "utf8"));
  const out = canvasToMermaid(doc);
  expect(out).toContain("classDiagram\n  class Customer {\n    -name: String\n");
  expect(out).toContain("    +total() Money\n");
  expect(out).toContain("  class Payable {\n    <<interface>>\n    +pay()\n  }");
  expect(out).toContain('  Customer "1" -- "*" Order : places');
  expect(out).toContain('  Order "1" *-- "1..*" LineItem');
  expect(out).toContain("  Order ..|> Payable : realizes");
});
