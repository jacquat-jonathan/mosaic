// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { blockRenderers } from "./blocks";
import { editorContext, type EditorContext } from "./context";
import {
  BulletWidget,
  CanvasEmbedWidget,
  CheckboxWidget,
  ImageWidget,
  LinkWidget,
  MathWidget,
  NoteEmbedWidget,
  OutlineNumberWidget,
  ReactWidget,
  RenderedBlockWidget,
  RuleWidget,
  TableWidget,
  stripFrontmatter,
} from "./widgets";
import { useUi } from "../state/ui";

const context: EditorContext = {
  path: "Notes/Test.md",
  resolve: vi.fn(() => null),
  openLink: vi.fn(),
  openExternal: vi.fn(),
  openTag: vi.fn(),
  fileUrl: vi.fn(async (path) => `blob:${path}`),
  readText: vi.fn(async () => "---\ntitle: Hidden\n---\n# Visible\nBody"),
  importDrop: vi.fn(() => null),
  importPaste: vi.fn(() => null),
  linkCandidates: vi.fn(() => []),
  openAsDiagram: vi.fn(),
};

const state = () =>
  EditorState.create({ doc: "| A | B |\n| --- | --- |\n| one | two |\n", extensions: [editorContext.of(context)] });
const fakeView = (editorState = state()) =>
  ({
    state: editorState,
    dispatch: vi.fn(),
    focus: vi.fn(),
    posAtDOM: vi.fn(() => 0),
  }) as unknown as EditorView;

beforeEach(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  blockRenderers.delete("coverage-sync");
  blockRenderers.delete("coverage-async");
  blockRenderers.delete("coverage-fail");
});

test("small widgets render, compare and dispatch their interactions", async () => {
  const view = fakeView();
  const link = new LinkWidget("Alias", "Notes/Target", true);
  expect(link.eq(new LinkWidget("Alias", "Notes/Target", true))).toBe(true);
  expect(link.eq(new LinkWidget("Other", "Notes/Target", false))).toBe(false);
  expect(link.toDOM()).toMatchObject({ textContent: "Alias", className: "cm-wikilink" });
  expect(link.ignoreEvent()).toBe(false);

  const remote = new ImageWidget(null, "Remote", null, context, "https://example.test/a.png").toDOM(view);
  expect(remote.textContent).toContain("offline mode");
  const missing = new ImageWidget(null, "Missing", null, context).toDOM(view);
  expect(missing.textContent).toContain("Missing file");
  const image = new ImageWidget("Assets/a.png", "A", 320, context).toDOM(view);
  await vi.waitFor(() => expect(image.querySelector("img")?.src).toContain("blob:Assets/a.png"));
  expect(
    new ImageWidget("Assets/a.png", "A", 320, context).eq(new ImageWidget("Assets/a.png", "A", 320, context)),
  ).toBe(true);

  const math = new MathWidget("x^2", true);
  expect(math.toDOM(view).className).toBe("cm-math-block");
  expect(math.eq(new MathWidget("x^2", true))).toBe(true);
  expect(math.eq(new MathWidget("x", false))).toBe(false);

  expect(new OutlineNumberWidget("2.1.").toDOM().textContent).toBe("2.1.");
  expect(new BulletWidget().toDOM().textContent).toBe("•");
  expect(new RuleWidget().toDOM().className).toBe("cm-hr");
  const checkbox = new CheckboxWidget(false, 4).toDOM(view);
  checkbox.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(view.dispatch).toHaveBeenCalledWith({ changes: { from: 5, to: 6, insert: "x" } });
});

test("note and canvas embeds cover resolved, missing and failed content", async () => {
  const view = fakeView();
  const existing = new NoteEmbedWidget("Notes/Target.md", "Target", context).toDOM(view);
  await vi.waitFor(() => expect(existing.textContent).toContain("# Visible"));
  expect(existing.textContent).not.toContain("Hidden");
  const missing = new NoteEmbedWidget(null, "Absent", context).toDOM(view);
  expect(missing.textContent).toContain("doesn't exist");
  expect(new NoteEmbedWidget(null, "Absent", context).eq(new NoteEmbedWidget(null, "Absent", context))).toBe(true);

  const brokenContext = { ...context, readText: vi.fn(async () => Promise.reject(new Error("read failed"))) };
  const broken = new NoteEmbedWidget("broken.md", "Broken", brokenContext).toDOM(view);
  await vi.waitFor(() => expect(broken.textContent).toContain("read failed"));

  const canvas = new CanvasEmbedWidget("Diagram.canvas", "Diagram", {
    ...context,
    readText: vi.fn(async () => '{"nodes":[],"edges":[]}'),
  }).toDOM();
  document.body.append(canvas);
  await vi.waitFor(() => expect(canvas.querySelector("svg")).toBeTruthy(), { timeout: 10_000 });
  canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, metaKey: true }));
  expect(context.openLink).toHaveBeenCalledWith("Diagram", true);
  expect(new CanvasEmbedWidget("Diagram.canvas", "Diagram", context).estimatedHeight).toBe(240);
  expect(stripFrontmatter("---\na: 1\n---\nBody")).toBe("Body");
  expect(stripFrontmatter("Body")).toBe("Body");
});

