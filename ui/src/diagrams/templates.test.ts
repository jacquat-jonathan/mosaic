import { expect, test } from "vitest";
import { DIAGRAM_TEMPLATES } from "./templates";
import { parseCanvas } from "../viewers/canvas/jsonCanvas";
import { isShape } from "./shapes";

test("every template parses, uses known shapes and has unique ids", () => {
  expect(DIAGRAM_TEMPLATES.length).toBe(19);
  for (const t of DIAGRAM_TEMPLATES) {
    expect(t.content, t.label).toBeTruthy();
    const doc = parseCanvas(t.content);
    for (const n of doc.nodes) if (n.shape !== undefined) expect(isShape(n.shape), `${t.label}: ${n.shape}`).toBe(true);
    const ids = new Set(doc.edges.flatMap((e) => [e.fromNode, e.toNode]));
    for (const id of ids) expect(doc.nodes.some((n) => n.id === id), `${t.label}: ${id}`).toBe(true);
  }
  expect(new Set(DIAGRAM_TEMPLATES.map((t) => t.id)).size).toBe(DIAGRAM_TEMPLATES.length);
});
