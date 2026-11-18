// Dragging items from the file tree out to Finder or the desktop copies them there.
//
// Inside the window a tree drag is the plain HTML5 drag it always was. When it leaves the window,
// the backend adds the items' files to the drag (see src-tauri/src/drag_out.rs: outside the app
// WebKit only offers a copy, so Finder never moves or deletes anything). When it comes back, the
// backend restores the drag as it was. While the files are on it, WebKit only shows a drop target
// "Files", hiding the tree's own data: `isFinderDrag` and `treeDragData` cover that gap, so the app's
// drop targets still see the tree drag.

import { api } from "./ipc/api";

/** Off: tree drags never reach Finder, exactly as before drag-out existed. */
export const DRAG_OUT_TO_FINDER = true;

export interface DragOutBackend {
  attach(paths: string[]): Promise<unknown>;
  /** `false` when the drag pasteboard now belongs to another drag. */
  detach(): Promise<boolean>;
  end(): Promise<unknown>;
}

let backend: DragOutBackend = {
  attach: (paths) => api.dragOutAttach(paths),
  detach: () => api.dragOutDetach(),
  end: () => api.dragOutEnd(),
};

/** For tests. */
export function setDragOutBackend(next: DragOutBackend) {
  backend = next;
}

interface TreeDrag {
  paths: string[];
  /** What the drag start put on the DataTransfer, by type. */
  data: Record<string, string>;
  /** dragenter minus dragleave inside the window: back to 0 means the drag left it. */
  depth: number;
  outside: boolean;
  attached: boolean;
  stop: () => void;
}

let current: TreeDrag | null = null;

// The backend's calls run one after another, in the order the drag made them.
let queue: Promise<unknown> = Promise.resolve();
function call<T>(f: () => Promise<T>): Promise<T | undefined> {
  const next = queue.then(f).catch(() => undefined);
  queue = next;
  return next;
}

const outsideViewport = (ev: DragEvent) =>
  ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;

/** Starts tracking a drag from the tree. `source` is the dragged row. */
export function startTreeDrag(paths: string[], data: Record<string, string>, source?: EventTarget | null) {
  endTreeDrag();
  const drag: TreeDrag = { paths, data, depth: 0, outside: false, attached: false, stop: () => {} };

  const onEnter = () => {
    if (current !== drag) return;
    if (drag.outside) {
      drag.outside = false;
      drag.depth = 1;
      if (drag.attached)
        void call(() => backend.detach()).then((ours) => {
          // Another drag (from Finder, say) took over the pasteboard: this one ended outside
          // without its dragend reaching us. Its drop must import, not move.
          if (ours === false && current === drag) endTreeDrag();
        });
      return;
    }
    drag.depth++;
  };

  const onLeave = (ev: DragEvent) => {
    if (current !== drag || drag.outside) return;
    drag.depth--;
    if (drag.depth > 0 && !outsideViewport(ev)) return;
    drag.outside = true;
    drag.depth = 0;
    if (!DRAG_OUT_TO_FINDER || !paths.length) return;
    drag.attached = true;
    void call(() => backend.attach(paths));
  };

  // A drop's own handlers still see the drag; it ends right after them.
  const onDrop = () => setTimeout(() => current === drag && endTreeDrag());
  const onEnd = () => current === drag && endTreeDrag();
  // Mouse events only come once the drag is over.
  const onMouseMove = (ev: MouseEvent) => ev.buttons === 0 && onEnd();

  const listeners: [EventTarget, string, EventListener][] = [
    [window, "dragenter", onEnter as EventListener],
    [window, "dragleave", onLeave as EventListener],
    [window, "drop", onDrop],
    [window, "dragend", onEnd],
    [window, "pointerdown", onEnd],
    [window, "mousemove", onMouseMove as EventListener],
    // dragend goes to the dragged row, which a refresh may have taken out of the page meanwhile.
    ...(source ? [[source, "dragend", onEnd] as [EventTarget, string, EventListener]] : []),
  ];
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn, true);
  drag.stop = () => {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn, true);
  };
  current = drag;
}

/** The tree drag is over (dropped, cancelled or ended outside the app). */
export function endTreeDrag() {
  const drag = current;
  if (!drag) return;
  current = null;
  drag.stop();
  if (drag.attached) void call(() => backend.end());
}

/** Whether a drag from the tree is in progress. */
export function treeDragActive(): boolean {
  return current !== null;
}

/** `dt.getData(type)`, or what the tree drag put there when the files it carries hide it. */
export function treeDragData(dt: DataTransfer, type: string): string {
  const value = dt.getData(type);
  if (value || !current || !dt.types.includes("Files")) return value;
  return current.data[type] ?? "";
}

/** Resolves once the backend calls made so far have run. For tests. */
export function dragOutSettled(): Promise<unknown> {
  return queue;
}
