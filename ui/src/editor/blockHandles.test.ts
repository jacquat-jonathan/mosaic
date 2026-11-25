// @vitest-environment jsdom
import { autocompletion, closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { history, undo, undoDepth } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, expect, test } from "vitest";
import { addBelow, blockHandles, moveBlockAtCaret } from "./blockHandles";
import { blockRanges } from "./blockRanges";
import { slashCompletion } from "./slashMenu";

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => document.body.replaceChildren());

function editor(doc: string, caret = 0) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [
        history(),
        markdown({ base: markdownLanguage }),
        autocompletion({ override: [slashCompletion], activateOnTypingDelay: 0 }),
        blockHandles,
      ],
    }),
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

test("moving a block is one undo step, and undo restores the note exactly", () => {
  const doc = "# Title\n\nFirst\n\nSecond\n";
  const view = editor(doc, doc.indexOf("First") + 2);
  expect(moveBlockAtCaret(1)(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("# Title\n\nSecond\n\nFirst\n");
  // The caret stays on the same character of the moved block.
  const { head } = view.state.selection.main;
  expect(view.state.doc.sliceString(head - 2, head)).toBe("Fi");
  expect(undoDepth(view.state)).toBe(1);
  undo(view);
  expect(view.state.doc.toString()).toBe(doc);
});

test("+ opens the slash menu on a new paragraph, and dismissing it leaves the note unchanged", async () => {
  const doc = "First\n\nSecond\n";
  const view = editor(doc);
  addBelow(view, blockRanges(view.state)[0]);
  expect(view.state.doc.toString()).toBe("First\n\n/\n\nSecond\n");
  await settle();
  expect(completionStatus(view.state)).not.toBeNull();
  closeCompletion(view);
  await settle();
  expect(view.state.doc.toString()).toBe(doc);
  // Nothing is left to undo but the (now empty) insertion, and undo can't change the note.
  undo(view);
  expect(view.state.doc.toString()).toBe(doc);
});

test("text typed after the + slash is kept when the menu closes", async () => {
  const doc = "First\n";
  const view = editor(doc);
  addBelow(view, blockRanges(view.state)[0]);
  await settle();
  const at = view.state.selection.main.head;
  view.dispatch({ changes: { from: at, insert: "zzz" }, selection: { anchor: at + 3 }, userEvent: "input.type" });
  closeCompletion(view);
  await settle();
  expect(view.state.doc.toString()).toBe("First\n\n/zzz\n");
});

test("+ beside a list item adds an item, without a slash", () => {
  const view = editor("- a\n- b\n");
  // [0] is the whole list; [1] its first item.
  addBelow(view, blockRanges(view.state)[1]);
  expect(view.state.doc.toString()).toBe("- a\n- \n- b\n");
  expect(view.state.selection.main.head).toBe(6);
});
