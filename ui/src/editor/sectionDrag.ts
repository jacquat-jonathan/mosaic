import { type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { moveSectionTo, parse } from "../views/outline";

const SECTION_MIME = "application/x-mosaic-section";

class SectionHandleWidget extends WidgetType {
  constructor(readonly line: number, readonly title: string) { super(); }

  eq(other: SectionHandleWidget) {
    return other.line === this.line && other.title === this.title;
  }

  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-section-handle";
    button.draggable = true;
    button.tabIndex = -1;
    button.dataset.sectionLine = String(this.line);
    button.title = `Drag “${this.title}” to reorder this section`;
    button.setAttribute("aria-label", button.title);
    return button;
  }
}

function decorations(view: EditorView): DecorationSet {
  if (view.state.readOnly) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const heading of parse(view.state.doc.toString())) {
    ranges.push(Decoration.line({ class: "cm-section-line", attributes: { "data-section-line": String(heading.line) } }).range(heading.offset));
    ranges.push(Decoration.widget({ widget: new SectionHandleWidget(heading.line, heading.text), side: -1 }).range(heading.offset));
  }
  return Decoration.set(ranges, true);
}

/** Drag handles beside headings let sections move without a trip to the outline panel. */
export const sectionDrag = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private draggingLine: number | null = null;
  private dropLine: HTMLElement | null = null;

  constructor(readonly view: EditorView) {
    this.decorations = decorations(view);
    view.dom.addEventListener("dragstart", this.onDragStart);
    view.dom.addEventListener("dragover", this.onDragOver);
    view.dom.addEventListener("dragleave", this.onDragLeave);
    view.dom.addEventListener("drop", this.onDrop);
    view.dom.addEventListener("dragend", this.onDragEnd);
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.decorations = decorations(update.view);
  }

  destroy() {
    this.view.dom.removeEventListener("dragstart", this.onDragStart);
    this.view.dom.removeEventListener("dragover", this.onDragOver);
    this.view.dom.removeEventListener("dragleave", this.onDragLeave);
    this.view.dom.removeEventListener("drop", this.onDrop);
    this.view.dom.removeEventListener("dragend", this.onDragEnd);
  }

  private headingLine(event: DragEvent): HTMLElement | null {
    return (event.target as HTMLElement | null)?.closest<HTMLElement>(".cm-section-line") ?? null;
  }

  private clearDrop() {
    this.dropLine?.classList.remove("drop-before", "drop-after");
    this.dropLine = null;
  }

  private onDragStart = (event: DragEvent) => {
    const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>(".cm-section-handle");
    if (!handle || !event.dataTransfer) return;
    const line = Number(handle.dataset.sectionLine);
    if (!line) return;
    this.draggingLine = line;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(SECTION_MIME, String(line));
    this.view.dom.classList.add("cm-section-dragging");
  };

  private onDragOver = (event: DragEvent) => {
    if (this.draggingLine === null || !event.dataTransfer?.types.includes(SECTION_MIME)) return;
    const line = this.headingLine(event);
    if (!line) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (this.dropLine !== line) this.clearDrop();
    this.dropLine = line;
    const after = event.clientY >= line.getBoundingClientRect().top + line.getBoundingClientRect().height / 2;
    line.classList.toggle("drop-before", !after);
    line.classList.toggle("drop-after", after);
  };

  private onDragLeave = (event: DragEvent) => {
    if (this.dropLine && !this.dropLine.contains(event.relatedTarget as Node | null)) this.clearDrop();
  };

  private onDrop = (event: DragEvent) => {
    if (this.draggingLine === null) return;
    const target = this.headingLine(event);
    const targetLine = Number(target?.dataset.sectionLine);
    if (!targetLine) return;
    event.preventDefault();
    const place = target!.classList.contains("drop-after") ? "after" : "before";
    const doc = this.view.state.doc.toString();
    const edit = moveSectionTo(doc, this.draggingLine, targetLine, place);
    this.finishDrag();
    if (!edit) return;
    this.view.dispatch({
      changes: { from: 0, to: doc.length, insert: edit.text },
      selection: { anchor: edit.focus },
      scrollIntoView: true,
      userEvent: "move.section",
    });
    this.view.focus();
  };

  private onDragEnd = () => this.finishDrag();

  private finishDrag() {
    this.clearDrop();
    this.draggingLine = null;
    this.view.dom.classList.remove("cm-section-dragging");
  }
}, { decorations: plugin => plugin.decorations });
