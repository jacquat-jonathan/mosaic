import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { plainLineInsertion } from "./sectionDrag";

function addLine(text: string, line: number) {
  const state = EditorState.create({ doc: text });
  const edit = plainLineInsertion(state.doc, line)!;
  return {
    text: state.update({ changes: { from: edit.from, insert: "\n" } }).state.doc.toString(),
    focus: edit.focus,
  };
}

describe("Markdown line add control", () => {
  it("adds a plain empty line after any logical line", () => {
    expect(addLine("First\nSecond", 1)).toEqual({ text: "First\n\nSecond", focus: 6 });
  });

  it("never turns a heading into another section", () => {
    expect(addLine("# Heading\nBody", 1).text).toBe("# Heading\n\nBody");
  });

  it("works at the end of a note, including an empty note", () => {
    expect(addLine("Last", 1)).toEqual({ text: "Last\n", focus: 5 });
    expect(addLine("", 1)).toEqual({ text: "\n", focus: 1 });
  });

  it("rejects a stale line number", () => {
    const doc = EditorState.create({ doc: "Only" }).doc;
    expect(plainLineInsertion(doc, 0)).toBeNull();
    expect(plainLineInsertion(doc, 2)).toBeNull();
  });
});
