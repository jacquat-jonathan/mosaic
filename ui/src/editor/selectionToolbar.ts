import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { linkTextFor } from "../links";
import { editorContext } from "./context";

type Mark = "**" | "*";

export interface MarkEdit {
  changes: { from: number; to?: number; insert?: string }[];
  selection: { anchor: number; head: number };
}

function starRun(text: string, from: number, direction: -1 | 1) {
  let count = 0;
  for (let index = from; index >= 0 && index < text.length && text[index] === "*"; index += direction) count++;
  return count;
}

function containsMark(run: number, mark: Mark) {
  return mark === "*" ? run % 2 === 1 : run >= 2;
}

export function markdownMarkEdit(doc: string, from: number, to: number, mark: Mark): MarkEdit {
  const text = doc.slice(from, to);
  const outside = containsMark(starRun(doc, from - 1, -1), mark) && containsMark(starRun(doc, to, 1), mark);
  const inside = text.length >= mark.length * 2
    && containsMark(starRun(text, 0, 1), mark)
    && containsMark(starRun(text, text.length - 1, -1), mark);
  if (outside) {
    return {
      changes: [{ from: to, to: to + mark.length }, { from: from - mark.length, to: from }],
      selection: { anchor: from - mark.length, head: to - mark.length },
    };
  }
  if (inside) {
    return {
      changes: [{ from: to - mark.length, to }, { from, to: from + mark.length }],
      selection: { anchor: from, head: to - mark.length * 2 },
    };
  }
  return {
    changes: [{ from: to, insert: mark }, { from, insert: mark }],
    selection: { anchor: from + mark.length, head: to + mark.length },
  };
}

function selected(view: EditorView) {
  const range = view.state.selection.main;
  return range.empty ? null : { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) };
}

/** Toggle a Markdown marker around the current selection as one undoable edit. */
export function toggleSelectionMark(view: EditorView, mark: Mark): boolean {
  const range = selected(view);
  if (!range) return false;
  const edit = markdownMarkEdit(view.state.doc.toString(), range.from, range.to, mark);
  view.dispatch({ changes: edit.changes, selection: EditorSelection.range(edit.selection.anchor, edit.selection.head), userEvent: "input.format" });
  view.focus();
  return true;
}

function replaceCaptured(view: EditorView, capture: NonNullable<ReturnType<typeof selected>>, replacement: string) {
  if (view.state.sliceDoc(capture.from, capture.to) !== capture.text) return false;
  view.dispatch({ changes: { from: capture.from, to: capture.to, insert: replacement }, selection: { anchor: capture.from + replacement.length }, userEvent: "input.format" });
  view.focus();
  return true;
}

export function addWebLink(view: EditorView): boolean {
  const capture = selected(view);
  if (!capture) return false;
  void useUi.getState().askText({ title: "Link selected text", value: "https://", placeholder: "https://example.com" }).then(url => {
    if (url?.trim()) replaceCaptured(view, capture, `[${capture.text}](${url.trim()})`);
  });
  return true;
}

export function addNoteLink(view: EditorView): boolean {
  const capture = selected(view);
  if (!capture) return false;
  const vault = useVault.getState();
  const fromPath = view.state.facet(editorContext).path;
  useUi.getState().openPicker({
    placeholder: "Link selected text to a Mosaic note",
    items: vault.entries.filter(entry => !entry.is_dir && entry.kind === "markdown" && entry.path !== fromPath).map(entry => ({ id: entry.path, label: entry.path.replace(/\.md$/i, "") })),
    onPick: item => {
      const target = linkTextFor(item.id, vault.entries, fromPath);
      const natural = target.split("/").pop() ?? target;
      const replacement = capture.text === natural ? `[[${target}]]` : `[[${target}|${capture.text}]]`;
      replaceCaptured(view, capture, replacement);
    },
  });
  return true;
}

function button(label: string, title: string, action: () => void, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.title = title;
  element.setAttribute("aria-label", title);
  element.addEventListener("mousedown", event => event.preventDefault());
  element.addEventListener("click", action);
  return element;
}

function toolbar(view: EditorView) {
  const dom = document.createElement("div");
  dom.className = "cm-selection-toolbar";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Format selected text");
  dom.append(
    button("B", "Bold (⌘B)", () => void toggleSelectionMark(view, "**"), "strong"),
    button("I", "Italic (⌘I)", () => void toggleSelectionMark(view, "*"), "emphasis"),
    button("↗", "Add web link (⌘K)", () => void addWebLink(view)),
    button("[[ ]]", "Link to a Mosaic note", () => void addNoteLink(view), "note-link"),
  );
  return { dom };
}

const selectionTooltip = showTooltip.compute(["selection"], state => {
  const range = state.selection.main;
  if (state.readOnly || range.empty) return null;
  const tooltip: Tooltip = { pos: range.from, end: range.to, above: true, strictSide: false, arrow: false, create: toolbar };
  return tooltip;
});

export const selectionFormatting: Extension = [
  selectionTooltip,
  keymap.of([
    { key: "Mod-b", run: view => toggleSelectionMark(view, "**") },
    { key: "Mod-i", run: view => toggleSelectionMark(view, "*") },
    { key: "Mod-k", run: addWebLink },
  ]),
];
