import { expect, test } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { CompletionContext, type CompletionSection } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { slashCompletion } from "./slashMenu";

function completion(doc: string, pos = doc.length, readOnly = false) {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdown(), EditorState.readOnly.of(readOnly)],
  });
  return slashCompletion(new CompletionContext(state, pos, false));
}
test("slash menu only opens in an empty Markdown block", () => {
  expect(completion("# Note\n\n/")?.options.map((o) => o.label)).toContain("Table");
  expect(completion("  /heading")?.from).toBe(3);
  expect(completion("---\n\n/table")?.options.map((o) => o.label)).toContain("Table");
  for (const doc of ["https://", "Words /table", "```js\n/table", "---\nname: x\n/table", "<!--\n/table"])
    expect(completion(doc)).toBeNull();
  expect(completion("/table remaining", 6)).toBeNull();
  expect(completion("/table", 6, true)).toBeNull();
});

test("slash commands are grouped and include the agreed text, block, link and media helpers", () => {
  const options = completion("/")!.options;
  expect(options.map((option) => option.label)).toEqual(
    expect.arrayContaining(["Info panel", "Custom panel", "Math block", "Wikilink", "Web link", "Embed file"]),
  );
  // Sections carry a rank, so the menu shows them in this order rather than alphabetically.
  const ranked = [...new Set(options.map((option) => option.section as CompletionSection))].sort(
    (a, b) => Number(a.rank ?? 0) - Number(b.rank ?? 0),
  );
  expect(ranked.map((section) => section.name)).toEqual(["Basic", "Panels", "Blocks", "Links & media"]);
  expect(options.every((option) => option.type?.startsWith("mosaic-slash:"))).toBe(true);
});

test("placeholder-based commands select the text to replace", () => {
  let state = EditorState.create({ doc: "/wiki", selection: { anchor: 5 }, extensions: [markdown()] });
  const result = slashCompletion(new CompletionContext(state, 5, false))!;
  const option = result.options.find((o) => o.label === "Wikilink")!;
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as EditorView;
  if (typeof option.apply !== "function") throw new Error("Expected an insertion command");
  option.apply(view, option, result.from, 5);
  expect(state.doc.toString()).toBe("[[Note]]");
  expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("Note");
});
test("table insertion replaces the command and leaves the caret outside the rendered block", () => {
  let state = EditorState.create({ doc: "Before\n/table\nAfter", selection: { anchor: 13 }, extensions: [markdown()] });
  const result = slashCompletion(new CompletionContext(state, 13, false))!;
  const option = result.options.find((o) => o.label === "Table")!;
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as EditorView;
  if (typeof option.apply !== "function") throw new Error("Expected an insertion command");
  option.apply(view, option, result.from, 13);
  expect(state.doc.toString()).toBe("Before\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\nAfter");
  expect(state.selection.main.head).toBe(state.doc.toString().indexOf("After"));
});

test("a table inserted at the end keeps a blank separator after it", () => {
  let state = EditorState.create({ doc: "/table", selection: { anchor: 6 }, extensions: [markdown()] });
  const result = slashCompletion(new CompletionContext(state, 6, false))!;
  const option = result.options.find((o) => o.label === "Table")!;
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as EditorView;
  if (typeof option.apply !== "function") throw new Error("Expected an insertion command");
  option.apply(view, option, result.from, 6);
  expect(state.doc.toString()).toBe("| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\n");
  expect(state.selection.main.head).toBe(state.doc.length);
});

function apply(label: string) {
  let state = EditorState.create({ doc: "Before\n\n/", selection: { anchor: 9 }, extensions: [markdown()] });
  const result = slashCompletion(new CompletionContext(state, 9, false))!;
  const option = result.options.find((o) => o.label === label)!;
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as EditorView;
  if (typeof option.apply !== "function") throw new Error("Expected an insertion command");
  option.apply(view, option, result.from, 9);
  return { state, option };
}

test("panels insert a callout with the caret on its body line; a custom panel selects its title", () => {
  for (const [label, type] of [
    ["Info panel", "info"],
    ["Note panel", "note"],
    ["Success panel", "success"],
    ["Warning panel", "warning"],
    ["Error panel", "error"],
    ["Decision", "decision"],
  ]) {
    const { state, option } = apply(label);
    expect(state.doc.toString()).toBe(`Before\n\n> [!${type}]\n> `);
    expect(state.selection.main.head).toBe(state.doc.length);
    expect((option as { hint?: string }).hint).toBe(`> [!${type}]`);
  }
  const { state } = apply("Custom panel");
  expect(state.doc.toString()).toBe("Before\n\n> [!custom] Title\n> ");
  expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("Title");
});

test("most options show the Markdown you could type instead", () => {
  const options = completion("/")!.options as { label: string; hint?: string }[];
  const hint = (label: string) => options.find((o) => o.label === label)?.hint;
  expect(hint("Heading 2")).toBe("##");
  expect(hint("Bullet list")).toBe("-");
  expect(hint("Code block")).toBe("```");
});

test("a slash inside a quote or panel doesn't open the menu", () => {
  expect(completion("> /")).toBeNull();
  expect(completion("> [!info]\n> /")).toBeNull();
});
