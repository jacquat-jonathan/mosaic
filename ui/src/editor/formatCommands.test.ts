import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { blockTypeEdit, inlineMarkEdit, listEdit, toolbarState } from "./formatCommands";

/** `|` marks the caret; `[` and `]` a selection. */
function state(text: string) {
  const anchor = text.indexOf("[") >= 0 ? text.indexOf("[") : text.indexOf("|");
  const head = text.indexOf("]") >= 0 ? text.indexOf("]") - 1 : anchor;
  const doc = text.replace(/[|[\]]/g, "");
  return EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
    extensions: markdown({ base: markdownLanguage }),
  });
}
const apply = (s: EditorState, spec: TransactionSpec | null) => (spec ? s.update(spec).state : s);
const text = (s: EditorState, spec: TransactionSpec | null) => apply(s, spec).doc.toString();

describe("text style", () => {
  test("headings are set, changed and removed on the caret's line", () => {
    expect(text(state("Hel|lo\n"), blockTypeEdit(state("Hel|lo\n"), 2))).toBe("## Hello\n");
    const h2 = state("## Hel|lo\n");
    expect(text(h2, blockTypeEdit(h2, 3))).toBe("### Hello\n");
    expect(text(h2, blockTypeEdit(h2, 0))).toBe("Hello\n");
    expect(blockTypeEdit(h2, 2)).toBeNull();
  });

  test("every selected line changes; list and quote markers stay in front", () => {
    const s = state("[one\n- two\n> thr]ee\n");
    expect(text(s, blockTypeEdit(s, 1))).toBe("# one\n- # two\n> # three\n");
  });

  test("code lines are left alone", () => {
    const s = state("[a\n```\ncode\n```\nb]\n");
    expect(text(s, blockTypeEdit(s, 2))).toBe("## a\n```\ncode\n```\n## b\n");
  });

  test("the toolbar reads the caret line's style and list", () => {
    expect(toolbarState(state("### Ti|tle\n"))).toEqual({ block: 3, list: null });
    const task = EditorState.create({ doc: "- [ ] task\n", selection: { anchor: 8 }, extensions: markdown() });
    expect(toolbarState(task)).toEqual({ block: 0, list: "task" });
    expect(toolbarState(state("3. nu|m\n"))).toEqual({ block: 0, list: "ordered" });
    expect(toolbarState(state("```\nco|de\n```\n"))).toEqual({ block: null, list: null });
  });
});

describe("inline marks", () => {
  test("a selection is wrapped and unwrapped, for every mark", () => {
    for (const mark of ["**", "*", "~~", "`"] as const) {
      const s = state("a [word] b");
      const on = apply(s, inlineMarkEdit(s, mark));
      expect(on.doc.toString()).toBe(`a ${mark}word${mark} b`);
      expect(on.sliceDoc(on.selection.main.from, on.selection.main.to)).toBe("word");
      expect(text(on, inlineMarkEdit(on, mark))).toBe("a word b");
    }
  });

  test("with no selection, the word at the caret is wrapped, or an empty pair is inserted", () => {
    expect(text(state("a wo|rd b"), inlineMarkEdit(state("a wo|rd b"), "~~"))).toBe("a ~~word~~ b");
    const empty = state("a | b");
    const after = apply(empty, inlineMarkEdit(empty, "`"));
    expect(after.doc.toString()).toBe("a `` b");
    expect(after.selection.main.head).toBe(3);
  });
});

describe("lists", () => {
  test("lines become a list, keep indentation and quote marks, and toggle back", () => {
    const s = state("[one\n  two\n> three]\n");
    const on = apply(s, listEdit(s, "bullet"));
    expect(on.doc.toString()).toBe("- one\n  - two\n> - three\n");
    expect(text(on, listEdit(on, "bullet"))).toBe("one\n  two\n> three\n");
  });

  test("numbered lists count from 1; other markers and headings are replaced", () => {
    const s = state("[- a\n## b\n- [ ] c]\n");
    expect(text(s, listEdit(s, "ordered"))).toBe("1. a\n2. b\n3. c\n");
    expect(text(s, listEdit(s, "task"))).toBe("- [ ] a\n- [ ] b\n- [ ] c\n");
  });

  test("blank lines inside a multi-line selection stay blank", () => {
    const s = state("[a\n\nb]\n");
    expect(text(s, listEdit(s, "bullet"))).toBe("- a\n\n- b\n");
  });
});
