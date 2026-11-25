import { type EditorView, WidgetType } from "@codemirror/view";
import { type ChangeDesc, Transaction } from "@codemirror/state";
import { undo, redo, isolateHistory } from "@codemirror/commands";
import { useUi, type MenuItem } from "../state/ui";
import { treeDragActive, treeDragData } from "../dragOut";
import { editorContext } from "./context";
import {
  MIN_COLUMN_PX,
  deleteWidth,
  insertWidth,
  moveWidth,
  parseWidths,
  resizeBorder,
  usableWidths,
  widthsComment,
} from "./tableWidths";
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  parseTable,
  pasteCells,
  setAlign,
  setCell,
  moveRow,
  moveColumn,
  type TableModel,
  updateTable,
} from "./tableEdit";
import { textChanges } from "./textDiff";
import { cellMarkdown, renderCellMarkdown } from "./tableCell";
import { editTableSource } from "./tableSource";
import { editorScope, editorButton } from "./designSystemDom";
import "./editorControls.css";

/**
 * A cell to focus once its table is drawn again. `from`–`to` is where the table's widget may now
 * start (after a reload the exact start is ambiguous); `notice` says why it was redrawn.
 */
const tableFocus = new WeakMap<
  EditorView,
  { from: number; to?: number; row: number; col: number; caret?: "start" | "end"; notice?: string }
>();
const controllers = new WeakMap<
  HTMLElement,
  { update(source: string, widthsLine: string): boolean; destroy(): void; focus(pos: number): boolean }
>();

type TableFocus = { from: number; row: number; col: number };

