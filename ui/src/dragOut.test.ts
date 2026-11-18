// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dragOutSettled, endTreeDrag, setDragOutBackend, startTreeDrag, treeDragActive, treeDragData } from "./dragOut";
import { isFinderDrag } from "./actions";

const TREE = "application/x-mosaic-path";

function backend(detached = true) {
  const calls: string[] = [];
  const b = {
    calls,
    attach: vi.fn(async (paths: string[]) => void calls.push(`attach ${paths.join(",")}`)),
    detach: vi.fn(async () => (calls.push("detach"), detached)),
    end: vi.fn(async () => void calls.push("end")),
  };
  setDragOutBackend(b);
  return b;
}

const fire = (target: EventTarget, type: string, init: { clientX?: number; clientY?: number } = {}) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: init.clientX ?? 10, clientY: init.clientY ?? 10 });
  target.dispatchEvent(ev);
};

const transfer = (types: string[], data: Record<string, string> = {}) =>
  ({ types, getData: (t: string) => data[t] ?? "" }) as unknown as DataTransfer;

let row: HTMLElement, other: HTMLElement, editor: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="row"></div><div id="other"></div><div id="editor"></div>';
  [row, other, editor] = ["row", "other", "editor"].map((id) => document.getElementById(id)!);
});
afterEach(() => endTreeDrag());

/** Starts a drag on `row` as WebKit does: dragstart, then dragenter on the row itself. */
function start(paths = ["Notes/a.md", "Notes/Sub"]) {
  startTreeDrag(paths, { [TREE]: JSON.stringify(paths), "text/plain": "[[a]]\nNotes/Sub" }, row);
  fire(row, "dragenter");
}

/** Moving onto another element: dragenter on the new one, then dragleave on the old one. */
const move = (from: Element, to: Element) => (fire(to, "dragenter"), fire(from, "dragleave"));

describe("drag-out to Finder", () => {
  it("never attaches while the drag stays in the window", async () => {
    const b = backend();
    start();
    move(row, other);
    move(other, editor);
    move(editor, row);
    await dragOutSettled();
    expect(b.calls).toEqual([]);
    expect(treeDragActive()).toBe(true);
    fire(row, "dragend");
    await dragOutSettled();
    expect(treeDragActive()).toBe(false);
    expect(b.calls).toEqual([]);
  });

  it("attaches the files once the drag leaves, restores them when it's back, forgets them at the end", async () => {
    const b = backend();
    start();
    move(row, other);
    fire(other, "dragleave"); // out of the window
    fire(document.body, "dragleave"); // a stray leave while outside changes nothing
    await dragOutSettled();
    expect(b.calls).toEqual(["attach Notes/a.md,Notes/Sub"]);

    fire(editor, "dragenter"); // back in
    move(editor, other);
    await dragOutSettled();
    expect(b.calls).toEqual(["attach Notes/a.md,Notes/Sub", "detach"]);
    expect(treeDragActive()).toBe(true);

    fire(other, "dragleave");
    fire(row, "dragend"); // dropped in Finder
    await dragOutSettled();
    expect(b.calls).toEqual(["attach Notes/a.md,Notes/Sub", "detach", "attach Notes/a.md,Notes/Sub", "end"]);
    expect(treeDragActive()).toBe(false);
  });

  it("treats a leave reported outside the viewport as leaving the window", async () => {
    const b = backend();
    start();
    fire(other, "dragenter"); // a missed dragleave would keep the count above 0
    fire(row, "dragleave", { clientX: -3, clientY: 40 });
    await dragOutSettled();
    expect(b.attach).toHaveBeenCalledOnce();
  });

  it("runs the backend calls in the order the drag made them, even when one is slow", async () => {
    const calls: string[] = [];
    let release!: () => void;
    setDragOutBackend({
      attach: () => new Promise<void>((ok) => (release = () => (calls.push("attach"), ok()))),
      detach: async () => (calls.push("detach"), true),
      end: async () => void calls.push("end"),
    });
    start();
    fire(row, "dragleave");
    fire(row, "dragenter");
    endTreeDrag();
    await Promise.resolve();
    expect(calls).toEqual([]);
    release();
    await dragOutSettled();
    expect(calls).toEqual(["attach", "detach", "end"]);
  });

  it("ends the drag when its pasteboard turns out to belong to another drag", async () => {
    backend(false);
    start();
    fire(row, "dragleave");
    fire(row, "dragenter");
    await dragOutSettled();
    await dragOutSettled();
    expect(treeDragActive()).toBe(false);
  });

  it("ends on the dragged row's own dragend even once the row left the page", () => {
    backend();
    start();
    row.remove();
    row.dispatchEvent(new Event("dragend"));
    expect(treeDragActive()).toBe(false);
  });

  it("ends on the first mouse use after the drag, whatever happened to its dragend", () => {
    backend();
    start();
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 1 }));
    expect(treeDragActive()).toBe(true);
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 }));
    expect(treeDragActive()).toBe(false);
    start();
    window.dispatchEvent(new Event("pointerdown"));
    expect(treeDragActive()).toBe(false);
  });

  it("ends right after a drop's own handlers ran", async () => {
    vi.useFakeTimers();
    try {
      backend();
      start();
      let seen: boolean | null = null;
      editor.addEventListener("drop", () => (seen = treeDragActive()));
      fire(editor, "drop");
      expect(seen).toBe(true);
      vi.runAllTimers();
      expect(treeDragActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives drop targets the tree's data while the files it carries hide it, and is never a Finder drop", () => {
    backend();
    const returning = transfer(["Files"]);
    expect(isFinderDrag(returning)).toBe(true);
    expect(treeDragData(returning, "text/plain")).toBe("");
    start();
    expect(isFinderDrag(returning)).toBe(false);
    expect(treeDragData(returning, "text/plain")).toBe("[[a]]\nNotes/Sub");
    expect(treeDragData(returning, TREE)).toBe(JSON.stringify(["Notes/a.md", "Notes/Sub"]));
    // A drag that shows its own data is read as it is.
    expect(treeDragData(transfer(["text/plain"], { "text/plain": "own" }), "text/plain")).toBe("own");
    expect(treeDragData(transfer(["text/plain"]), TREE)).toBe("");
  });

  it("stops listening once the drag is over", async () => {
    const b = backend();
    start();
    endTreeDrag();
    fire(row, "dragleave");
    await dragOutSettled();
    expect(b.attach).not.toHaveBeenCalled();
    expect(b.end).not.toHaveBeenCalled(); // nothing was attached: nothing to forget
  });
});