test("rendered blocks handle links, source replacement, async success and errors", async () => {
  const view = fakeView();
  blockRenderers.set("coverage-sync", (source, element, options) => {
    element.innerHTML = `<button data-target="Target">${source}</button>`;
    options.replaceSource?.("replacement");
  });
  const widget = new RenderedBlockWidget("coverage-sync", "diagram", context, false, undefined, { from: 2, to: 9 });
  const element = widget.toDOM(view);
  element.querySelector("button")?.click();
  expect(context.openLink).toHaveBeenCalledWith("Target", false);
  expect(view.dispatch).toHaveBeenCalledWith({ changes: { from: 2, to: 9, insert: "replacement" } });
  expect(
    widget.eq(new RenderedBlockWidget("coverage-sync", "diagram", context, false, undefined, { from: 2, to: 9 })),
  ).toBe(true);
  expect(widget.ignoreEvent()).toBe(true);
  expect(widget.estimatedHeight).toBe(120);

  blockRenderers.set("coverage-async", async (_source, target) => {
    target.textContent = "drawn";
  });
  expect(new RenderedBlockWidget("coverage-async", "ok", context, false, "preview").toDOM(view)).toBeTruthy();
  blockRenderers.set("coverage-fail", async () => Promise.reject(new Error("drawing failed")));
  const failed = new RenderedBlockWidget("coverage-fail", "bad", context, false, "failure").toDOM(view);
  await vi.waitFor(() => expect(failed.textContent).toContain("drawing failed"));
});

test("React widgets mount, update and unmount", async () => {
  const view = fakeView();
  const react = new ReactWidget("key", () => <strong>Hosted content</strong>, "hosted");
  const reactDom = react.toDOM(view);
  document.body.append(reactDom);
  await act(async () => {});
  expect(reactDom.textContent).toContain("Hosted content");
  expect(react.eq(new ReactWidget("key", () => <span />, "other"))).toBe(true);
  react.destroy(reactDom);
  await new Promise((resolve) => setTimeout(resolve));
});

test("table widget edits cells, opens its menu and exposes add controls", async () => {
  const view = fakeView();
  const widget = new TableWidget("| A | B |\n| --- | --- |\n| one | two |\n");
  const table = widget.toDOM(view);
  document.body.append(table);
  await Promise.resolve();
  expect(table.querySelectorAll("th,td")).toHaveLength(4);
  expect(table.querySelectorAll('[role="separator"]')).toHaveLength(2);
  const cell = table.querySelector("td") as HTMLElement;
  cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  cell.textContent = "changed";
  cell.dispatchEvent(new InputEvent("input", { bubbles: true }));
  cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
  const menu = useUi.getState().menu!.items;
  expect(menu.filter((item) => !item.separator)).toHaveLength(5);
  expect(menu.find((item) => item.label === "Row")?.children?.some((item) => item.label === "Insert row below")).toBe(
    true,
  );
  cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
  expect(view.dispatch).toHaveBeenCalled();
  widget.destroy(table);

  const addView = fakeView();
  const addTable = new TableWidget("| A |\n| --- |\n| one |\n").toDOM(addView);
  document.body.append(addTable);
  addTable
    .querySelector<HTMLButtonElement>('[aria-label="Insert row 2"]')
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(addView.dispatch).toHaveBeenCalled();
});

test("table toolbar preserves drafts on alignment, spreadsheet paste grows the table, and read-only tables hide editing", async () => {
  const view = fakeView();
  const widget = new TableWidget("| A | B |\n| --- | --- |\n| one | two |\n");
  const dom = widget.toDOM(view);
  document.body.append(dom);
  await Promise.resolve();
  const cell = dom.querySelector("td")!;
  cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  cell.innerHTML = "<strong>draft</strong>";
  cell.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(view.dispatch).toHaveBeenCalledTimes(1);
  new TableWidget(
    (vi.mocked(view.dispatch).mock.calls[0][0] as { changes: { insert: string } }).changes.insert,
  ).updateDOM(dom);
  vi.mocked(view.dispatch).mockClear();
  const align = dom.querySelector<HTMLSelectElement>('[aria-label="Column alignment"]')!;
  align.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  expect(view.dispatch).not.toHaveBeenCalled();
  cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: align }));
  expect(view.dispatch).not.toHaveBeenCalled();
  align.value = "right";
  align.dispatchEvent(new Event("change", { bubbles: true }));
  expect(vi.mocked(view.dispatch).mock.calls[0][0]).toMatchObject({
    changes: { insert: expect.stringContaining("**draft**") },
  });
  widget.destroy(dom);

  const pasteView = fakeView();
  const paste = new TableWidget("| A |\n| --- |\n| one |\n");
  const pasteDom = paste.toDOM(pasteView);
  document.body.append(pasteDom);
  await Promise.resolve();
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => "left\tright\nnext\trow\n" } });
  pasteDom.querySelector("td")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(vi.mocked(pasteView.dispatch).mock.calls[0][0]).toMatchObject({
    changes: { insert: expect.stringContaining("right") },
  });
  paste.destroy(pasteDom);

  const readonly = fakeView(EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true)] }));
  const readonlyWidget = new TableWidget("| A |\n| --- |\n| one |\n");
  const readonlyDom = readonlyWidget.toDOM(readonly);
  expect(readonlyDom.querySelector<HTMLElement>(".table-toolbar")?.hidden).toBe(true);
  expect(readonlyDom.querySelector("select")).toBeNull();
  expect(readonlyDom.querySelector<HTMLElement>("td")?.contentEditable).toBe("false");
  readonlyWidget.destroy(readonlyDom);
});
