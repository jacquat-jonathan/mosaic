// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useVault } from "../state/vault";
import { useUi } from "../state/ui";
import { ConfirmDialog, ErrorToast, PromptDialog } from "./Overlays";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useVault.setState({ error: null });
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

test("toast pauses dismissal while focused and returns to its prior focus", () => {
  vi.useFakeTimers();
  render(
    <>
      <button>Source</button>
      <ErrorToast />
    </>,
  );
  const source = screen.getByRole("button", { name: "Source" });
  source.focus();
  act(() => useVault.setState({ error: "Could not save" }));
  const dismiss = screen.getByRole("button", { name: "Dismiss error" });
  act(() => dismiss.focus());
  act(() => vi.advanceTimersByTime(7000));
  expect(screen.getByRole("alert").textContent).toContain("Could not save");
  fireEvent.click(dismiss);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(source);
  act(() => useVault.setState({ error: "Another error" }));
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("alert")).toBeNull();
});
