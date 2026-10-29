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
