// The `+` and drag handle beside every block (Confluence-style). One floating pair of buttons
// follows the pointer from block to block, so the note's lines never shift to make room for it and
// it works beside rendered widgets (tables, diagrams, images) as well as beside text.
//
// - `+` adds a block below: a new paragraph that opens the slash menu (dismissing the menu takes the
//   paragraph away again), or a new item for a list item.
// - The handle drags the block (a heading with its section, a list item with its nested items) to
//   another place among its siblings; ArrowUp/ArrowDown on the focused handle, or Ctrl+Shift+Arrow
//   in the text, move it one place. Every move is one undo step.

import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { type EditorState, type Extension, StateEffect, Transaction } from "@codemirror/state";
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type Block, blockAt, blockRanges, insertionAfter, moveBlock, siblingsOf, stepGap } from "./blockRanges";
import { editorButton, editorScope } from "./designSystemDom";
import { textChanges } from "./textDiff";
import "./editorControls.css";

const BLOCK_MIME = "application/x-mosaic-block";
const HIDE_DELAY = 250;

/** Applies a move as the smallest change, as one undo step, with the caret `offset` into the moved block. */
function applyMove(view: EditorView, source: Block, gap: number, offset = 0): number | null {
  const text = view.state.doc.toString();
  const blocks = blockRanges(view.state);
  const move = moveBlock(text, blocks, source, gap);
  if (!move) return null;
  view.dispatch({
    changes: textChanges(text, move.text),
    selection: { anchor: Math.min(move.focus + offset, move.text.length) },
    scrollIntoView: true,
    userEvent: "move.block",
    annotations: isolateHistory.of("full"),
  });
  return move.focus;
}

/** Marks the paragraph a `+` added for the slash menu (from, to in the new document). */
const slashInserted = StateEffect.define<{ from: number; to: number; insert: string }>();

/** What the `+` beside `block` does: adds the block below and, for a paragraph, opens the slash menu. */
export function addBelow(view: EditorView, block: Block) {
  const ins = insertionAfter(view.state.doc, blockRanges(view.state), block);
  view.dispatch({
    changes: { from: ins.from, insert: ins.insert },
    selection: { anchor: ins.caret },
    scrollIntoView: true,
    userEvent: "input.type",
    annotations: isolateHistory.of("full"),
    effects: ins.slash
      ? slashInserted.of({ from: ins.from, to: ins.from + ins.insert.length, insert: ins.insert })
      : [],
  });
  view.focus();
  if (ins.slash) startCompletion(view);
}

/** Moves the block at the caret one place up or down among its siblings. */
export function moveBlockAtCaret(direction: -1 | 1) {
  return (view: EditorView) => {
    if (view.state.readOnly) return false;
    const head = view.state.selection.main.head;
    const blocks = blockRanges(view.state);
    const block = blockAt(blocks, head);
    if (!block) return false;
    const gap = stepGap(siblingsOf(blocks, block), direction);
    if (gap !== null) applyMove(view, block, gap, head - block.from);
    return true;
  };
}

class BlockHandles {
  private blocks: Block[] | null = null;
  private readonly overlay: HTMLElement;
  private readonly add: HTMLButtonElement;
  private readonly handle: HTMLButtonElement;
  private readonly dropLine: HTMLElement;
  private current: Block | null = null;
  private hideTimer: number | null = null;
  private dragging: Block | null = null;
  private dropGap: number | null = null;
  /** The paragraph a `+` just added for the slash menu, removed again if the menu is dismissed. */
  private slash: { from: number; to: number; insert: string; opened: boolean } | null = null;

