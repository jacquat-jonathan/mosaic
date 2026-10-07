import { EditorView, WidgetType } from "@codemirror/view";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderMath } from "./render";
import { PropertiesEditor } from "./PropertiesEditor";
import { isDark } from "../theme";
import type { EditorContext } from "./context";

import { blockRenderers, showRenderError as showError } from "./blocks";
import { errorMessage } from "../ipc/types";
import { diagramKind } from "../diagrams/mermaidToCanvas";
import { useUi, type MenuItem } from "../state/ui";
import { deleteColumn, deleteRow, formatTable, insertColumn, insertRow, parseTable, setAlign, type TableModel } from "./tableEdit";
import { renderInlineMarkdown } from "../markdown";
export { splitRow } from "./tableEdit";

/** Moves the cursor to `pos` so the source is revealed for editing. */
function revealOnClick(dom: HTMLElement, view: EditorView, pos: () => number) {
  dom.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("a, input, button, .cm-link, .cm-wikilink")) return;
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos() } });
    view.focus();
  });
}

/** The last drawing that rendered without error, per block being edited (`path:line`). */
const lastGood = new Map<string, string>();

export class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly source: string,
    readonly ctx: EditorContext,
    // Diagrams bake the theme into their SVG, so a theme change must produce an unequal widget.
    readonly dark = isDark(),
    /** Set while the block's source is being edited: this is the live preview under it. */
    readonly previewKey?: string,
    /** Body range of a rendered fenced block; lets interactive renderers update their source. */
    readonly sourceRange?: { from: number; to: number },
  ) {
    super();
  }
  eq(o: RenderedBlockWidget) {
    return o.lang === this.lang && o.source === this.source && o.dark === this.dark && o.previewKey === this.previewKey && o.sourceRange?.from === this.sourceRange?.from && o.sourceRange?.to === this.sourceRange?.to;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = `cm-rendered-block cm-lang-${this.lang}${this.previewKey ? " cm-block-preview" : ""}`;
    // Links drawn by a renderer (query tables): the editor ignores events inside widgets, so open them here.
    el.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLElement>("[data-target]");
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      this.ctx.openLink(link.dataset.target!, e.metaKey);
    });
    const r = blockRenderers.get(this.lang);
    const key = this.previewKey;
    const failed = (e: unknown) => {
      const good = key && lastGood.get(key);
      if (!good) return showError(el, e);
      // Keep the last good drawing, with the error under it, instead of a blank box while typing.
      el.innerHTML = good;
      const note = document.createElement("div");
      note.className = "cm-render-error";
      note.textContent = errorMessage(e);
      el.appendChild(note);
    };
    const succeeded = () => {
      if (key) lastGood.set(key, el.innerHTML);
      // Added after rendering: the renderer replaces the block's content when the drawing arrives.
      else this.addOpenAsDiagram(el);
    };
    try {
      const replaceSource = this.sourceRange
        ? (source: string) => view.dispatch({ changes: { from: this.sourceRange!.from, to: this.sourceRange!.to, insert: source } })
        : undefined;
      const out = r?.(this.source, el, { ...this.ctx, replaceSource });
      if (out instanceof Promise) out.then(succeeded, failed);
      else succeeded();
    } catch (e) {
      failed(e);
    }
    if (key) return el;
    revealOnClick(el, view, () => view.posAtDOM(el));
    return el;
  }
  /** "Open as diagram" on a rendered Mermaid flowchart, state or class diagram. */
  private addOpenAsDiagram(el: HTMLElement) {
    if (this.lang !== "mermaid" || !this.ctx.openAsDiagram || !diagramKind(this.source)) return;
    const open = document.createElement("button");
    open.className = "block-action";
    open.textContent = "Open as diagram";
    open.title = "Make an editable canvas from this diagram, next to the note";
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      this.ctx.openAsDiagram!(this.source);
    });
    el.appendChild(open);
  }
  get estimatedHeight() {
    return 120;
  }
  ignoreEvent() {
    return true;
  }
}

