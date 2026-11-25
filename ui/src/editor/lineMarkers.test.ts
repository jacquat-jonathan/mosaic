// @vitest-environment jsdom
import { history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { afterEach, beforeAll, expect, test } from "vitest";
import { contentStart, deleteHeadingMark, leftFromContent, lineMarkers } from "./lineMarkers";

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => document.body.replaceChildren());

function editor(doc: string, caret: number) {
  const parent = document.body.appendChild(document.createElement("div"));
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [history(), markdown({ base: markdownLanguage }), lineMarkers, keymap.of(markdownKeymap)],
    }),
  });
}
const select = (view: EditorView, at: number) => view.dispatch({ selection: { anchor: at }, userEvent: "select" });

test("the content of a heading, list item, task or quote starts after its markup", () => {
  const doc = "## Title\n- item\n  - [ ] task\n> quote\nplain\n```\n- code\n```\n";
  const s = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) });
  const at = (text: string) => contentStart(s, s.doc, doc.indexOf(text));
  expect(at("## Title")).toBe(doc.indexOf("Title"));
  expect(at("- item")).toBe(doc.indexOf("item"));
  expect(at("  - [ ] task")).toBe(doc.indexOf("task"));
  expect(at("> quote")).toBe(doc.indexOf("quote"));
  expect(at("plain")).toBeNull();
  expect(at("- code")).toBeNull();
});

test("a caret that lands in front of hidden markup moves to the start of the content", () => {
  const doc = "Intro\n## Title\n- item\n";
  const view = editor(doc, 0);
  select(view, doc.indexOf("## Title"));
  expect(view.state.selection.main.head).toBe(doc.indexOf("Title"));
  select(view, doc.indexOf("- item") + 1);
  expect(view.state.selection.main.head).toBe(doc.indexOf("item"));
  // A selection made by code, and a range selection, are left as they are.
  view.dispatch({ selection: { anchor: doc.indexOf("## Title") } });
  expect(view.state.selection.main.head).toBe(doc.indexOf("## Title"));
  view.dispatch({
    selection: { anchor: doc.indexOf("## Title"), head: doc.indexOf("Title") + 2 },
    userEvent: "select",
  });
  expect(view.state.selection.main.from).toBe(doc.indexOf("## Title"));
});

test("ArrowLeft from the start of the content goes to the end of the previous line", () => {
  const doc = "Intro\n- item\n";
  const view = editor(doc, doc.indexOf("item"));
  expect(leftFromContent(view)).toBe(true);
  expect(view.state.selection.main.head).toBe("Intro".length);
  expect(leftFromContent(view)).toBe(false);
});

test("Backspace at the start of the content removes a heading's or list's markup, byte for byte", () => {
  const heading = editor("Intro\n## Title\n", "Intro\n## ".length);
  expect(deleteHeadingMark(heading)).toBe(true);
  expect(heading.state.doc.toString()).toBe("Intro\nTitle\n");
  expect(heading.state.selection.main.head).toBe("Intro\n".length);

  for (const [doc, after] of [
    ["- item\n", "item\n"],
    // The task box goes with the bullet, in one Backspace.
    ["- [ ] task\n", "task\n"],
    ["> quote\n", "quote\n"],
  ]) {
    const start = contentStart(
      EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) }),
      EditorState.create({ doc }).doc,
      0,
    )!;
    const view = editor(doc, start);
    const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(view.state.doc.toString()).toBe(after);
  }
});