  constructor(readonly view: EditorView) {
    this.overlay = editorScope(document.createElement("div"));
    this.overlay.className += " cm-block-actions";
    this.overlay.hidden = true;
    this.add = editorButton(document.createElement("button"));
    this.add.classList.add("cm-block-add");
    this.add.textContent = "+";
    this.add.title = "Add a block below";
    this.add.setAttribute("aria-label", "Add a block below");
    this.handle = editorButton(document.createElement("button"));
    this.handle.classList.add("cm-block-handle");
    this.handle.draggable = true;
    this.handle.title = "Drag to move. Click to select. Arrow keys move it.";
    this.handle.setAttribute("aria-label", "Move block");
    this.overlay.append(this.add, this.handle);
    this.dropLine = document.createElement("div");
    this.dropLine.className = "cm-block-drop";
    this.dropLine.hidden = true;
    view.scrollDOM.append(this.overlay, this.dropLine);

    view.scrollDOM.addEventListener("mousemove", this.onMouseMove);
    view.scrollDOM.addEventListener("mouseleave", this.onMouseLeave);
    this.overlay.addEventListener("mouseenter", this.cancelHide);
    this.add.addEventListener("mousedown", this.keepFocus);
    this.add.addEventListener("click", this.onAdd);
    this.handle.addEventListener("click", this.onSelect);
    this.handle.addEventListener("keydown", this.onHandleKey);
    this.handle.addEventListener("dragstart", this.onDragStart);
    this.handle.addEventListener("dragend", this.finishDrag);
    this.handle.addEventListener("blur", this.onBlur);
    view.dom.addEventListener("dragover", this.onDragOver, true);
    view.dom.addEventListener("drop", this.onDrop, true);
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      this.blocks = null;
      if (this.current) {
        const from = update.changes.mapPos(this.current.from, 1);
        this.current = this.allBlocks().find((b) => b.from === from) ?? null;
        if (!this.current && !this.dragging) this.hide();
      }
    }
    if (update.state.readOnly) this.hide();
    else if (this.current && (update.docChanged || update.geometryChanged || update.viewportChanged))
      this.view.requestMeasure({ read: () => this.place() });
    this.trackSlash(update);
  }

  destroy() {
    this.cancelHide();
    this.overlay.remove();
    this.dropLine.remove();
    this.view.scrollDOM.removeEventListener("mousemove", this.onMouseMove);
    this.view.scrollDOM.removeEventListener("mouseleave", this.onMouseLeave);
    this.view.dom.removeEventListener("dragover", this.onDragOver, true);
    this.view.dom.removeEventListener("drop", this.onDrop, true);
  }

  private allBlocks(): Block[] {
    this.blocks ??= blockRanges(this.view.state);
    return this.blocks;
  }

  /** Left edge of the note text, in client coordinates. */
  private textLeft(): number {
    const content = this.view.contentDOM;
    const padding = Number.parseFloat(getComputedStyle(content).paddingLeft) || 0;
    return content.getBoundingClientRect().left + padding;
  }

  private show(block: Block) {
    this.cancelHide();
    if (this.current?.from !== block.from || this.current.to !== block.to) {
      this.current = block;
      this.handle.setAttribute("aria-label", block.heading ? "Move section" : "Move block");
    }
    this.place();
  }

  /** Puts the buttons beside the current block's first line. */
  private place() {
    const block = this.current;
    if (!block) return;
    const view = this.view;
    const scroller = view.scrollDOM.getBoundingClientRect();
    const line = view.state.doc.lineAt(block.from);
    const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
    const at = view.coordsAtPos(line.from + indent, 1);
    const lineTop = view.lineBlockAt(block.from).top + view.documentTop;
    const top = at ? (at.top + at.bottom) / 2 - 12 : lineTop + 4;
    const left = (at && indent ? at.left : this.textLeft()) - 48;
    this.overlay.style.top = `${top - scroller.top + view.scrollDOM.scrollTop}px`;
    this.overlay.style.left = `${left - scroller.left + view.scrollDOM.scrollLeft}px`;
    this.overlay.hidden = false;
  }

  private hide = () => {
    this.cancelHide();
    if (this.dragging || this.overlay.contains(document.activeElement)) return;
    this.overlay.hidden = true;
    this.current = null;
  };

  private cancelHide = () => {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  };

  private hideSoon() {
    if (this.hideTimer === null) this.hideTimer = window.setTimeout(this.hide, HIDE_DELAY);
  }

  private onMouseMove = (event: MouseEvent) => {
    if (this.dragging || this.view.state.readOnly) return;
    if (this.overlay.contains(event.target as Node)) return this.cancelHide();
    const content = this.view.contentDOM.getBoundingClientRect();
    if (event.clientY < content.top || event.clientY > content.bottom) return this.hideSoon();
    // Anywhere on the row, gutter included, belongs to the block on that row.
    const x = Math.max(this.textLeft() + 1, Math.min(event.clientX, content.right - 1));
    const pos = this.view.posAtCoords({ x, y: event.clientY }, false);
    const block = blockAt(this.allBlocks(), pos);
    if (block) this.show(block);
    else this.hideSoon();
  };

  private onMouseLeave = (event: MouseEvent) => {
    if (!this.overlay.contains(event.relatedTarget as Node | null)) this.hideSoon();
  };

  private onBlur = () => this.hideSoon();

  private keepFocus = (event: MouseEvent) => event.preventDefault();

  private onAdd = (event: MouseEvent) => {
    event.preventDefault();
    const block = this.current;
    if (!block || this.view.state.readOnly) return;
    this.hide();
    addBelow(this.view, block);
  };

  /** Takes the `+` paragraph away again when its slash menu closes with nothing chosen. */
  private trackSlash(update: ViewUpdate) {
    for (const tr of update.transactions)
      for (const effect of tr.effects)
        if (effect.is(slashInserted)) {
          this.slash = { ...effect.value, opened: false };
          return;
        }
    const slash = this.slash;
    if (!slash) return;
    if (update.docChanged) {
      slash.from = update.changes.mapPos(slash.from, 1);
      slash.to = update.changes.mapPos(slash.to, -1);
    }
    if (completionStatus(update.state) !== null) {
      slash.opened = true;
      return;
    }
    // Typed into before the menu ever opened: the paragraph is the user's now.
    if (!slash.opened) {
      if (update.docChanged) this.slash = null;
      return;
    }
    this.slash = null;
    // Still just the bare slash on its own line: nothing was chosen or typed.
    const untouched = (state: EditorState) =>
      state.sliceDoc(slash.from, slash.to) === slash.insert && state.doc.lineAt(slash.from + 2).text === "/";
    if (!untouched(update.state)) return;
    queueMicrotask(() => {
      if (!untouched(this.view.state)) return;
      this.view.dispatch({
        changes: { from: slash.from, to: slash.to },
        annotations: Transaction.addToHistory.of(false),
      });
    });
  }

  private onSelect = (event: MouseEvent) => {
    event.preventDefault();
    const block = this.current;
    if (!block) return;
    this.view.dispatch({ selection: { anchor: block.from, head: block.to }, scrollIntoView: true });
    this.view.focus();
  };

  private onHandleKey = (event: KeyboardEvent) => {
    const block = this.current;
    if (!block) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.view.focus();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const gap = stepGap(siblingsOf(this.allBlocks(), block), event.key === "ArrowUp" ? -1 : 1);
    if (gap === null) return;
    const focus = applyMove(this.view, block, gap);
    if (focus === null) return;
    const moved = this.allBlocks().find((b) => b.from === focus);
    if (moved) this.show(moved);
    this.handle.focus();
  };

  private onDragStart = (event: DragEvent) => {
    const block = this.current;
    if (!block || !event.dataTransfer || this.view.state.readOnly) return event.preventDefault();
    this.dragging = block;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(BLOCK_MIME, String(block.from));
    this.view.dom.classList.add("cm-block-dragging");
    // A translucent copy of the block follows the pointer.
    const source = this.view.domAtPos(block.from).node;
    const element = (source instanceof HTMLElement ? source : source.parentElement)?.closest(
      ".cm-line, .cm-table-wrap, .cm-rendered-block",
    );
    if (element && event.dataTransfer.setDragImage) {
      const ghost = document.createElement("div");
      ghost.className = "cm-block-ghost md-editor";
      ghost.style.width = `${element.getBoundingClientRect().width}px`;
      ghost.append(element.cloneNode(true));
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, 16, 12);
      requestAnimationFrame(() => ghost.remove());
    }
  };

  /** The gap nearest the pointer, or null when that's the block's own place. */
  private gapAt(clientY: number): { gap: number; y: number } | null {
    const block = this.dragging;
    if (!block) return null;
    const { units, gaps } = siblingsOf(this.allBlocks(), block);
    const view = this.view;
    const y = clientY - view.documentTop;
    let best: { gap: number; y: number; distance: number } | null = null;
    for (let k = 0; k <= units.length; k++) {
      const above = k > 0 ? view.lineBlockAt(units[k - 1].to).bottom : null;
      const below = k < units.length ? view.lineBlockAt(units[k].from).top : null;
      const at = above === null ? below! : below === null ? above : (above + below) / 2;
      const distance = Math.abs(y - at);
      if (!best || distance < best.distance) best = { gap: k, y: at, distance };
    }
    return best && gaps[best.gap] ? { gap: best.gap, y: best.y } : null;
  }

  private onDragOver = (event: DragEvent) => {
    if (!this.dragging || !event.dataTransfer?.types.includes(BLOCK_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = this.gapAt(event.clientY);
    this.dropGap = target?.gap ?? null;
    event.dataTransfer.dropEffect = target ? "move" : "none";
    if (!target) {
      this.dropLine.hidden = true;
      return;
    }
    const scroller = this.view.scrollDOM.getBoundingClientRect();
    const content = this.view.contentDOM.getBoundingClientRect();
    const left = Number.parseFloat(this.overlay.style.left) + 48;
    this.dropLine.style.top = `${target.y + this.view.documentTop - scroller.top + this.view.scrollDOM.scrollTop - 1}px`;
    this.dropLine.style.left = `${left}px`;
    this.dropLine.style.width = `${Math.max(40, content.right - scroller.left - left - this.padRight())}px`;
    this.dropLine.hidden = false;
  };

  private padRight() {
    return Number.parseFloat(getComputedStyle(this.view.contentDOM).paddingRight) || 0;
  }

  private onDrop = (event: DragEvent) => {
    if (!this.dragging || !event.dataTransfer?.types.includes(BLOCK_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const block = this.dragging;
    const gap = this.dropGap;
    this.finishDrag();
    if (gap === null) return;
    const focus = applyMove(this.view, block, gap);
    if (focus !== null) this.view.focus();
  };

  private finishDrag = () => {
    this.dragging = null;
    this.dropGap = null;
    this.dropLine.hidden = true;
    this.view.dom.classList.remove("cm-block-dragging");
    this.hideSoon();
  };
}

export const blockHandles: Extension = [
  ViewPlugin.fromClass(BlockHandles),
  keymap.of([
    { key: "Ctrl-Shift-ArrowUp", run: moveBlockAtCaret(-1), preventDefault: true },
    { key: "Ctrl-Shift-ArrowDown", run: moveBlockAtCaret(1), preventDefault: true },
  ]),
];
