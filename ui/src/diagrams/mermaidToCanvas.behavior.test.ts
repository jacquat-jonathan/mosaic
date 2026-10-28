// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { renderMermaid } = vi.hoisted(() => ({ renderMermaid: vi.fn<(source: string) => Promise<string>>() }));
vi.mock("../editor/render", () => ({ renderMermaid }));

import { classText, flowchartShapes, mermaidToCanvas, parseClassDiagram } from "./mermaidToCanvas";

const svg = (body: string, viewBox = "0 0 400 300") => `<svg viewBox="${viewBox}">${body}</svg>`;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const el = this as Element;
    if (el.tagName.toLowerCase() === "svg") return new DOMRect(10, 20, 400, 300);
    const raw = el.getAttribute("data-box") ?? "20,30,100,50";
    const [x, y, width, height] = raw.split(",").map(Number);
    return new DOMRect(x, y, width, height);
  });
  Object.defineProperties(Element.prototype, {
    getCTM: { configurable: true, value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) },
    getTotalLength: { configurable: true, value: () => 100 },
    getPointAtLength: {
      configurable: true,
      value(this: Element, length: number) {
        const [x1, y1, x2, y2] = (this.getAttribute("data-points") ?? "30,40,250,180").split(",").map(Number);
        const atEnd = length > 0;
        return {
          x: atEnd ? x2 : x1,
          y: atEnd ? y2 : y1,
          matrixTransform() {
            return this;
          },
        };
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Mermaid SVG conversion", () => {
  it("converts flowchart clusters, named edges, shapes, styles and labels", async () => {
    renderMermaid.mockResolvedValue(
      svg(`
        <g class="cluster" data-box="15,25,300,180"><text>Area</text></g>
        <g class="node" id="flowchart-A_one-0" data-box="30,40,80,30"><text>Start</text></g>
        <g class="node" id="flowchart-B_two-1" data-box="240,160,90,35"><text>Finish</text></g>
        <g class="node" id="unrecognized"><text>Skip</text></g>
        <g class="edgeLabel"><g data-id="L_A_one_B_two_0"><text>yes</text></g></g>
        <path data-edge data-id="L_A_one_B_two_0" class="flowchart-link pattern-dotted thickness-thick" marker-start="url(#circle)" marker-end="url(#circle)" />
        <path data-edge data-id="L_missing_B_two_1" />
      `),
    );
    const doc = await mermaidToCanvas("flowchart LR\nA_one{Start} -->|yes| B_two([Finish])");
    expect(doc.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "group", label: "Area" }),
        expect.objectContaining({ type: "text", text: "Start", shape: "diamond" }),
        expect.objectContaining({ type: "text", text: "Finish", shape: "pill" }),
      ]),
    );
    expect(doc.edges).toEqual([
      expect.objectContaining({ fromEnd: "circle", toEnd: "circle", line: "dashed", thickness: 4, label: "yes" }),
      expect.any(Object),
    ]);
    expect(document.body.children).toHaveLength(0);
  });

  it("converts state nodes and resolves unnamed edges by path endpoints", async () => {
    renderMermaid.mockResolvedValue(
      svg(`
        <g class="node" id="state-root_start-0" data-box="20,30,10,10"><text></text></g>
        <g class="node" id="state-Working-1" data-box="100,80,120,45"><text>Working</text></g>
        <g class="node" id="state-root_end-2" data-box="300,180,10,10"><text></text></g>
        <path data-edge data-id="edge-0" data-points="20,30,310,190" marker-end="url(#arrow)" />
        <path data-edge data-id="edge-1" data-points="110,90,310,190" marker-start="url(#triangle)" />
      `),
    );
    const doc = await mermaidToCanvas("stateDiagram-v2\n[*] --> Working\nWorking --> [*]");
    expect(doc.nodes.map((node) => node.shape)).toEqual(["initial", "pill", "final"]);
    expect(doc.nodes[0]).toMatchObject({ width: 30, height: 30 });
    expect(doc.edges).toHaveLength(2);
    expect(doc.edges[0].toEnd).toBeUndefined();
    expect(doc.edges[1].fromEnd).toBe("arrow");
  });

  it("converts class diagrams with placed and fallback classes plus every relation decoration", async () => {
    renderMermaid.mockResolvedValue(
      svg(`
        <g class="node" id="classId-Order-0" data-box="40,50,120,70"><text>Order</text></g>
        <g class="node" id="bad"><text>ignored</text></g>
      `),
    );
    const doc = await mermaidToCanvas(`classDiagram
class Order {
  <<entity>>
  -id: Int
  +total() Money
}
class LineItem
class Service
Order "1" *--o "many" LineItem : owns
Order ..|> Service
LineItem --> Service`);
    expect(doc.nodes).toHaveLength(3);
    expect(doc.nodes[0]).toMatchObject({ shape: "class", text: expect.stringContaining("«entity»") });
    expect(doc.nodes[1].x).not.toBe(doc.nodes[0].x);
    expect(doc.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromEnd: "diamond",
          toEnd: "diamond-open",
          fromLabel: "1",
          toLabel: "many",
          label: "owns",
        }),
        expect.objectContaining({ line: "dashed", toEnd: "triangle" }),
        expect.objectContaining({ toEnd: "arrow" }),
      ]),
    );
  });

  it("rejects unsupported input and always removes the temporary host after renderer failures", async () => {
    await expect(mermaidToCanvas("sequenceDiagram\nA->>B: hi")).rejects.toThrow("Only flowcharts");
    expect(renderMermaid).not.toHaveBeenCalled();
    renderMermaid.mockResolvedValue("<div>not an svg</div>");
    await expect(mermaidToCanvas("flowchart LR\nA-->B")).rejects.toThrow();
    expect(document.body.children).toHaveLength(0);
  });
});

