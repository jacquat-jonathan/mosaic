// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useUi } from "../state/ui";
import { ContextMenu } from "./ContextMenu";
afterEach(() => {
  cleanup();
  useUi.setState({ menu: null });
});
test("nested keyboard menus skip disabled items, activate once and restore focus", () => {
  const action = vi.fn();
  render(
    <>
      <button>Opener</button>
      <ContextMenu />
    </>,
  );
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  act(() =>
    useUi.getState().showMenu(10, 10, [
      { label: "Open", action },
      { label: "Disabled", disabled: true },
      { label: "More", children: [{ label: "Child", action }] },
    ]),
  );
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Open" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  const more = screen.getByRole("menuitem", { name: "More" });
  expect(document.activeElement).toBe(more);
  fireEvent.keyDown(more, { key: "ArrowRight" });
  const child = screen.getByRole("menuitem", { name: "Child" });
  expect(document.activeElement).toBe(child);
  fireEvent.keyDown(child, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(more);
  fireEvent.keyDown(more, { key: "ArrowRight" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Child" }));
  expect(action).toHaveBeenCalledOnce();
  expect(useUi.getState().menu).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("a press outside closes the menu without moving focus, and its trigger toggles it", () => {
  render(
    <>
      <button type="button">Elsewhere</button>
      <button type="button">More</button>
      <ContextMenu />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "More" });
  const open = () => act(() => useUi.getState().showMenu(10, 10, [{ label: "Rename", action: () => {} }], trigger));
  open();
  fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Rename" }));
  expect(useUi.getState().menu).not.toBeNull();

  // Pressing the trigger again closes the menu instead of reopening it.
  fireEvent.pointerDown(trigger);
  expect(useUi.getState().menu).not.toBeNull();
  open();
  expect(useUi.getState().menu).toBeNull();

  open();
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  fireEvent.pointerDown(elsewhere);
  expect(useUi.getState().menu).toBeNull();
  expect(document.activeElement).toBe(elsewhere);

  open();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename" }), { key: "Escape" });
  expect(useUi.getState().menu).toBeNull();
});
