import { expect, test } from "vitest";
import { diagramKind, flowchartShapes } from "./mermaidToCanvas";

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

test("only flowcharts and state diagrams open as diagrams", () => {
  expect(diagramKind("graph TD\nA-->B")).toBe("flowchart");
  expect(diagramKind("  flowchart LR")).toBe("flowchart");
  expect(diagramKind("stateDiagram-v2\n[*] --> A")).toBe("state");
  expect(diagramKind("sequenceDiagram\nA->>B: hi")).toBeNull();
});
