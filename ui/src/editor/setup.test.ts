import { EditorSelection, EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { clampVerticalTarget, spellcheckAttributes } from "./setup";

test("vertical movement cannot skip blank Markdown lines", () => {
  const state = EditorState.create({ doc: "Top\n\n\nBottom" });
  const bottom = EditorSelection.cursor(state.doc.line(4).from + 3);
  const jumpedToTop = EditorSelection.cursor(state.doc.line(1).from + 3, 1, undefined, 24);
  const up = clampVerticalTarget(state, bottom, jumpedToTop, false);
  expect(up.head).toBe(state.doc.line(3).from);
  expect(up.goalColumn).toBe(24);

  const top = EditorSelection.cursor(state.doc.line(1).from + 2);
  const jumpedToBottom = EditorSelection.cursor(state.doc.line(4).from + 2, -1, undefined, 16);
  const down = clampVerticalTarget(state, top, jumpedToBottom, true);
  expect(down.head).toBe(state.doc.line(2).from);
  expect(down.goalColumn).toBe(16);
});

test("normal movement within a visual or adjacent line is unchanged", () => {
  const state = EditorState.create({ doc: "wrapped line\nnext" });
  const start = EditorSelection.cursor(2);
  const sameLine = EditorSelection.cursor(7);
  const nextLine = EditorSelection.cursor(state.doc.line(2).from + 2);
  expect(clampVerticalTarget(state, start, sameLine, true)).toBe(sameLine);
  expect(clampVerticalTarget(state, start, nextLine, true)).toBe(nextLine);
});

test("vertical movement cannot jump from one heading to a later heading", () => {
  const state = EditorState.create({ doc: "# First\nBody\n## Second" });
  const first = EditorSelection.cursor(2);
  const jumped = EditorSelection.cursor(state.doc.line(3).from + 2);
  expect(clampVerticalTarget(state, first, jumped, true).head).toBe(state.doc.line(2).from + 2);
});

test("spellcheck never enables automatic macOS corrections", () => {
  expect(spellcheckAttributes(true)).toEqual({ spellcheck: "true", autocorrect: "off", autocapitalize: "off" });
  expect(spellcheckAttributes(false)).toEqual({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" });
});