export class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(o: MathWidget) {
    return o.source === this.source && o.display === this.display;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-block" : "cm-math";
    el.innerHTML = renderMath(this.source, this.display);
    revealOnClick(el, view, () => view.posAtDOM(el) + (this.display ? 2 : 1));
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly target: string,
    readonly resolved: boolean,
  ) {
    super();
  }
  eq(o: LinkWidget) {
    return o.label === this.label && o.target === this.target && o.resolved === this.resolved;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.resolved ? "cm-wikilink" : "cm-wikilink unresolved";
    el.textContent = this.label;
    el.dataset.target = this.target;
    el.title = this.resolved ? this.target : `${this.target} (not created yet — click to create)`;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly path: string | null,
    readonly alt: string,
    readonly width: number | null,
    readonly ctx: EditorContext,
    readonly remote: string | null = null,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.path === this.path && o.alt === this.alt && o.width === this.width && o.remote === this.remote;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-embed-image";
    if (this.remote) {
      wrap.classList.add("cm-embed-missing");
      wrap.textContent = `Remote image not loaded (offline mode): ${this.remote}`;
    } else if (!this.path) {
      wrap.classList.add("cm-embed-missing");
      wrap.textContent = `Missing file: ${this.alt}`;
    } else {
      const img = document.createElement("img");
      img.alt = this.alt;
      if (this.width) img.width = this.width;
      void this.ctx.fileUrl(this.path).then((u) => (img.src = u));
      wrap.appendChild(img);
    }
    revealOnClick(wrap, view, () => view.posAtDOM(wrap));
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

export class NoteEmbedWidget extends WidgetType {
  constructor(
    readonly path: string | null,
    readonly target: string,
    readonly ctx: EditorContext,
  ) {
    super();
  }
  eq(o: NoteEmbedWidget) {
    return o.path === this.path && o.target === this.target;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-embed-note";
    const head = document.createElement("div");
    head.className = "cm-embed-note-title cm-wikilink" + (this.path ? "" : " unresolved");
    head.textContent = this.target;
    head.dataset.target = this.target;
    el.appendChild(head);
    const body = document.createElement("div");
    body.className = "cm-embed-note-body";
    el.appendChild(body);
    if (this.path) {
      void this.ctx.readText(this.path).then(
        (t) => (body.textContent = stripFrontmatter(t).split("\n").slice(0, 16).join("\n").trim()),
        (e) => showError(body, e),
      );
    } else {
      body.textContent = "This note doesn't exist yet.";
    }
    revealOnClick(el, view, () => view.posAtDOM(el));
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** `![[Diagram.canvas]]` in a note: the canvas drawn as a picture; click it to open the canvas. */
export class CanvasEmbedWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly target: string,
    readonly ctx: EditorContext,
    readonly dark = isDark(),
  ) {
    super();
  }
  eq(o: CanvasEmbedWidget) {
    return o.path === this.path && o.dark === this.dark;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-embed-canvas";
    el.title = `Open ${this.target}`;
    el.dataset.target = this.target;
    void Promise.all([this.ctx.readText(this.path), import("../viewers/canvas/jsonCanvas"), import("../diagrams/canvasToSvg")]).then(
      ([text, { parseCanvas }, { canvasToSvg }]) => {
        // Our own SVG with every label escaped, so it's safe to insert.
        el.innerHTML = canvasToSvg(parseCanvas(text), this.dark);
      },
      (e) => showError(el, e),
    );
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.ctx.openLink(this.target, e.metaKey);
    });
    return el;
  }
  get estimatedHeight() {
    return 240;
  }
  ignoreEvent() {
    return true;
  }
}

export function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** The note's frontmatter as an editable form (PropertiesEditor); "Edit as YAML" shows the source. */
export class PropertiesWidget extends WidgetType {
  private roots = new WeakMap<HTMLElement, Root>();
  constructor(
    readonly yaml: string,
    /** Where the frontmatter block ends (it starts at 0, and the closing --- has no line break). */
    readonly end: number,
  ) {
    super();
  }
  eq(o: PropertiesWidget) {
    return o.yaml === this.yaml && o.end === this.end;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    const root = createRoot(el);
    this.roots.set(el, root);
    const onChange = (yaml: string) => {
      const block = yaml.trim() ? `---\n${yaml.endsWith("\n") ? yaml : `${yaml}\n`}---` : "";
      view.dispatch({ changes: { from: 0, to: this.end, insert: block } });
    };
    const onEditSource = () => {
      view.dispatch({ selection: { anchor: 4 } });
      view.focus();
    };
    root.render(createElement(PropertiesEditor, { yaml: this.yaml, onChange, onEditSource }));
    return el;
  }
  destroy(dom: HTMLElement) {
    const root = this.roots.get(dom);
    // Unmount after the current render, as React requires.
    if (root) queueMicrotask(() => root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

/** A nested ordered list's number shown as an outline number ("2.1."); the Markdown keeps "1.". */
export class OutlineNumberWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(o: OutlineNumberWidget) {
    return o.label === this.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-outline-number";
    el.textContent = this.label;
    return el;
  }
}

export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = "•";
    return el;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

export class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hr";
    return el;
  }
}

