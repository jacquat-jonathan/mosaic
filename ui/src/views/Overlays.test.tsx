// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useUi } from "../state/ui";
import { PromptDialog } from "./Overlays";
afterEach(() => {
  cleanup();
  useUi.setState({ prompt: null });
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
