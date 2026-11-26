// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { Button, Dialog, MenuButton } from "./components";
import { DismissScope, openDismissLayer, useDismissLayer, useDismissRegion } from "./dismiss";
import { CalendarChooser } from "./planning";

afterEach(cleanup);

/** A full click: press and release on the same element. */
const click = (element: Element) => {
  fireEvent.pointerDown(element);
  fireEvent.pointerUp(element);
  fireEvent.click(element);
};
const pressEscape = (element: Element = document.activeElement ?? document.body) =>
  fireEvent.keyDown(element, { key: "Escape" });
// jsdom has no showModal, so Dialog renders its fallback backdrop around the dialog.
const backdrop = (dialog: HTMLElement) => dialog.closest(".mds-dialog-fallback-backdrop")!;
const dialogNamed = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("dialog")].find((node) => node.textContent?.includes(name))!;

test("a menu closes on a press outside that still reaches its target, and its trigger toggles it", () => {
  const outsidePress = vi.fn();
  render(
    <>
      <button type="button" onPointerDown={outsidePress}>
        Elsewhere
      </button>
      <MenuButton label="Export" items={[{ id: "csv", label: "CSV", onSelect: () => {} }]} />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Export" });
  click(trigger);
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole("menuitem", { name: "CSV" }));
  expect(screen.getByRole("menu")).toBeTruthy();

  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(outsidePress).toHaveBeenCalledOnce();

  click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("menu")).toBeNull();

  click(trigger);
  pressEscape();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("a checkbox dropdown stays open while its items toggle", () => {
  const change = vi.fn();
  render(
    <CalendarChooser
      layers={[{ id: "events", label: "Local events", visible: true }]}
      onVisibilityChange={change}
      actions={<Button>Manage subscriptions…</Button>}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Calendars" });
  click(trigger);
  click(screen.getByRole("checkbox", { name: "Local events" }));
  expect(change).toHaveBeenCalledWith("events", false);
  expect(screen.getByRole("group", { name: "Calendars" })).toBeTruthy();

  pressEscape(screen.getByRole("checkbox", { name: "Local events" }));
  expect(screen.queryByRole("group", { name: "Calendars" })).toBeNull();
  expect(document.activeElement).toBe(trigger);

  click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("group", { name: "Calendars" })).toBeNull();
});

function Modal({ dismissible = true, onClose }: { dismissible?: boolean; onClose(): void }) {
  return (
    <Dialog open title="Rename" onClose={onClose} dismissible={dismissible} actions={<Button>Save</Button>}>
      <input aria-label="Name" />
      <MenuButton label="More" items={[{ id: "copy", label: "Copy", onSelect: () => {} }]} />
    </Dialog>
  );
}

function ConfirmOverModal({ onCloseOuter }: { onCloseOuter(): void }) {
  const [confirm, setConfirm] = useState(true);
  return (
    <>
      <Modal onClose={onCloseOuter} />
      <Dialog open={confirm} title="Discard changes?" onClose={() => setConfirm(false)} actions={null} />
    </>
  );
}

/** A date picker portalled to the body, outside its popover's DOM. */
function Portalled() {
  const ref = useRef<HTMLDivElement>(null);
  useDismissRegion(ref);
  return createPortal(
    <div ref={ref}>
      <button type="button">Pick a date</button>
    </div>,
    document.body,
  );
}

function Popover({ onDismiss }: { onDismiss(): void }) {
  const panel = useRef<HTMLDivElement>(null);
  const layer = useDismissLayer({ open: true, inside: () => [panel.current], onDismiss });
  return (
    <div ref={panel}>
      <DismissScope layer={layer}>
        <Portalled />
      </DismissScope>
    </div>
  );
}

test("a dialog closes on a click on its backdrop, not on a drag that ends there", () => {
  const close = vi.fn();
  render(<Modal onClose={close} />);
  const dialog = dialogNamed("Rename");
  const input = dialog.querySelector("input")!;

  // Selecting text: pressed in the field, released on the backdrop; the click lands on their common ancestor.
  fireEvent.pointerDown(input);
  fireEvent.pointerUp(backdrop(dialog));
  fireEvent.click(backdrop(dialog));
  expect(close).not.toHaveBeenCalled();

  click(input);
  expect(close).not.toHaveBeenCalled();

  click(backdrop(dialog));
  expect(close).toHaveBeenCalledOnce();
});

test("a press on the backdrop that never became a click is not paired with a later scripted click", async () => {
  const close = vi.fn();
  render(<Modal onClose={close} />);
  const dialog = dialogNamed("Rename");
  fireEvent.pointerDown(backdrop(dialog));
  fireEvent.pointerUp(backdrop(dialog));
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  fireEvent.click(backdrop(dialog));
  expect(close).not.toHaveBeenCalled();

  fireEvent.pointerDown(backdrop(dialog));
  fireEvent.pointerCancel(backdrop(dialog));
  fireEvent.click(backdrop(dialog));
  expect(close).not.toHaveBeenCalled();
});

test("a busy dialog ignores Escape and the backdrop", () => {
  const close = vi.fn();
  render(<Modal dismissible={false} onClose={close} />);
  const dialog = dialogNamed("Rename");
  click(backdrop(dialog));
  const event = pressEscape(dialog.querySelector("input")!);
  expect(close).not.toHaveBeenCalled();
  // Still prevented, so a native modal never turns the key into a cancel.
  expect(event).toBe(false);
});

test("a menu inside a dialog closes first, by a press outside it or by Escape", () => {
  const close = vi.fn();
  render(<Modal onClose={close} />);
  const dialog = dialogNamed("Rename");
  const more = [...dialog.querySelectorAll("button")].find((node) => node.textContent === "More")!;

  click(more);
  click(dialog.querySelector("input")!);
  expect(dialog.querySelector('[role="menu"]')).toBeNull();

  click(more);
  click(backdrop(dialog));
  expect(dialog.querySelector('[role="menu"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();

  click(more);
  pressEscape();
  expect(dialog.querySelector('[role="menu"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  pressEscape(dialog.querySelector("input")!);
  expect(close).toHaveBeenCalledOnce();
});

test("a confirmation over a dialog closes alone", () => {
  const closeOuter = vi.fn();
  render(<ConfirmOverModal onCloseOuter={closeOuter} />);
  click(backdrop(dialogNamed("Discard changes?")));
  expect(dialogNamed("Discard changes?").hasAttribute("open")).toBe(false);
  expect(closeOuter).not.toHaveBeenCalled();
  pressEscape(dialogNamed("Rename").querySelector("input")!);
  expect(closeOuter).toHaveBeenCalledOnce();
});

test("content portalled out of an overlay counts as inside it", () => {
  const dismiss = vi.fn();
  render(
    <>
      <button type="button">Elsewhere</button>
      <Popover onDismiss={dismiss} />
    </>,
  );
  click(screen.getByRole("button", { name: "Pick a date" }));
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(dismiss).toHaveBeenCalledExactlyOnceWith("outside", expect.any(Event));
});

test("one Escape closes one layer, and an Escape something inside used closes none", () => {
  const lower = vi.fn(),
    upper = vi.fn();
  const field = document.createElement("input");
  document.body.append(field);
  const removeLower = openDismissLayer({ inside: () => [field], dismiss: lower });
  let removeUpper = openDismissLayer({ inside: () => [field], dismiss: upper });
  // The upper layer closes itself during the key's dispatch, as a real browser commits it.
  const closeUpper = () => removeUpper();
  field.addEventListener("keydown", closeUpper);
  pressEscape(field);
  expect(lower).not.toHaveBeenCalled();
  expect(upper).not.toHaveBeenCalled();
  field.removeEventListener("keydown", closeUpper);

  removeUpper = openDismissLayer({ inside: () => [field], dismiss: upper });
  field.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
  pressEscape(field);
  expect(upper).not.toHaveBeenCalled();
  pressEscape(field);
  expect(upper).toHaveBeenCalledExactlyOnceWith("escape", expect.any(KeyboardEvent));
  expect(lower).not.toHaveBeenCalled();
  removeUpper();
  removeLower();
  field.remove();
});

test("with focus outside the topmost layer, Escape closes it before anything else sees the key", () => {
  const dismiss = vi.fn(),
    editor = vi.fn();
  const field = document.createElement("input");
  document.body.append(field);
  // A canvas editor that uses Escape itself, while a palette that didn't take focus is open.
  field.addEventListener("keydown", editor);
  const remove = openDismissLayer({ inside: () => [], dismiss });
  pressEscape(field);
  expect(dismiss).toHaveBeenCalledOnce();
  expect(editor).not.toHaveBeenCalled();
  remove();
  field.remove();
});
