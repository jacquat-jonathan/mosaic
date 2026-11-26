// One stack of open overlays (dialogs, menus, popovers) that closes the topmost one on Escape or on a
// press outside it. Every overlay registers here instead of wiring its own document listeners, so a
// dropdown inside a modal, or a confirm dialog over another dialog, closes one layer at a time.

import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export type DismissReason = "escape" | "outside";

type Inside = () => Iterable<Element | null | undefined>;

export type DismissLayer = {
  /** The elements that count as inside: the overlay itself and, for a dropdown, its trigger. */
  inside: Inside;
  /**
   * A modal closes on a whole click outside (press and release), so a drag that ends on the backdrop
   * does not close it, and the click does not fall through to the page. Other layers close as soon
   * as a press starts outside, and that press still reaches what it landed on.
   */
  modal?: boolean;
  /** Whether a press outside closes the layer. When false it still blocks the layers beneath. */
  outside?(): boolean;
  /** Whether Escape closes the layer. When false it still blocks the layers beneath. */
  escape?(): boolean;
  dismiss(reason: DismissReason, event: Event): void;
};

type Entry = DismissLayer & { parent: Entry | null; regions: Set<Inside>; children: Set<Entry> };

const stack: Entry[] = [];
let pressed: Entry | null = null;
let keyTop: Entry | undefined;

const top = () => stack.at(-1);

/** The native modal `<dialog>` is its own ::backdrop: a press on the backdrop targets the dialog. */
function onBackdrop(element: Element, target: Node, event: Event) {
  if (target !== element || !(element instanceof HTMLDialogElement) || !("clientX" in event)) return false;
  const { clientX: x, clientY: y } = event as MouseEvent;
  const r = element.getBoundingClientRect();
  return x < r.left || x >= r.right || y < r.top || y >= r.bottom;
}

function contains(layer: Entry, target: Node, event: Event): boolean {
  for (const element of layer.inside())
    if (element?.contains(target) && !onBackdrop(element, target, event)) return true;
  for (const region of layer.regions) for (const element of region()) if (element?.contains(target)) return true;
  for (const child of layer.children) if (contains(child, target, event)) return true;
  return false;
}

function targetOf(event: Event) {
  return event.target instanceof Node ? event.target : null;
}

function onPointerDown(event: PointerEvent) {
  pressed = null;
  const layer = top(),
    target = targetOf(event);
  if (!layer || !target || contains(layer, target, event)) return;
  if (layer.modal) pressed = layer;
  else if (layer.outside?.() ?? true) layer.dismiss("outside", event);
}

// The click that ends a press comes in the same task as its pointerup. Forget the press after that,
// so a press that produced no click (a drag, WebKit) is not paired with a later scripted click.
function onPointerUp() {
  const press = pressed;
  setTimeout(() => {
    if (pressed === press) pressed = null;
  });
}

function forgetPress() {
  pressed = null;
}

function onClick(event: MouseEvent) {
  const layer = pressed,
    target = targetOf(event);
  pressed = null;
  // A click whose target was removed while the press was handled cannot be placed, so it never closes.
  if (!layer || layer !== top() || !target?.isConnected || contains(layer, target, event)) return;
  if (layer.outside?.() ?? true) {
    event.preventDefault();
    event.stopPropagation();
    layer.dismiss("outside", event);
  }
}

/** Closes the topmost layer for an Escape no inner handler took. True when the key was used. */
function closeOnEscape(event: KeyboardEvent) {
  const layer = top();
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !layer) return false;
  // Something inside already handled this Escape by closing a layer: one Escape closes one layer.
  if (layer !== keyTop) return false;
  const enabled = layer.escape?.() ?? true;
  if (!enabled && !layer.modal) return false;
  // Prevented either way, so a native modal `<dialog>` beneath never sees a cancel.
  event.preventDefault();
  if (enabled) layer.dismiss("escape", event);
  return true;
}