/** Where the caret goes once a table edit has redrawn the table (the widget is rebuilt). */
let tableFocus: { from: number; row: number; col: number; caret?: "start" | "end" } | null = null;

/**
 * A Markdown table you edit in place: type in a cell; Tab / ⇧Tab and Enter move between cells (adding
 * a row past the last one); right-click for rows, columns and alignment; the + buttons add a row or a
 * column. Edits are written back to the Markdown, with aligned pipes, when you leave a cell.
 */
export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const model = parseTable(this.source);
    const table = document.createElement("table");
    const cellEls: HTMLElement[][] = [];
    const addRow = (parent: HTMLElement, cells: string[], row: number) => {
      const tr = document.createElement("tr");
      const els: HTMLElement[] = [];
      cells.forEach((text, col) => {
        const td = document.createElement(row < 0 ? "th" : "td");
        td.dataset.source = text;
        td.innerHTML = renderInlineMarkdown(text);
        td.contentEditable = "plaintext-only";
        td.spellcheck = false;
        td.dataset.row = String(row);
        td.dataset.col = String(col);
        td.style.textAlign = model.align[col] ?? "left";
        tr.appendChild(td);
        els.push(td);
      });
      cellEls.push(els);
      parent.appendChild(tr);
    };
    const thead = document.createElement("thead");
    addRow(thead, model.header, -1);
    const tbody = document.createElement("tbody");
    model.rows.forEach((r, i) => addRow(tbody, r, i));
    table.append(thead, tbody);
    const editCell = (cell: HTMLElement) => {
      if (cell.dataset.editing === "true") return;
      cell.dataset.editing = "true";
      cell.textContent = cell.dataset.source ?? "";
    };
    const renderCell = (cell: HTMLElement) => {
      cell.dataset.source = cell.textContent ?? cell.dataset.source ?? "";
      cell.dataset.editing = "false";
      cell.innerHTML = renderInlineMarkdown(cell.dataset.source);
    };
    // Render formatting at rest; reveal and edit the exact Markdown source on focus.
    table.addEventListener("focusin", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (cell) editCell(cell);
    });
    table.addEventListener("mousedown", e => { const cell=(e.target as HTMLElement).closest<HTMLElement>("th, td"); if(cell) editCell(cell); });
    table.addEventListener("input", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (cell) cell.dataset.source = cell.textContent ?? "";
    });

    const addRowButton = document.createElement("button");
    addRowButton.className = "table-add row";
    addRowButton.title = "Add a row";
    addRowButton.textContent = "+";
    const addColButton = document.createElement("button");
    addColButton.className = "table-add col";
    addColButton.title = "Add a column";
    addColButton.textContent = "+";
    const inner = document.createElement("div");
    inner.className = "cm-table-inner";
    inner.append(table, addColButton, addRowButton);
    wrap.append(inner);

    const from = () => view.posAtDOM(wrap);
    const cellAt = (row: number, col: number) => cellEls[row + 1]?.[col];
    const posOf = (el: Element) => ({ row: Number((el as HTMLElement).dataset.row), col: Number((el as HTMLElement).dataset.col) });
    // The table as typed so far (cells hold plain text).
    const typed = (): TableModel => ({
      header: cellEls[0].map((c) => c.dataset.source ?? ""),
      align: [...model.align],
      rows: cellEls.slice(1).map((r) => r.map((c) => c.dataset.source ?? "")),
    });
    const focusCell = (el: HTMLElement | undefined, caret: "start" | "end" = "end") => {
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(caret === "start");
      sel?.removeAllRanges();
      sel?.addRange(range);
    };
    const unchanged = (t: TableModel) => JSON.stringify(t) === JSON.stringify(model);
    // Once an edit is written, the editor draws a new table; this one is done.
    let replaced = false;
    /** Writes `next` to the note (unless nothing changed); the redrawn table puts the caret in `focus`. */
    const commit = (next: TableModel, focus?: { row: number; col: number }) => {
      if (replaced || !wrap.isConnected) return;
      if (unchanged(next)) {
        if (focus) focusCell(cellAt(focus.row, focus.col));
        return;
      }
      replaced = true;
      const start = from();
      tableFocus = focus ? { from: start, ...focus } : null;
      view.dispatch({ changes: { from: start, to: start + this.source.length, insert: formatTable(next) } });
    };
    const move = (row: number, col: number, dRow: number, dCol: number) => {
      let t = typed();
      const cols = t.header.length;
      let r = row;
      let c = col + dCol;
      if (c >= cols) (c = 0), r++;
      if (c < 0) (c = cols - 1), r--;
      r += dRow;
      if (r < -1) return;
      if (r >= t.rows.length) t = insertRow(t, t.rows.length);
      commit(t, { row: r, col: c });
    };
    wrap.addEventListener("keydown", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (!cell) return;
      const { row, col } = posOf(cell);
      if (e.key === "Tab") {
        e.preventDefault();
        move(row, col, 0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        move(row, col, 1, 0);
      } else if (e.key === "Escape") {
        // Back to the note, on the line after the table.
        e.preventDefault();
        const start = from();
        const t = typed();
        const length = unchanged(t) ? this.source.length : formatTable(t).length;
        commit(t);
        view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, start + length + 1) } });
        view.focus();
      }
    });
    // Leaving a cell writes the table; moving to another cell of it keeps the caret there.
    wrap.addEventListener("focusout", (e) => {
      const left = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (left) renderCell(left);
      const next = e.relatedTarget as HTMLElement | null;
      if (next && wrap.contains(next) && next.matches("th, td")) {
        const t = typed();
        if (!unchanged(t)) commit(t, posOf(next));
        return;
      }
      if (!next || !wrap.contains(next)) commit(typed());
    });
    const menuFor = (row: number, col: number): MenuItem[] => {
      const t = () => typed();
      const at = (focus: { row: number; col: number }) => focus;
      return [
        { label: "Insert row above", disabled: row < 0, action: () => commit(insertRow(t(), row), at({ row, col })) },
        { label: "Insert row below", action: () => commit(insertRow(t(), row + 1), at({ row: row + 1, col })) },
        { label: "Delete row", disabled: row < 0, danger: true, action: () => commit(deleteRow(t(), row)) },
        { label: "", separator: true },
        { label: "Insert column left", action: () => commit(insertColumn(t(), col), at({ row, col })) },
        { label: "Insert column right", action: () => commit(insertColumn(t(), col + 1), at({ row, col: col + 1 })) },
        { label: "Delete column", disabled: model.header.length <= 1, danger: true, action: () => commit(deleteColumn(t(), col)) },
        { label: "", separator: true },
        {
          label: "Align column",
          children: (["left", "center", "right"] as const).map((a) => ({
            label: a[0].toUpperCase() + a.slice(1),
            checked: (model.align[col] ?? "left") === a,
            action: () => commit(setAlign(t(), col, a === "left" ? null : a)),
          })),
        },
        { label: "Edit as Markdown", action: () => (view.dispatch({ selection: { anchor: from() } }), view.focus()) },
      ];
    };
    wrap.addEventListener("contextmenu", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (!cell) return;
      e.preventDefault();
      const { row, col } = posOf(cell);
      useUi.getState().showMenu(e.clientX, e.clientY, menuFor(row, col));
    });
    addRowButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const t = typed();
      commit(insertRow(t, t.rows.length), { row: t.rows.length, col: 0 });
    });
    addColButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const t = typed();
      commit(insertColumn(t, t.header.length), { row: -1, col: t.header.length });
    });
    // Clicking beside the cells shows the Markdown source.
    wrap.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("th, td, button")) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: from() } });
      view.focus();
    });
    // Put the caret back after an edit redrew the table: the editor inserts this table in the same
    // task as the edit, so a microtask runs once it's in the page.
    queueMicrotask(() => {
      if (!tableFocus || !wrap.isConnected) return;
      const f = tableFocus;
      if (from() !== f.from) return;
      tableFocus = null;
      focusCell(cellAt(f.row, f.col), f.caret);
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}


/** Hosts a React component inside the editor (PDF pages, canvases…). */
export class ReactWidget extends WidgetType {
  private roots = new WeakMap<HTMLElement, Root>();
  constructor(
    readonly key: string,
    readonly render: () => ReactElement,
    readonly className: string,
  ) {
    super();
  }
  eq(o: ReactWidget) {
    return o.key === this.key;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = this.className;
    const root = createRoot(el);
    root.render(this.render());
    this.roots.set(el, root);
    revealOnClick(el, view, () => view.posAtDOM(el));
    return el;
  }
  destroy(dom: HTMLElement) {
    const root = this.roots.get(dom);
    if (root) setTimeout(() => root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

export { createElement };
