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
  for (const doc of ["https://", "Words /table", "```js\n/table", "---\nname: x\n/table", "<!--\n/table"]) expect(completion(doc)).toBeNull();
  expect(completion("/table remaining", 6)).toBeNull();
  expect(completion("/table", 6, true)).toBeNull();
});
test("insertion replaces the command, keeps surrounding text and selects the new block", () => {
  let state = EditorState.create({ doc: "Before\n/table\nAfter", selection: { anchor: 13 }, extensions: [markdown()] });
  const result = slashCompletion(new CompletionContext(state, 13, false))!;
  const option = result.options.find(o => o.label === "Table")!;
  const view = { dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as EditorView;
  if (typeof option.apply !== "function") throw new Error("Expected an insertion command");
  option.apply(view, option, result.from, 13);
  expect(state.doc.toString()).toBe("Before\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\nAfter");
  expect(state.selection.main.head).toBe(9);
});
