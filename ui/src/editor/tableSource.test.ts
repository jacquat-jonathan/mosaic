import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { editTableSource, tableSource } from "./tableSource";

test("explicit table source mode follows edits at its boundary and closes when the caret leaves", () => {
  let state = EditorState.create({ doc: "| A |\n| --- |\n| body |\n\nAfter", extensions: [tableSource] });
  state = state.update({ effects: editTableSource.of({ from: 0, to: 24 }), selection: { anchor: 0 } }).state;
  state = state.update({ changes: { from: 0, insert: " " }, selection: { anchor: 1 } }).state;
  expect(state.field(tableSource)).toEqual({ from: 0, to: 25 });
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  expect(state.field(tableSource)).toBeNull();
});
