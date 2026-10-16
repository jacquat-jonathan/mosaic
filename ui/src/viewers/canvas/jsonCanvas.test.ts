import { expect, test } from "vitest";
import { CanvasParseError, colorOf, parseCanvas, serializeCanvas } from "./jsonCanvas";

test("round-trips unknown fields with tab indentation", () => {
  const src = serializeCanvas({
    nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "hi", custom: 1 }],
    edges: [{ id: "e", fromNode: "a", toNode: "a", extra: true }],
    topLevel: "kept",
  });
  expect(src).toContain('\n\t"nodes"');
  expect(serializeCanvas(parseCanvas(src))).toBe(src);
});

test("empty file is an empty canvas; bad JSON is reported, not replaced", () => {
  expect(parseCanvas("")).toEqual({ nodes: [], edges: [] });
  expect(() => parseCanvas("{nope")).toThrow(CanvasParseError);
  expect(() => parseCanvas('{"nodes":[{"id":1}]}')).toThrow(CanvasParseError);
});

test("unknown card types open and survive a round trip", () => {
  const src = serializeCanvas({
    nodes: [{ id: "a", type: "shape", x: 0, y: 0, width: 10, height: 10, shape: "cloud" }],
    edges: [],
  });
  expect(parseCanvas(src).nodes[0].type).toBe("shape");
  expect(serializeCanvas(parseCanvas(src))).toBe(src);
});

test("preset and hex colours", () => {
  expect(colorOf("4")).toBe("#30a46c");
  expect(colorOf("#123456")).toBe("#123456");
  expect(colorOf("nope")).toBeUndefined();
});

test("colours that could break out of an SVG attribute are refused", () => {
  expect(colorOf('#fff" onload="alert(1)')).toBeUndefined();
  expect(colorOf("#12345")).toBeUndefined();
  expect(colorOf("#abcd")).toBe("#abcd");
});

test("node geometry is always a finite number", () => {
  const doc = parseCanvas(
    JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: '0" onload="alert(1)', y: "12", width: null, height: "Infinity" },
        { id: "b", type: "text", x: 5, y: 6 },
      ],
    }),
  );
  expect(doc.nodes[0]).toMatchObject({ x: 0, y: 12, width: 0, height: 0 });
  expect(doc.nodes[1]).toEqual({ id: "b", type: "text", x: 5, y: 6 });
});
