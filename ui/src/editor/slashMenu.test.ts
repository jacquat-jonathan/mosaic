import { expect, test } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { slashCompletion } from "./slashMenu";

function completion(doc: string, pos = doc.length, readOnly = false) {
  const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [markdown(), EditorState.readOnly.of(readOnly)] });
  return slashCompletion(new CompletionContext(state, pos, false));
}
test("slash menu only opens in an empty Markdown block", () => {
  expect(completion("# Note\n\n/")?.options.map(o => o.label)).toContain("Table");
  expect(completion("  /heading")?.from).toBe(3);
  expect(completion("---\n\n/table")?.options.map(o => o.label)).toContain("Table");
  for (const doc of ["https://", "Words /table", "```js\n/table", "---\nname: x\n/table", "<!--\n/table"]) expect(completion(doc)).toBeNull();
  expect(completion("/table remaining", 6)).toBeNull();
  expect(completion("/table", 6, true)).toBeNull();
});

test("slash commands are grouped and include the agreed text, block, link and media helpers", () => {
  const options = completion("/")!.options;
  expect(options.map((option) => option.label)).toEqual(expect.arrayContaining(["Callout", "Math block", "Wikilink", "Web link", "Embed file"]));
  expect(new Set(options.map((option) => option.section))).toEqual(new Set(["Text", "Blocks", "Links & media"]));
});

test("placeholder-based commands select the text to replace", () => {
  let state = EditorState.create({ doc: "/wiki", selection: { anchor: 5 }, extensions: [markdown()] });
  const result = slashCompletion(new CompletionContext(state, 5, false))!;
  const option = result.options.find(o => o.label === "Wikilink")!;
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as EditorView;
  if (typeof option.apply !== "function") throw new Error("Expected an insertion command");
  option.apply(view, option, result.from, 5);
  expect(state.doc.toString()).toBe("[[Note]]");
  expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("Note");
});
test("table insertion replaces the command and leaves the caret outside the rendered block", () => {
  let state = EditorState.create({ doc: "Before\n/table\nAfter", selection: { anchor: 13 }, extensions: [markdown()] });
  const result = slashCompletion(new CompletionContext(state, 13, false))!;
  const option = result.options.find(o => o.label === "Table")!;
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as EditorView;
  if (typeof option.apply !== "function") throw new Error("Expected an insertion command");
  option.apply(view, option, result.from, 13);
  expect(state.doc.toString()).toBe("Before\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\nAfter");
  expect(state.selection.main.head).toBe(state.doc.toString().indexOf("After"));
});

test("a table inserted at the end keeps a blank separator after it", () => {
  let state = EditorState.create({ doc: "/table", selection: { anchor: 6 }, extensions: [markdown()] });
  const result = slashCompletion(new CompletionContext(state, 6, false))!;
  const option = result.options.find(o => o.label === "Table")!;
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as EditorView;
  if (typeof option.apply !== "function") throw new Error("Expected an insertion command");
  option.apply(view, option, result.from, 6);
  expect(state.doc.toString()).toBe("| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\n");
  expect(state.selection.main.head).toBe(state.doc.length);
});
