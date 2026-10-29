// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useUi } from "../state/ui";
import { ConfirmDialog, PromptDialog } from "./Overlays";
afterEach(() => {
  cleanup();
  useUi.setState({ prompt: null, confirm: null });
});
test("prompt submits the field value and cancels with Escape", () => {
  const resolve = vi.fn();
  useUi.setState({ prompt: { title: "Rename file", value: "Original", resolve } });
  render(<PromptDialog />);
  fireEvent.change(screen.getByRole("textbox", { name: "Rename file" }), { target: { value: "Renamed" } });
  fireEvent.submit(screen.getByRole("textbox", { name: "Rename file" }).closest("form")!);
  expect(resolve).toHaveBeenCalledExactlyOnceWith("Renamed");
  act(() => useUi.setState({ prompt: { title: "Rename file", value: "Other", resolve } }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(resolve).toHaveBeenLastCalledWith(null);
});

test("confirmation resolves once and Escape declines", () => {
  const resolve = vi.fn();
  useUi.setState({
    confirm: { title: "Delete file?", body: "Move to trash.", confirmLabel: "Delete", danger: true, resolve },
  });
  render(<ConfirmDialog />);
  expect(screen.getByRole("dialog").getAttribute("aria-describedby")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
  expect(resolve).toHaveBeenCalledExactlyOnceWith(true);
  act(() =>
    useUi.setState({ confirm: { title: "Delete file?", body: "Move to trash.", confirmLabel: "Delete", resolve } }),
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(resolve).toHaveBeenLastCalledWith(false);
});
