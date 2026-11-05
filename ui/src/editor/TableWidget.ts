import { type EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { Transaction } from "@codemirror/state";
import { undo, redo, isolateHistory } from "@codemirror/commands";
import { useVault } from "../state/vault";
import { useUi, type MenuItem } from "../state/ui";
import { editorContext } from "./context";
import { MIN_COLUMN_WIDTH, resizeTableColumn, loadTableWidths, saveTableWidths, tableWidthKey } from "./tableWidths";
import {
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumn,
  insertRow,
  parseTable,
  pasteCells,
  setAlign,
  setCell,
  moveRow,
  moveColumn,
  type TableModel,
} from "./tableEdit";
import { cellMarkdown, renderCellMarkdown } from "./tableCell";
import { editTableSource } from "./tableSource";
import { editorScope, editorButton } from "./designSystemDom";
import "./editorControls.css";

const tableFocus = new WeakMap<EditorView, { from: number; row: number; col: number; caret?: "start" | "end" }>();
const controllers = new WeakMap<
  HTMLElement,
  { update(source: string): boolean; destroy(): void; focus(pos: number): boolean }
>();

/** Keyboard navigation into a rendered table enters its cell editor instead of revealing pipes. */
export function focusTableAtSelection(view: EditorView) {
  if (!view.hasFocus || (document.activeElement as HTMLElement | null)?.closest(".cm-table-wrap")) return;
  for (const dom of view.dom.querySelectorAll<HTMLElement>(".cm-table-wrap"))
    if (controllers.get(dom)?.focus(view.state.selection.main.head)) break;
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  updateDOM(dom: HTMLElement) {
    return controllers.get(dom)?.update(this.source) ?? false;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    let source = this.source;
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
    const tableLabel = document.createElement("span");
    tableLabel.className = "table-toolbar-label";
    tableLabel.textContent = "Table";
    const position = document.createElement("span");
    position.className = "table-position";
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
      position.textContent = `${row < 0 ? "Header" : `Row ${row + 1}`} · Column ${col + 1}`;
      alignSelect.value = model.align[col] ?? "left";
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
    wrap.append(toolbar, scroll);

    const from = () => view.posAtDOM(wrap);
    let widths: number[] | null = null;
    let widthKey = "";
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
      if (!widths) return;
      const current = widths;
      table.classList.add("resized");
      table.style.width = `${current.reduce((a, b) => a + b, 0)}px`;
      [...colgroup.children].forEach((col, i) => {
        (col as HTMLElement).style.width = `${current[i]}px`;
      });
      handles.forEach((handle, i) => {
        handle.setAttribute("aria-valuenow", String(Math.round(current[i])));
        handle.setAttribute("aria-valuetext", `${Math.round(current[i])} pixels`);
      });
      positionHandles();
    };
    const naturalWidths = () => {
      table.classList.remove("resized");
      table.style.width = "max-content";
      [...colgroup.children].forEach((col) => {
        (col as HTMLElement).style.width = "";
      });
      return cellEls[0].map((cell) => Math.max(MIN_COLUMN_WIDTH, cell.getBoundingClientRect().width));
    };
    const resetWidths = () => {
      widths = naturalWidths();
      saveTableWidths(widthKey, widths);
      applyWidths();
    };
    const currentWidths = () => (widths ??= naturalWidths());
    if (!view.state.readOnly)
      model.header.forEach((_, col) => {
        const handle = document.createElement("button");
        handle.className = "table-resize";
        handle.setAttribute("aria-label", `Resize column ${col + 1}`);
        handle.title = "Drag to resize · Arrow keys adjust · Double-click to reset widths";
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-valuemin", "64");
        handle.setAttribute("aria-valuemax", String(Number.MAX_SAFE_INTEGER));
        let startX = 0,
          startWidths: number[] = [],
          dragging = false;
        handle.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startX = e.clientX;
          startWidths = [...currentWidths()];
          dragging = true;
          handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener("pointermove", (e) => {
          if (!dragging) return;
          widths = resizeTableColumn(startWidths, col, e.clientX - startX);
          applyWidths();
        });
        const finish = () => {
          if (dragging) {
            dragging = false;
            saveTableWidths(widthKey, widths);
          }
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
          widths = resizeTableColumn(currentWidths(), col, (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 40 : 10));
          saveTableWidths(widthKey, widths);
          applyWidths();
        });
        handles.push(handle);
        inner.append(handle);
      });
    const observer = new ResizeObserver(applyWidths);
    observer.observe(wrap);
    queueMicrotask(() => {
      if (!wrap.isConnected) return;
      let ordinal = 0;
      syntaxTree(view.state).iterate({
        to: from(),
        enter(node) {
          if (node.name === "Table" && node.from < from()) ordinal++;
        },
      });
      widthKey = tableWidthKey(useVault.getState().vault?.root ?? "", view.state.facet(editorContext).path, ordinal);
      widths = loadTableWidths(widthKey, model.header.length) ?? naturalWidths();
      saveTableWidths(widthKey, widths);
      applyWidths();
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
    const resizeColumns = (at: number, insert: boolean) => {
      if (!widths) return;
      if (insert) widths.splice(at, 0, 160);
      else widths.splice(at, 1);
      saveTableWidths(widthKey, widths);
    };
    const unchanged = (t: TableModel) => JSON.stringify(t) === JSON.stringify(model);
    // Structural changes redraw the table; text edits retain the live DOM and caret.
    let replaced = false;
    /** Writes to the note and preserves the live cell, restoring focus after a structural redraw. */
    const commit = (next: TableModel, focus?: { row: number; col: number }) => {
      if (view.state.readOnly || replaced || !wrap.isConnected) return;
      if (unchanged(next)) {
        if (focus) focusCell(cellAt(focus.row, focus.col));
        return;
      }
      const start = from();
      structural = next.header.length !== model.header.length || next.rows.length !== model.rows.length;
      const insert = formatTable(next);
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
      if (focus) tableFocus.set(view, { from: start, ...focus });
      else tableFocus.delete(view);
      view.dispatch({
        changes: { from: start, to: start + source.length, insert },
        annotations: [
          Transaction.userEvent.of(focus ? "input.table" : "input.type"),
          ...(focus ? [isolateHistory.of("full")] : []),
        ],
      });
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
      } else if (e.key === "Tab") {
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
        const length = unchanged(t) ? source.length : formatTable(t).length;
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
          action: () => {
            resizeColumns(col, true);
            commit(insertColumn(t(), col), at({ row, col }));
          },
        },
        {
          label: "Insert column right",
          action: () => {
            resizeColumns(col + 1, true);
            commit(insertColumn(t(), col + 1), at({ row, col: col + 1 }));
          },
        },
        {
          label: "Delete column",
          disabled: model.header.length <= 1,
          danger: true,
          action: () => {
            resizeColumns(col, false);
            commit(deleteColumn(t(), col), { row, col: Math.min(col, model.header.length - 2) });
          },
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
            const start = from();
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
      if (kind === "column" && widths) {
        const [width] = widths.splice(index, 1);
        widths.splice(destination, 0, width);
        saveTableWidths(widthKey, widths);
      }
      commit(next, kind === "row" ? { row: destination, col: active.col } : { row: active.row, col: destination });
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
          if (kind === "column") resizeColumns(index, true);
          commit(
            kind === "row" ? insertRow(typed(), index) : insertColumn(typed(), index),
            kind === "row" ? { row: index, col: active.col } : { row: active.row, col: index },
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
        const start = from();
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
      toolbar.append(tableLabel, position, ...formatButtons, alignSelect, sourceButton);
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
      if (view.state.readOnly || dragging || !event.dataTransfer || event.dataTransfer.files.length) return;
      const text = event.dataTransfer.getData("text/plain");
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
      while (widths && widths.length < next.header.length) resizeColumns(widths.length, true);
      commit(next, { row, col });
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
      if (!f || !wrap.isConnected || from() !== f.from) return;
      tableFocus.delete(view);
      focusCell(
        cellAt(Math.max(-1, Math.min(f.row, model.rows.length - 1)), Math.min(f.col, model.header.length - 1)),
        f.caret,
      );
    });
    controllers.set(wrap, {
      update(nextSource) {
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
        const start = from();
        if (pos < start || pos >= start + source.length) return false;
        const lines = source.slice(0, pos - start).split("\n");
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