describe("class and flowchart parsing alternatives", () => {
  it("maps named Mermaid shapes and keeps the first bracket declaration", () => {
    const shapes = flowchartShapes(
      "flowchart LR\nA[one] A((two))\nB@{ shape: cloud }\nC@{ shape: sm-circ }\nD@{ shape: fr-circ }\nE@{ shape: fork }\nF@{ shape: cyl }\nG@{ shape: diam }\nH@{ shape: hex }\nI@{ shape: circle }\nJ@{ shape: unknown }",
    );
    expect(shapes.get("A")).toBe("rectangle");
    expect(Object.fromEntries(shapes)).toMatchObject({
      B: "cloud",
      C: "initial",
      D: "final",
      E: "bar",
      F: "cylinder",
      G: "diamond",
      H: "hexagon",
      I: "ellipse",
    });
    expect(shapes.has("J")).toBe(false);
  });

  it("parses comments, empty members, inline classes, generics and all UML relation ends", () => {
    const parsed = parseClassDiagram(`classDiagram-v2
%% comment
class Box~T~ {}
class Open {

  # value T
  ~ package()
}
<<service>> API
API : +call() Result
Box~T~ <|-- API
API o--* Open
Open <-- Box~T~
Open ..> API : depends`);
    expect(parsed.classes.map((item) => item.name)).toEqual(["Box~T~", "Open", "API"]);
    expect(classText(parsed.classes[0])).toContain("**Box<T>**");
    expect(classText(parsed.classes[1])).toContain("# value T");
    expect(classText(parsed.classes[2])).toContain("«service»");
    expect(parsed.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromEnd: "triangle", toEnd: "none", dashed: false }),
        expect.objectContaining({ fromEnd: "diamond-open", toEnd: "diamond" }),
        expect.objectContaining({ fromEnd: "arrow", toEnd: "none" }),
        expect.objectContaining({ toEnd: "open", dashed: true, label: "depends" }),
      ]),
    );
  });
});
