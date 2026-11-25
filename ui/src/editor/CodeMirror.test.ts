// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, expect, test } from "vitest";
import { applyReload } from "./CodeMirror";

// jsdom has no layout; CodeMirror measures text ranges after each update.
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => document.body.replaceChildren());

function editor(doc: string, caret: number) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({ doc, selection: { anchor: caret }, extensions: [history()] }),
  });
}

const type = (view: EditorView, at: number, text: string) =>
  view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });

test("an outside edit above the caret keeps the caret on the same text", () => {
  const doc = "one\ntwo\nthree\n";
  const view = editor(doc, doc.indexOf("three") + 2);
  applyReload(view, "zero\none\ntwo\nthree\n");
  const { head } = view.state.selection.main;
  expect(view.state.doc.sliceString(head - 2, head + 3)).toBe("three");
});

test("an outside edit below the caret leaves the caret where it was", () => {
  const view = editor("one\ntwo\n", 2);
  applyReload(view, "one\ntwo\nthree\n");
  expect(view.state.selection.main.head).toBe(2);
});

test("an outside edit inside the caret's line keeps the caret next to the same character", () => {
  const view = editor("hello world\n", 8); // "wo|rld"
  applyReload(view, "hello big world\n");
  const { head } = view.state.selection.main;
  expect(view.state.doc.sliceString(head, head + 3)).toBe("rld");
});

test("a reload is not an undo step", () => {
  const view = editor("a\n", 0);
  applyReload(view, "a\nb\n");
  expect(undo(view)).toBe(false);
  expect(view.state.doc.toString()).toBe("a\nb\n");
});

test("undoing the user's own edit after an outside edit keeps the outside edit", () => {
  const view = editor("alpha\nbeta\n", 0);
  type(view, 5, " one");
  applyReload(view, "start\nalpha one\nbeta two\n");
  undo(view);
  expect(view.state.doc.toString()).toBe("start\nalpha\nbeta two\n");
});

test("undoing after an outside edit to the same block keeps the outside edit", () => {
  const view = editor("- item\n", 0);
  type(view, 6, " mine");
  // An agent edits the same list item, before and after the user's text.
  applyReload(view, "- the item mine, theirs\n");
  undo(view);
  expect(view.state.doc.toString()).toBe("- the item, theirs\n");
});

test("identical text changes nothing", () => {
  const view = editor("same\n", 2);
  const before = view.state;
  applyReload(view, "same\n");
  expect(view.state).toBe(before);
});
