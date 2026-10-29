import type { Range, Text } from "@codemirror/state";
import {
  Decoration,
  type EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { moveSectionTo, parse } from "../views/outline";

import { editorScope, editorButton } from "./designSystemDom";
import "./editorControls.css";

const SECTION_MIME = "application/x-mosaic-section";

class LineActionsWidget extends WidgetType {
  constructor(
    readonly line: number,
    readonly headingTitle: string | null,
  ) {
    super();
  }

  eq(other: LineActionsWidget) {
    return other.line === this.line && other.headingTitle === this.headingTitle;
  }

  toDOM() {
    const actions = document.createElement("span");
    actions.className = "cm-section-actions";
    editorScope(actions);
    const add = editorButton(document.createElement("button"));
    add.type = "button";
    add.classList.add("cm-section-add");
    add.dataset.sectionLine = String(this.line);
    add.title = "Add a line below";
    add.setAttribute("aria-label", `Add a line after line ${this.line}`);
    add.textContent = "+";
    actions.append(add);
    if (this.headingTitle === null) return actions;
    const button = editorButton(document.createElement("button"));
    button.type = "button";
    button.classList.add("cm-section-handle");
    button.draggable = true;
    button.tabIndex = -1;
    button.dataset.sectionLine = String(this.line);
    button.title = `Drag “${this.headingTitle}” to reorder this section`;
    button.setAttribute("aria-label", button.title);
    actions.append(button);
    return actions;
  }
}

/** A plain newline inserted at the end of a logical editor line, just like pressing Enter there. */
export function plainLineInsertion(doc: Text, lineNumber: number): { from: number; focus: number } | null {
  if (lineNumber < 1 || lineNumber > doc.lines) return null;
  const from = doc.line(lineNumber).to;
  return { from, focus: from + 1 };
}

function decorations(view: EditorView): DecorationSet {
  if (view.state.readOnly) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const headings = new Map(parse(view.state.doc.toString()).map((heading) => [heading.line, heading]));
  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber++) {
    const line = view.state.doc.line(lineNumber);
    const heading = headings.get(lineNumber);
    ranges.push(
      Decoration.line({
        class: heading ? "cm-block-line cm-section-line" : "cm-block-line",
        attributes: heading ? { "data-section-line": String(lineNumber) } : {},
      }).range(line.from),
    );
    ranges.push(
      Decoration.widget({ widget: new LineActionsWidget(lineNumber, heading?.text ?? null), side: -1 }).range(
        line.from,
      ),
    );
  }
  return Decoration.set(ranges, true);
}

/** AFFiNE-style add controls beside every line, plus drag controls beside headings. */
export const sectionDrag = ViewPlugin.fromClass(
  class {
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
      view.dom.addEventListener("click", this.onClick);
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
      this.view.dom.removeEventListener("click", this.onClick);
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

    private onClick = (event: MouseEvent) => {
      const add = (event.target as HTMLElement | null)?.closest<HTMLElement>(".cm-section-add");
      if (!add) return;
      event.preventDefault();
      event.stopPropagation();
      const line = Number(add.dataset.sectionLine);
      const edit = plainLineInsertion(this.view.state.doc, line);
      if (!edit) return;
      this.view.dispatch({
        changes: { from: edit.from, insert: "\n" },
        selection: { anchor: edit.focus },
        scrollIntoView: true,
        userEvent: "input.type",
      });
      this.view.focus();
    };

    private finishDrag() {
      this.clearDrop();
      this.draggingLine = null;
      this.view.dom.classList.remove("cm-section-dragging");
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
