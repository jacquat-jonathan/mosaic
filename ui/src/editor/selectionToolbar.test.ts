import { expect, test } from "vitest";
import { markdownMarkEdit } from "./selectionToolbar";

function apply(doc: string, from: number, to: number, mark: "**" | "*") {
  const edit = markdownMarkEdit(doc, from, to, mark);
  let text = doc;
  for (const change of [...edit.changes].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, change.from) + (change.insert ?? "") + text.slice(change.to ?? change.from);
  }
  return { text, selected: text.slice(edit.selection.anchor, edit.selection.head) };
}

test("bold and italic actions wrap the selection and retain it", () => {
  expect(apply("Make this clear", 5, 9, "**")).toEqual({ text: "Make **this** clear", selected: "this" });
});

test("a formatting action toggles surrounding Markdown markers off", () => {
  expect(apply("Make **this** clear", 7, 11, "**")).toEqual({ text: "Make this clear", selected: "this" });
});

test("italic composes with bold instead of removing one bold marker", () => {
  expect(apply("Make **this** clear", 7, 11, "*")).toEqual({ text: "Make ***this*** clear", selected: "this" });
  expect(apply("Make ***this*** clear", 8, 12, "*")).toEqual({ text: "Make **this** clear", selected: "this" });
});
