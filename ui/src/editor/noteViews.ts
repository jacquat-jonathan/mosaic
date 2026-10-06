// The editor of each open note, so commands can act on the active one (e.g. "Add a property").

import type { EditorView } from "@codemirror/view";
import { FRONTMATTER_RE } from "./livePreview";

const views = new Map<string, EditorView>();

export interface NoteSelection {
  path: string;
  text: string;
  from: number;
  to: number;
}

export function setNoteView(path: string, view: EditorView | null) {
  if (view) views.set(path, view);
  else views.delete(path);
}

/** The person's current non-empty selection in an open note. */
export function noteSelection(path: string): NoteSelection | null {
  const view = views.get(path);
  if (!view) return null;
  const range = view.state.selection.main;
  if (range.empty) return null;
  const text = view.state.sliceDoc(range.from, range.to);
  return text.trim() ? { path, text, from: range.from, to: range.to } : null;
}

/** Asks the properties panel to open its "Add property" form (the panel mounting next, or one shown). */
let addOnMount = false;
export const ADD_PROPERTY_EVENT = "mosaic:add-property";
export function takeAddOnMount(): boolean {
  const a = addOnMount;
  addOnMount = false;
  return a;
}

/**
 * Opens the "Add property" form of the note at `path`, first giving it frontmatter if it has none.
 * Returns false when the note isn't open in an editor.
 */
export function addProperty(path: string): boolean {
  const view = views.get(path);
  if (!view) return false;
  const doc = view.state.doc.toString();
  const fm = FRONTMATTER_RE.exec(doc);
  if (fm) {
    // The caret inside the frontmatter shows it as YAML: move below it so the panel shows.
    const end = fm.index + fm[0].length;
    if (view.state.selection.main.head <= end) view.dispatch({ selection: { anchor: Math.min(doc.length, end + 1) } });
    addOnMount = true;
    window.dispatchEvent(new Event(ADD_PROPERTY_EVENT));
    return true;
  }
  const insert = doc.length ? "---\n\n---\n" : "---\n\n---\n\n";
  addOnMount = true;
  view.dispatch({ changes: { from: 0, insert }, selection: { anchor: insert.length } });
  view.focus();
  return true;
}