function onKeyDownCapture(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  keyTop = top();
  const target = targetOf(event);
  // Focus is outside the topmost layer (a menu that didn't take focus, a palette left open while
  // editing the canvas): nothing inside it can want the key, so it closes before anything else acts.
  if (keyTop && target && !contains(keyTop, target, event) && closeOnEscape(event)) event.stopPropagation();
}

/**
 * An overlay's root `onKeyDown`: Escape closes the topmost layer before React ancestors (a panel,
 * the canvas) see the key. The document listener only covers focus outside every layer.
 */
export function dismissOnEscape(event: ReactKeyboardEvent) {
  if (closeOnEscape(event.nativeEvent)) event.stopPropagation();
}

function listen(on: boolean) {
  const listeners = [
    ["pointerdown", onPointerDown, true],
    ["pointerup", onPointerUp, true],
    ["pointercancel", forgetPress, true],
    ["dragstart", forgetPress, true],
    ["click", onClick, true],
    ["keydown", onKeyDownCapture, true],
    ["keydown", closeOnEscape, false],
  ] as const;
  for (const [type, listener, capture] of listeners)
    if (on) document.addEventListener(type, listener as EventListener, capture);
    else document.removeEventListener(type, listener as EventListener, capture);
}

function isAncestor(ancestor: Entry, layer: Entry | null): boolean {
  for (let node = layer; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

function push(entry: Entry) {
  if (!stack.length) listen(true);
  // A parent that registers after its child (effects run child first) still goes beneath it.
  const index = stack.findIndex((layer) => isAncestor(entry, layer.parent));
  stack.splice(index < 0 ? stack.length : index, 0, entry);
  entry.parent?.children.add(entry);
  return () => {
    const at = stack.indexOf(entry);
    if (at >= 0) stack.splice(at, 1);
    entry.parent?.children.delete(entry);
    if (pressed === entry) pressed = null;
    if (!stack.length) listen(false);
  };
}

/** Registers a layer from code outside React; returns the function that removes it. */
export function openDismissLayer(layer: DismissLayer): () => void {
  return push({ ...layer, parent: null, regions: new Set(), children: new Set() });
}

const Parent = createContext<Entry | null>(null);

/**
 * Keeps an overlay on the dismiss stack while `open`. Wrap its content in `<DismissScope layer={…}>`
 * so overlays and portalled regions opened from inside it count as inside.
 */
export function useDismissLayer({
  open,
  inside,
  onDismiss,
  modal = false,
  outside = true,
  escape: escapes = true,
}: {
  open: boolean;
  inside: Inside;
  onDismiss(reason: DismissReason, event: Event): void;
  modal?: boolean;
  outside?: boolean;
  escape?: boolean;
}) {
  const parent = useContext(Parent);
  const latest = useRef({ inside, onDismiss, outside, escapes });
  latest.current = { inside, onDismiss, outside, escapes };
  const [entry] = useState<Entry>(() => ({
    parent: null,
    regions: new Set(),
    children: new Set(),
    inside: () => latest.current.inside(),
    outside: () => latest.current.outside,
    escape: () => latest.current.escapes,
    dismiss: (reason, event) => latest.current.onDismiss(reason, event),
  }));
  useEffect(() => {
    if (!open) return;
    entry.parent = parent;
    entry.modal = modal;
    return push(entry);
  }, [open, parent, modal, entry]);
  return entry as DismissLayer;
}

export function DismissScope({ layer, children }: { layer: DismissLayer; children: ReactNode }) {
  return <Parent.Provider value={layer as Entry}>{children}</Parent.Provider>;
}

/** Content portalled out of an overlay's DOM (a menu, a date picker) that still counts as inside it. */
export function useDismissRegion(ref: RefObject<Element | null>) {
  const parent = useContext(Parent);
  useEffect(() => {
    if (!parent) return;
    const region = () => [ref.current];
    parent.regions.add(region);
    return () => {
      parent.regions.delete(region);
    };
  }, [parent, ref]);
}

/** Whether `layer` is the one Escape or a press outside would close now. */
export function isTopDismissLayer(layer: DismissLayer) {
  return top() === layer;
}