/** The table cell that has focus, if any, so a reload from disk can put the caret back in it. */
export function rememberTableFocus(view: EditorView): TableFocus | null {
  const cell = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("th, td");
  const wrap = cell?.closest<HTMLElement>(".cm-table-wrap");
  if (!cell || !wrap || !view.dom.contains(wrap)) return null;
  return { from: view.posAtDOM(wrap), row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
}

/**
 * After a reload: if the table was redrawn (its text changed), focus the same cell of the new one,
 * clamped to its size. A table whose text didn't change kept its DOM, caret included.
 */
export function restoreTableFocus(view: EditorView, focus: TableFocus, changes: ChangeDesc) {
  if ((document.activeElement as HTMLElement | null)?.closest("th, td")) return;
  const entry = {
    from: changes.mapPos(focus.from, -1),
    to: changes.mapPos(focus.from, 1),
    row: focus.row,
    col: focus.col,
    notice: "This table was changed outside the editor.",
  };
  tableFocus.set(view, entry);
  // The redrawn table claims it in a microtask queued during the reload. If the table is gone,
  // forget it so a later table drawn there isn't focused.
  queueMicrotask(() => {
    if (tableFocus.get(view) === entry) tableFocus.delete(view);
  });
}

/** Keyboard navigation into a rendered table enters its cell editor instead of revealing pipes. */
export function focusTableAtSelection(view: EditorView) {
  if (!view.hasFocus || (document.activeElement as HTMLElement | null)?.closest(".cm-table-wrap")) return;
  for (const dom of view.dom.querySelectorAll<HTMLElement>(".cm-table-wrap"))
    if (controllers.get(dom)?.focus(view.state.selection.main.head)) break;
}

/**
 * A rendered GFM table. `widthsLine` is the `<!-- widths … -->` comment line directly above it, if
 * any; the widget then covers that line too (it starts the widget's range) and keeps it up to date.
 */
export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly widthsLine = "",
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source && o.widthsLine === this.widthsLine;
  }
  updateDOM(dom: HTMLElement) {
    return controllers.get(dom)?.update(this.source, this.widthsLine) ?? false;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    let source = this.source;
    let widthsLine = this.widthsLine;
    let model = parseTable(source);
    let pendingSource: string | null = null;
    let structural = false;
    let preserveCell: HTMLElement | null = null;
    const table = document.createElement("table");
    const cellEls: HTMLElement[][] = [];
    let active = { row: -1, col: 0 };
    let selected: { top: number; bottom: number; left: number; right: number } | null = null;
    let formatting = false;
    const clearSelected = () => {
      selected = null;
      table.querySelectorAll(".table-selected").forEach((el) => el.classList.remove("table-selected"));
    };
    const selectRegion = (row: number, col: number, endRow: number, endCol: number) => {
      selected = {
        top: Math.min(row, endRow),
        bottom: Math.max(row, endRow),
        left: Math.min(col, endCol),
        right: Math.max(col, endCol),
      };
      cellEls.forEach((cells, r) =>
        cells.forEach((cell, c) =>
          cell.classList.toggle(
            "table-selected",
            !!selected &&
              r - 1 >= selected.top &&
              r - 1 <= selected.bottom &&
              c >= selected.left &&
              c <= selected.right,
          ),
        ),
      );
    };
    const toolbar = document.createElement("div");
    toolbar.className = "table-toolbar";
    editorScope(toolbar);
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Table editing");
    // A small chevron in the corner of the cell being edited opens that cell's menu.
    const cellMenu = document.createElement("button");
    cellMenu.className = "table-cell-menu";
    cellMenu.setAttribute("aria-label", "Cell options");
    cellMenu.title = "Cell options";
    cellMenu.hidden = true;
    const alignSelect = document.createElement("select");
    alignSelect.setAttribute("aria-label", "Column alignment");
    alignSelect.className = "mds-input";
    for (const value of ["left", "center", "right"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `Align ${value}`;
      alignSelect.append(option);
    }
    const updateToolbar = (row: number, col: number) => {
      active = { row, col };
      alignSelect.value = model.align[col] ?? "left";
      placeCellMenu();
    };
    /** Puts the cell chevron in the top-right corner of the active cell. */
    const placeCellMenu = () => {
      const cell = cellEls[active.row + 1]?.[active.col];
      if (!cell || view.state.readOnly) return;
      const bounds = inner.getBoundingClientRect();
      const rect = cell.getBoundingClientRect();
      cellMenu.hidden = false;
      cellMenu.style.left = `${rect.right - bounds.left - 22}px`;
      cellMenu.style.top = `${rect.top - bounds.top + 4}px`;
    };
    const addRow = (parent: HTMLElement, cells: string[], row: number) => {
      const tr = document.createElement("tr");
      const els: HTMLElement[] = [];
      cells.forEach((text, col) => {
        const td = document.createElement(row < 0 ? "th" : "td");
        td.dataset.source = text;
        renderCellMarkdown(td, text);
        td.contentEditable = view.state.readOnly ? "false" : "true";
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
      if (view.state.readOnly) return;
      cell.dataset.editing = "true";
    };
    const renderCell = (cell: HTMLElement) => {
      if (cell.dataset.editing !== "true") return;
      cell.dataset.editing = "false";
      renderCellMarkdown(cell, cell.dataset.source ?? "");
    };
    // Cells remain formatted on focus; only explicit source editing reveals Markdown.
    table.addEventListener("focusin", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (cell) {
        if (!formatting) clearSelected();
        editCell(cell);
        updateToolbar(Number(cell.dataset.row), Number(cell.dataset.col));
      }
    });
    table.addEventListener("mousedown", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (!cell) return;
      if (e.shiftKey && !view.state.readOnly) {
        e.preventDefault();
        selectRegion(active.row, active.col, Number(cell.dataset.row), Number(cell.dataset.col));
      } else {
        clearSelected();
        editCell(cell);
      }
    });
    table.addEventListener("click", (event) => {
      const link = (event.target as HTMLElement).closest<HTMLElement>("a,[data-target]");
      if (!link) return;
      event.preventDefault();
      if (!event.metaKey && !event.ctrlKey) return;
      const ctx = view.state.facet(editorContext);
      if (link.dataset.target !== undefined) ctx.openLink(link.dataset.target, true);
      else {
        const href = link.getAttribute("href") ?? "";
        if (/^(https?:|mailto:)/i.test(href)) ctx.openExternal(href);
        else if (!/^[a-z]+:/i.test(href)) ctx.openLink(href.replace(/\.md$/i, ""), true);
      }
    });
    table.addEventListener("input", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (cell) {
        if (!formatting) clearSelected();
        cell.dataset.source = cellMarkdown(cell);
        if (!composing) commit(typed());
      }
    });

    let composing = false;
    table.addEventListener("compositionstart", () => {
      composing = true;
    });
    table.addEventListener("compositionend", () => {
      composing = false;
      commit(typed());
    });
    const inner = document.createElement("div");
    inner.className = "cm-table-inner";
    inner.append(table);
    const scroll = document.createElement("div");
    scroll.className = "cm-table-scroll";
    scroll.append(inner);
    wrap.append(scroll, toolbar);

    /** Start of the widget: the widths comment line if there is one, else the table. */
    const from = () => view.posAtDOM(wrap);
    /** Start of the table's own text. */
    const tableFrom = () => from() + (widthsLine ? widthsLine.length + 1 : 0);
    /** Column widths in percent, or null for automatic widths. */
    let widths = usableWidths(parseWidths(widthsLine), model.header.length);
    const colgroup = document.createElement("colgroup");
    model.header.forEach(() => colgroup.append(document.createElement("col")));
    table.prepend(colgroup);
    const handles: HTMLButtonElement[] = [];
    const axes: {
      el: HTMLButtonElement;
      kind: "row" | "column" | "insert-row" | "insert-column";
      index: number;
      x?: number;
      y?: number;
    }[] = [];
    const positionHandles = () => {
      const bounds = inner.getBoundingClientRect();
      cellEls[0].forEach((cell, i) => {
        const rect = cell.getBoundingClientRect();
        if (handles[i]) {
          handles[i].style.left = `${rect.right - bounds.left - 5}px`;
          handles[i].style.height = `${rect.height}px`;
          handles[i].style.top = `${rect.top - bounds.top}px`;
        }
      });
      for (const control of axes) {
        const { el, kind, index } = control;
        if (kind === "column" || kind === "insert-column") {
          const rect = cellEls[0][Math.min(index, model.header.length - 1)].getBoundingClientRect();
          const x =
            kind === "column" ? rect.left + rect.width / 2 : index === model.header.length ? rect.right : rect.left;
          el.style.left = `${x - bounds.left - (kind === "column" ? 10 : 7)}px`;
          control.x = x - bounds.left;
          control.y = kind === "column" ? 10 : 25;
        } else {
          const row = kind === "row" ? index + 1 : Math.min(index + 1, cellEls.length - 1);
          const rect = cellEls[row][0].getBoundingClientRect();
          const y = kind === "row" ? rect.top + rect.height / 2 : index === model.rows.length ? rect.bottom : rect.top;
          el.style.top = `${y - bounds.top - (kind === "row" ? 10 : 7)}px`;
          control.x = kind === "row" ? 10 : 24;
          control.y = y - bounds.top;
        }
      }
    };
    // Reveal nearby controls without enlarging their clickable boxes over editable cells.
    // Positions are cached during layout so pointer movement only checks numbers, not each cell.
    scroll.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      const bounds = inner.getBoundingClientRect();
      const x = event.clientX - bounds.left,
        y = event.clientY - bounds.top;
      for (const control of axes) {
        const radius = (control.kind.startsWith("insert-") ? 7 : 10) + 12;
        const near =
          control.x !== undefined &&
          control.y !== undefined &&
          Math.abs(x - control.x) <= radius &&
          Math.abs(y - control.y) <= radius;
        if (control.el.hasAttribute("data-near") !== near) control.el.toggleAttribute("data-near", near);
      }
    });
    const clearNearby = () => {
      for (const control of axes) control.el.removeAttribute("data-near");
    };
    scroll.addEventListener("pointerleave", clearNearby);
    scroll.addEventListener("scroll", clearNearby, { passive: true });
    const applyWidths = () => {
      table.classList.toggle("resized", !!widths);
      [...colgroup.children].forEach((col, i) => {
        (col as HTMLElement).style.width = widths ? `${widths[i]}%` : "";
      });
      handles.forEach((handle, i) => {
        const value = widths ? Math.round(widths[i]) : Math.round(measuredWidths()[i]);
        handle.setAttribute("aria-valuenow", String(value));
        handle.setAttribute("aria-valuetext", `${value} percent`);
      });
      positionHandles();
      if (wrap.contains(document.activeElement)) placeCellMenu();
    };
    /** The columns' current share of the table, in percent, as laid out. */
    const measuredWidths = () => {
      const total = table.getBoundingClientRect().width || 1;
      return cellEls[0].map((cell) => (cell.getBoundingClientRect().width / total) * 100);
    };
    const minPercent = () => (MIN_COLUMN_PX / (table.getBoundingClientRect().width || 1)) * 100;
    /** The comment line for `next` widths, or "" to remove it. */
    const widthsChange = (next: number[] | null) => {
      const line = next ? widthsComment(next) : "";
      const start = from();
      if (line === widthsLine) return [];
      if (!widthsLine) return [{ from: start, to: start, insert: `${line}\n` }];
      if (!line) return [{ from: start, to: start + widthsLine.length + 1, insert: "" }];
      return [{ from: start, to: start + widthsLine.length, insert: line }];
    };
    /** Writes new widths to the note as one undo step. */
    const saveWidths = (next: number[] | null) => {
      if (view.state.readOnly || !wrap.isConnected) return;
      widths = next;
      applyWidths();
      const changes = widthsChange(next);
      if (!changes.length) return;
      pendingWidths = next ? widthsComment(next) : "";
      view.dispatch({
        changes,
        annotations: [Transaction.userEvent.of("input.table"), isolateHistory.of("full")],
      });
    };
    let pendingWidths: string | null = null;
    /** A short message under the table, e.g. why it was redrawn while being edited. */
    const showNotice = (text: string) => {
      const notice = document.createElement("div");
      notice.className = "table-notice";
      notice.setAttribute("role", "status");
      notice.textContent = text;
      wrap.append(notice);
      setTimeout(() => notice.remove(), 4000);
    };
    /** Removes the table (and its widths comment) with the line break after it, as one undo step. */
    const deleteTable = () => {
      if (view.state.readOnly || !wrap.isConnected) return;
      const start = from();
      const doc = view.state.doc;
      let end = tableFrom() + source.length;
      if (doc.sliceString(end, end + 1) === "\n") end++;
      // A blank line on both sides would leave two in a row: take the one after the table too.
      if (doc.sliceString(start - 2, start) === "\n\n" && doc.sliceString(end, end + 1) === "\n") end++;
      replaced = true;
      view.dispatch({
        changes: { from: start, to: end, insert: "" },
        selection: { anchor: start },
        annotations: [Transaction.userEvent.of("delete.table"), isolateHistory.of("full")],
      });
      view.focus();
    };
    const resetWidths = () => saveWidths(null);
    if (!view.state.readOnly)
      model.header.slice(0, -1).forEach((_, col) => {
        const handle = document.createElement("button");
        handle.className = "table-resize";
        handle.setAttribute("aria-label", `Resize column ${col + 1}`);
        handle.title = "Drag to resize · Arrow keys adjust · Double-click to reset widths";
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-valuemin", "0");
        handle.setAttribute("aria-valuemax", "100");
        let startX = 0,
          startWidths: number[] = [],
          dragging = false;
        handle.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startX = e.clientX;
          startWidths = widths ?? measuredWidths();
          dragging = true;
          handle.classList.add("dragging");
          handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener("pointermove", (e) => {
          if (!dragging) return;
          const total = table.getBoundingClientRect().width || 1;
          widths = resizeBorder(startWidths, col, ((e.clientX - startX) / total) * 100, minPercent());
          applyWidths();
        });
        const finish = () => {
          if (!dragging) return;
          dragging = false;
          handle.classList.remove("dragging");
          saveWidths(widths);
        };
        handle.addEventListener("pointerup", finish);
        handle.addEventListener("pointercancel", finish);
        handle.addEventListener("lostpointercapture", finish);
        handle.addEventListener("dblclick", () => resetWidths());
        handle.addEventListener("keydown", (e) => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Home") {
            resetWidths();
            return;
          }
          const step = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 5 : 1);
          saveWidths(resizeBorder(widths ?? measuredWidths(), col, step, minPercent()));
        });
        handles.push(handle);
        inner.append(handle);
      });
    const observer = new ResizeObserver(() => {
      positionHandles();
      if (wrap.contains(document.activeElement)) placeCellMenu();
    });
    observer.observe(wrap);
    queueMicrotask(() => {
      if (wrap.isConnected) applyWidths();
    });
    const cellAt = (row: number, col: number) => cellEls[row + 1]?.[col];
    const posOf = (el: Element) => ({
      row: Number((el as HTMLElement).dataset.row),
      col: Number((el as HTMLElement).dataset.col),
    });
    // The table as edited so far; each cell keeps its portable Markdown source.
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
    // Structural changes redraw the table; text edits retain the live DOM and caret.
    let replaced = false;
    /** Writes to the note and preserves the live cell, restoring focus after a structural redraw. */
    const commit = (next: TableModel, focus?: { row: number; col: number }, nextWidths?: number[] | null) => {
      if (view.state.readOnly || replaced || !wrap.isConnected) return;
      if (unchanged(next)) {
        if (focus) focusCell(cellAt(focus.row, focus.col));
        return;
      }
      const start = tableFrom();
      structural = next.header.length !== model.header.length || next.rows.length !== model.rows.length;
      // Widths follow columns that are added, removed or moved; stale widths are dropped.
      if (nextWidths === undefined && widths && next.header.length !== widths.length) nextWidths = null;
      const insert = updateTable(source, next);
      if (insert === source) {
        if (focus) focusCell(cellAt(focus.row, focus.col));
        return;
      }
      const current = document.activeElement as HTMLElement | null;
      preserveCell =
        current &&
        table.contains(current) &&
        current.matches("td,th") &&
        (active.row < 0 ? next.header : next.rows[active.row])?.[active.col] === current.dataset.source
          ? current
          : null;
      pendingSource = insert;
      if (nextWidths !== undefined) pendingWidths = nextWidths ? widthsComment(nextWidths) : "";
      if (focus) tableFocus.set(view, { from: from(), ...focus });
      else tableFocus.delete(view);
      view.dispatch({
        // Only the changed cells and lines, so undo, other selections and outside edits map cleanly.
        changes: [
          ...(nextWidths !== undefined ? widthsChange(nextWidths) : []),
          ...textChanges(source, insert).map((c) => ({ from: start + c.from, to: start + c.to, insert: c.insert })),
        ],
        annotations: [
          Transaction.userEvent.of(focus ? "input.table" : "input.type"),
          ...(focus ? [isolateHistory.of("full")] : []),
        ],
      });
      if (nextWidths !== undefined) widths = nextWidths;
      if (structural) replaced = true;
      else if (focus) {
        tableFocus.delete(view);
        focusCell(cellAt(focus.row, focus.col));
      }
    };
    const formatCells = (command: string) => {
      const region = selected;
      const cells = region
        ? cellEls.slice(region.top + 1, region.bottom + 2).flatMap((row) => row.slice(region.left, region.right + 1))
        : [cellAt(active.row, active.col)];
      formatting = true;
      try {
        for (const cell of cells) {
          if (!cell) continue;
          if (region) {
            cell.focus();
            const range = document.createRange();
            range.selectNodeContents(cell);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          } else if (!cell.contains(window.getSelection()?.anchorNode ?? null)) focusCell(cell);
          document.execCommand(command, false);
          cell.dataset.source = cellMarkdown(cell);
          commit(typed());
        }
      } finally {
        formatting = false;
      }
    };
    const move = (row: number, col: number, dRow: number, dCol: number) => {
      let t = typed();
      const cols = t.header.length;
      let r = row;
      let c = col + dCol;
      if (c >= cols) (c = 0), r++;
      if (c < 0) (c = cols - 1), r--;
      r += dRow;
      if (r < -1) {
        toolbar
          .querySelectorAll<HTMLElement>("button,select")
          .item(toolbar.querySelectorAll("button,select").length - 1)
          ?.focus();
        return;
      }
      if (r >= t.rows.length) t = insertRow(t, t.rows.length);
      commit(t, { row: r, col: c });
    };
    wrap.addEventListener("keydown", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (!cell) return;
      const { row, col } = posOf(cell);
      if (selected && ["Delete", "Backspace"].includes(e.key)) {
        e.preventDefault();
        let next = typed();
        for (let r = selected.top; r <= selected.bottom; r++)
          for (let c = selected.left; c <= selected.right; c++) next = setCell(next, r, c, "");
        commit(next, { row, col });
        return;
      }
      if ((e.metaKey || e.ctrlKey) && ["b", "i", "a"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key.toLowerCase() === "a") {
          const range = document.createRange();
          range.selectNodeContents(cell);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        } else {
          formatCells(e.key.toLowerCase() === "b" ? "bold" : "italic");
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        tableFocus.set(view, { from: from(), row, col });
        if (!(e.shiftKey ? redo : undo)(view)) tableFocus.delete(view);
      } else if (e.ctrlKey && e.altKey && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowRight") addColumnRight(row, col);
        else addRowBelow(row, col);
      } else if (e.key === "Tab") {
        e.preventDefault();
        move(row, col, 0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        move(row, col, 1, 0);
      } else if (e.key === "Escape") {
        // Back to the note, on the line after the table.
        e.preventDefault();
        const start = tableFrom();
        const t = typed();
        const length = unchanged(t) ? source.length : updateTable(source, t).length;
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
    const addColumnRight = (row: number, col: number) =>
      commit(insertColumn(typed(), col + 1), { row, col: col + 1 }, widths ? insertWidth(widths, col + 1) : undefined);
    const addRowBelow = (row: number, col: number) => commit(insertRow(typed(), row + 1), { row: row + 1, col });
    const alignmentMenu = (col: number): MenuItem => ({
      label: "Column alignment",
      children: (["left", "center", "right"] as const).map((a) => ({
        label: a[0].toUpperCase() + a.slice(1),
        checked: (model.align[col] ?? "left") === a,
        action: () => commit(setAlign(typed(), col, a === "left" ? null : a), { row: active.row, col }),
      })),
    });
    /** The menu of the cell chevron: what Confluence offers for one cell. */
    const cellMenuFor = (row: number, col: number): MenuItem[] => [
      alignmentMenu(col),
      { label: "", separator: true },
      { label: "Add column right", shortcut: "⌃⌥→", action: () => addColumnRight(row, col) },
      { label: "Add row below", shortcut: "⌃⌥↓", action: () => addRowBelow(row, col) },
      { label: "", separator: true },
      { label: "Clear cell", action: () => commit(setCell(typed(), row, col, ""), { row, col }) },
      {
        label: "Delete column",
        danger: true,
        disabled: model.header.length <= 1,
        action: () =>
          commit(
            deleteColumn(typed(), col),
            { row, col: Math.min(col, model.header.length - 2) },
            widths ? deleteWidth(widths, col) : undefined,
          ),
      },
      {
        label: "Delete row",
        danger: true,
        disabled: row < 0,
        action: () => commit(deleteRow(typed(), row), { row: Math.min(row, model.rows.length - 2), col }),
      },
    ];
    const menuFor = (row: number, col: number, axis?: "row" | "column"): MenuItem[] => {
      const t = () => typed();
      const at = (focus: { row: number; col: number }) => focus;
      const rows: MenuItem[] = [
        { label: "Insert row above", disabled: row < 0, action: () => commit(insertRow(t(), row), at({ row, col })) },
        { label: "Insert row below", action: () => commit(insertRow(t(), row + 1), at({ row: row + 1, col })) },
        {
          label: "Delete row",
          disabled: row < 0,
          danger: true,
          action: () => commit(deleteRow(t(), row), { row: Math.min(row, model.rows.length - 2), col }),
        },
        { label: "Move row up", disabled: row <= 0, action: () => reorder("row", row, row - 1) },
        {
          label: "Move row down",
          disabled: row < 0 || row >= model.rows.length - 1,
          action: () => reorder("row", row, row + 2),
        },
      ];
      const columns: MenuItem[] = [
        {
          label: "Insert column left",
          action: () => commit(insertColumn(t(), col), at({ row, col }), widths ? insertWidth(widths, col) : undefined),
        },
        {
          label: "Insert column right",
          action: () =>
            commit(
              insertColumn(t(), col + 1),
              at({ row, col: col + 1 }),
              widths ? insertWidth(widths, col + 1) : undefined,
            ),
        },
        {
          label: "Delete column",
          disabled: model.header.length <= 1,
          danger: true,
          action: () =>
            commit(
              deleteColumn(t(), col),
              { row, col: Math.min(col, model.header.length - 2) },
              widths ? deleteWidth(widths, col) : undefined,
            ),
        },
        { label: "", separator: true },
        { label: "Move column left", disabled: col === 0, action: () => reorder("column", col, col - 1) },
        {
          label: "Move column right",
          disabled: col >= model.header.length - 1,
          action: () => reorder("column", col, col + 2),
        },
      ];
      const alignment: MenuItem = {
        label: "Alignment",
        children: (["left", "center", "right"] as const).map((a) => ({
          label: a[0].toUpperCase() + a.slice(1),
          checked: (model.align[col] ?? "left") === a,
          action: () => commit(setAlign(t(), col, a === "left" ? null : a)),
        })),
      };
      if (axis === "row") return rows;
      if (axis === "column") return [...columns, alignment, { label: "Reset column widths", action: resetWidths }];
      return [
        { label: "Row", children: rows },
        { label: "Column", children: columns },
        alignment,
        { label: "Reset widths", action: resetWidths },
        { label: "", separator: true },
        {
          label: "Edit as Markdown",
          action: () => {
            const start = tableFrom();
            commit(typed());
            view.dispatch({
              effects: editTableSource.of({ from: start, to: start + source.length }),
              selection: { anchor: start },
            });
            view.focus();
          },
        },
      ];
    };
    const reorder = (kind: "row" | "column", index: number, boundary: number) => {
      const next = kind === "row" ? moveRow(typed(), index, boundary) : moveColumn(typed(), index, boundary);
      const destination = boundary > index ? boundary - 1 : boundary;
      commit(
        next,
        kind === "row" ? { row: destination, col: active.col } : { row: active.row, col: destination },
        kind === "column" && widths ? moveWidth(widths, index, boundary) : undefined,
      );
    };
    let dragging: { kind: "row" | "column"; index: number } | null = null;
    const clearDrop = () =>
      table
        .querySelectorAll(".table-drop-row,.table-drop-column")
        .forEach((el) => el.classList.remove("table-drop-row", "table-drop-column"));
    const axisButton = (kind: "row" | "column", index: number) => {
      const button = document.createElement("button");
      button.className = `table-axis table-${kind}-handle`;
      const label =
        kind === "row"
          ? index < 0
            ? "Header row options"
            : `Row ${index + 1} options`
          : `Column ${index + 1} options`;
      button.setAttribute("aria-label", label);
      button.title = `${label} · drag to reorder · Alt + Arrow keys to move`;
      button.textContent = "⋮⋮";
      button.draggable = !(kind === "row" && index < 0);
      button.addEventListener("click", () => {
        const rect = button.getBoundingClientRect();
        const row = kind === "row" ? index : active.row,
          col = kind === "column" ? index : active.col;
        updateToolbar(row, col);
        selectRegion(
          kind === "row" ? row : -1,
          kind === "row" ? 0 : col,
          kind === "row" ? row : model.rows.length - 1,
          kind === "row" ? model.header.length - 1 : col,
        );
        useUi.getState().showMenu(rect.left, rect.bottom, menuFor(row, col, kind));
      });
      button.addEventListener("keydown", (event) => {
        const previous = kind === "row" ? "ArrowUp" : "ArrowLeft",
          next = kind === "row" ? "ArrowDown" : "ArrowRight";
        if (!event.altKey || ![previous, next].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const count = kind === "row" ? model.rows.length : model.header.length;
        if (index < 0 || (event.key === previous ? index === 0 : index === count - 1)) return;
        reorder(kind, index, event.key === previous ? index - 1 : index + 2);
      });
      button.addEventListener("dragstart", (event) => {
        if (!button.draggable || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        event.stopPropagation();
        dragging = { kind, index };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-mosaic-table", kind);
      });
      button.addEventListener("dragend", () => {
        dragging = null;
        clearDrop();
      });
      axes.push({ el: button, kind, index });
      inner.append(button);
    };
    if (!view.state.readOnly) {
      cellEls.forEach((_, index) => axisButton("row", index - 1));
      model.header.forEach((_, index) => axisButton("column", index));
      const insertButton = (kind: "row" | "column", index: number) => {
        const button = document.createElement("button");
        button.className = `table-insert insert-${kind}`;
        button.setAttribute("aria-label", kind === "row" ? `Insert row ${index + 1}` : `Insert column ${index + 1}`);
        button.textContent = "+";
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          commit(
            kind === "row" ? insertRow(typed(), index) : insertColumn(typed(), index),
            kind === "row" ? { row: index, col: active.col } : { row: active.row, col: index },
            kind === "column" && widths ? insertWidth(widths, index) : undefined,
          );
        });
        axes.push({ el: button, kind: kind === "row" ? "insert-row" : "insert-column", index });
        inner.append(button);
      };
      for (let i = 0; i <= model.rows.length; i++) insertButton("row", i);
      for (let i = 0; i <= model.header.length; i++) insertButton("column", i);
      const dropTarget = (event: DragEvent) => {
        if (!dragging) return null;
        const axis = axes.find((a) => a.el === (event.target as HTMLElement).closest(".table-axis"));
        if (axis && axis.kind !== dragging.kind) return null;
        // Resolve the table's edge/resize/insertion overlays by coordinates too. They must not
        // create dead drop zones along the very boundaries used to move columns.
        const cell =
          (event.target as HTMLElement).closest<HTMLElement>("td,th") ??
          (dragging.kind === "column" ? cellEls[0] : cellEls.slice(1).map((cells) => cells[0])).find((el) => {
            const rect = el.getBoundingClientRect();
            return dragging!.kind === "column"
              ? event.clientX >= rect.left && event.clientX <= rect.right
              : event.clientY >= rect.top && event.clientY <= rect.bottom;
          });
        if (!cell && !axis) return null;
        const pos = cell
          ? posOf(cell)
          : {
              row: axis!.kind === "row" ? axis!.index : active.row,
              col: axis!.kind === "column" ? axis!.index : active.col,
            };
        if (dragging.kind === "row" && pos.row < 0) return null;
        const target = cell ?? cellAt(pos.row, pos.col)!;
        const rect = target.getBoundingClientRect();
        // A handle represents the whole row/column: dropping onto the next handle moves past it,
        // rather than unpredictably treating the handle's midpoint as an insertion boundary.
        const after = axis
          ? axis.index > dragging.index
          : dragging.kind === "row"
            ? event.clientY > rect.top + rect.height / 2
            : event.clientX > rect.left + rect.width / 2;
        return {
          cell: cellAt(pos.row, pos.col)!,
          boundary: (dragging.kind === "row" ? pos.row : pos.col) + (after ? 1 : 0),
          after,
        };
      };
      wrap.addEventListener("dragover", (event) => {
        const target = dropTarget(event);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        clearDrop();
        target.cell.classList.add(dragging!.kind === "row" ? "table-drop-row" : "table-drop-column");
        target.cell.dataset.dropAfter = String(target.after);
      });
      wrap.addEventListener("drop", (event) => {
        const target = dropTarget(event);
        if (!target || !dragging) return;
        event.preventDefault();
        event.stopPropagation();
        const drag = dragging;
        dragging = null;
        clearDrop();
        reorder(drag.kind, drag.index, target.boundary);
      });
    }
    if (!view.state.readOnly) {
      alignSelect.addEventListener("change", () => {
        const value = alignSelect.value as "left" | "center" | "right";
        commit(setAlign(typed(), active.col, value === "left" ? null : value), active);
      });
      const sourceButton = editorButton(document.createElement("button"));
      sourceButton.textContent = "Markdown";
      sourceButton.title = "Edit table as Markdown";
      sourceButton.addEventListener("click", () => {
        const start = tableFrom();
        commit(typed());
        view.dispatch({
          effects: editTableSource.of({ from: start, to: start + source.length }),
          selection: { anchor: start },
        });
        view.focus();
      });
      const formatButtons: HTMLButtonElement[] = [];
      for (const [label, command, text] of [
        ["Bold", "bold", "B"],
        ["Italic", "italic", "I"],
        ["Strikethrough", "strikeThrough", "S"],
      ]) {
        const button = editorButton(document.createElement("button"));
        button.textContent = text;
        button.setAttribute("aria-label", label);
        button.title = label;
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => formatCells(command));
        formatButtons.push(button);
      }
      const distribute = editorButton(document.createElement("button"));
      distribute.textContent = "Distribute columns";
      distribute.title = "Give every column the same width";
      distribute.addEventListener("mousedown", (event) => event.preventDefault());
      distribute.addEventListener("click", () => saveWidths(model.header.map(() => 100 / model.header.length)));
      const more = editorButton(document.createElement("button"));
      more.textContent = "⋯";
      more.setAttribute("aria-label", "More table options");
      more.title = "More table options";
      more.addEventListener("mousedown", (event) => event.preventDefault());
      more.addEventListener("click", () => {
        const rect = more.getBoundingClientRect();
        useUi.getState().showMenu(rect.left, rect.bottom, [
          { label: "Automatic column widths", disabled: !widths, action: resetWidths },
          { label: "Copy as Markdown", action: () => void navigator.clipboard?.writeText(source) },
          { label: "", separator: true },
          { label: "Delete table", danger: true, action: deleteTable },
        ]);
      });
      const divider = () => {
        const el = document.createElement("span");
        el.className = "table-toolbar-divider";
        return el;
      };
      toolbar.append(...formatButtons, divider(), alignSelect, distribute, divider(), sourceButton, more);
      cellMenu.addEventListener("mousedown", (event) => event.preventDefault());
      cellMenu.addEventListener("click", () => {
        const rect = cellMenu.getBoundingClientRect();
        useUi.getState().showMenu(rect.left, rect.bottom + 4, cellMenuFor(active.row, active.col));
      });
      inner.append(cellMenu);
      updateToolbar(-1, 0);
    } else toolbar.hidden = true;
    table.addEventListener("copy", (event) => {
      if (!selected || !event.clipboardData) return;
      const rows = cellEls.slice(selected.top + 1, selected.bottom + 2).map((cells) =>
        cells
          .slice(selected!.left, selected!.right + 1)
          .map((cell) => cell.textContent ?? "")
          .join("\t"),
      );
      event.preventDefault();
      event.clipboardData.setData("text/plain", rows.join("\n"));
    });
    table.addEventListener("drop", (event) => {
      if (view.state.readOnly || dragging || !event.dataTransfer) return;
      if (event.dataTransfer.files.length && !treeDragActive()) return;
      const text = treeDragData(event.dataTransfer, "text/plain");
      const cell = (event.target as HTMLElement).closest<HTMLElement>("th,td");
      if (!text || !cell) return;
      event.preventDefault();
      event.stopPropagation();
      focusCell(cell);
      document.execCommand("insertText", false, text);
      cell.dataset.source = cellMarkdown(cell);
      commit(typed());
    });
    table.addEventListener("paste", (e) => {
      if (view.state.readOnly) return;
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      const text = e.clipboardData?.getData("text/plain");
      if (!cell || text === undefined) return;
      e.preventDefault();
      if (!/[\t\r\n]/.test(text.replace(/\r?\n$/, ""))) {
        document.execCommand("insertText", false, text);
        cell.dataset.source = cellMarkdown(cell);
        commit(typed());
        return;
      }
      const { row, col } = posOf(cell);
      updateToolbar(row, col);
      const next = pasteCells(typed(), row, col, text);
      let grown = widths;
      while (grown && grown.length < next.header.length) grown = insertWidth(grown, grown.length);
      commit(next, { row, col }, grown === widths ? undefined : grown);
    });
    wrap.addEventListener("contextmenu", (e) => {
      if (view.state.readOnly) return;
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (!cell) return;
      e.preventDefault();
      const { row, col } = posOf(cell);
      updateToolbar(row, col);
      useUi.getState().showMenu(e.clientX, e.clientY, menuFor(row, col));
    });
    // Table chrome never switches the note to source editing.
    wrap.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("th, td, button, select")) return;
      e.preventDefault();
      focusCell(cellAt(active.row, active.col));
    });
    // Put the caret back after an edit redrew the table: the editor inserts this table in the same
    // task as the edit, so a microtask runs once it's in the page.
    queueMicrotask(() => {
      const f = tableFocus.get(view);
      if (!f || !wrap.isConnected) return;
      // The widget starts at its widths comment, if any, else at the table.
      if ((f.to ?? f.from) < from() || f.from > tableFrom()) return;
      tableFocus.delete(view);
      focusCell(
        cellAt(Math.max(-1, Math.min(f.row, model.rows.length - 1)), Math.min(f.col, model.header.length - 1)),
        f.caret,
      );
      if (f.notice) showNotice(f.notice);
    });
    controllers.set(wrap, {
      update(nextSource, nextWidthsLine) {
        if (nextWidthsLine !== widthsLine) {
          // Only our own widths write is absorbed; an outside change redraws the table.
          if (nextWidthsLine !== pendingWidths || (nextSource !== source && nextSource !== pendingSource)) return false;
          widthsLine = nextWidthsLine;
          pendingWidths = null;
          widths = usableWidths(parseWidths(widthsLine), parseTable(nextSource).header.length);
          if (nextSource === source) {
            applyWidths();
            return true;
          }
        }
        if (structural || nextSource !== pendingSource) return false;
        source = nextSource;
        model = parseTable(source);
        pendingSource = null;
        cellEls.forEach((cells, r) =>
          cells.forEach((cell, c) => {
            const text = (r === 0 ? model.header : model.rows[r - 1])[c];
            if (cell !== preserveCell && cell.dataset.source !== text) {
              cell.dataset.source = text;
              renderCellMarkdown(cell, text);
            }
            cell.style.textAlign = model.align[c] ?? "left";
          }),
        );
        preserveCell = null;
        updateToolbar(active.row, active.col);
        queueMicrotask(applyWidths);
        return true;
      },
      destroy() {
        observer.disconnect();
      },
      focus(pos) {
        const start = tableFrom();
        // A caret on the hidden widths comment line enters the header row.
        if (pos < from() || pos >= start + source.length) return false;
        const lines = source.slice(0, Math.max(0, pos - start)).split("\n");
        const row = lines.length < 3 ? -1 : Math.min(model.rows.length - 1, lines.length - 3);
        focusCell(cellAt(row, 0), "start");
        return true;
      },
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
  destroy(dom: HTMLElement) {
    controllers.get(dom)?.destroy();
    controllers.delete(dom);
  }
}
