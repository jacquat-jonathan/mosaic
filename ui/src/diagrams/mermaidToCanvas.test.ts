import { expect, test } from "vitest";
import { classText, diagramKind, flowchartShapes, parseClassDiagram } from "./mermaidToCanvas";

test("node shapes come from their brackets", () => {
  const shapes = flowchartShapes("flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C(Done)\n  B -.-> D[(DB)]\n  E((Circle)) --> F{{Hex}}\n  F --> G[/In/]\n  H([Pill]) & I[[Sub]]\n  J@{ shape: doc, label: \"Report\" }");
  expect(Object.fromEntries(shapes)).toEqual({
    A: "rectangle",
    B: "diamond",
    C: "rounded",
    D: "cylinder",
    E: "ellipse",
    F: "hexagon",
    G: "parallelogram",
    H: "pill",
    I: "process",
    J: "document",
  });
});

test("only flowcharts, state and class diagrams open as diagrams", () => {
  expect(diagramKind("graph TD\nA-->B")).toBe("flowchart");
  expect(diagramKind("  flowchart LR")).toBe("flowchart");
  expect(diagramKind("stateDiagram-v2\n[*] --> A")).toBe("state");
  expect(diagramKind("sequenceDiagram\nA->>B: hi")).toBeNull();
});

test("class diagrams: members, stereotypes and relations come from the source", () => {
  expect(diagramKind("classDiagram\nA <|-- B")).toBe("class");
  const { classes, relations } = parseClassDiagram(
    'classDiagram\n  class Order {\n    <<entity>>\n    -id: Int\n    +total() Money\n  }\n  <<interface>> Payable\n  Payable : +pay()\n  Order "1" *-- "1..*" LineItem : has\n  Order ..|> Payable\n  Order ..> Clock\n  class Empty',
  );
  expect(classes.map((c) => c.name)).toEqual(["Order", "Payable", "LineItem", "Clock", "Empty"]);
  expect(classText(classes[0])).toBe("«entity»\n**Order**\n---\n- id: Int\n---\n+ total(): Money");
  expect(classText(classes[1])).toBe("«interface»\n**Payable**\n---\n+ pay()");
  expect(classText(classes[4])).toBe("**Empty**");
  expect(relations).toEqual([
    { from: "Order", to: "LineItem", fromEnd: "diamond", toEnd: "none", dashed: false, fromLabel: "1", toLabel: "1..*", label: "has" },
    { from: "Order", to: "Payable", fromEnd: "none", toEnd: "triangle", dashed: true },
    { from: "Order", to: "Clock", fromEnd: "none", toEnd: "open", dashed: true },
  ]);
});

test("class diagrams round-trip through Copy as Mermaid", async () => {
  const { canvasToMermaid } = await import("./canvasToMermaid");
  const { parseCanvas } = await import("../viewers/canvas/jsonCanvas");
  const fs = await import("node:fs");
  const doc = parseCanvas(fs.readFileSync(new URL("./templates/uml/Class.canvas", import.meta.url), "utf8"));
  const { classes, relations } = parseClassDiagram(canvasToMermaid(doc));
  const byName = new Map(classes.map((c) => [c.name, classText(c)]));
  for (const n of doc.nodes) expect(byName.get(n.text!.match(/\*\*(.+)\*\*/)![1])).toBe(n.text);
  expect(relations.map((r) => [r.fromEnd, r.toEnd, r.dashed])).toEqual([
    ["none", "none", false],
    ["diamond", "none", false],
    ["none", "triangle", true],
  ]);
});
