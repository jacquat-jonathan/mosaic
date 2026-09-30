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

test("preset and hex colours", () => {
  expect(colorOf("4")).toBe("#30a46c");
  expect(colorOf("#123456")).toBe("#123456");
  expect(colorOf("nope")).toBeUndefined();
});
