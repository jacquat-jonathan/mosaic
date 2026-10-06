import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { selectionTouches } from "./livePreview";

function state(anchor: number, head = anchor) {
  return EditorState.create({ doc: "abcd", selection: { anchor, head } });
}

test("a caret belongs to the span that starts at its position, not the one that ends there", () => {
  expect(selectionTouches(state(2), 0, 2)).toBe(false);
  expect(selectionTouches(state(2), 2, 4)).toBe(true);
  expect(selectionTouches(state(4), 2, 4)).toBe(false);
});

test("a non-empty selection touches every span it intersects", () => {
  expect(selectionTouches(state(1, 3), 0, 2)).toBe(true);
  expect(selectionTouches(state(1, 3), 2, 4)).toBe(true);
  expect(selectionTouches(state(2, 4), 0, 2)).toBe(false);
});
