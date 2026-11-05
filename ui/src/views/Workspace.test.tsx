// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { Workspace } from "./Workspace";

vi.mock("../viewers/FileView", () => ({ FileView: ({ path }: { path: string }) => <div>{path}</div> }));
beforeEach(() => {
  useWorkspace.setState({
    panes: [
      { id: "first", tabs: ["Ideas.md", "Welcome.md"], active: "Ideas.md", size: 1 },
      { id: "second", tabs: [], active: null, size: 1 },
    ],
    focused: "first",
    buffers: {},
    direction: "row",
  });
  useUi.setState({ leftSidebar: true, rightPanel: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("workspace tabs retain roving focus and close without activating the parent", async () => {
  const activate = vi.spyOn(useWorkspace.getState(), "activate");
  const close = vi.spyOn(useWorkspace.getState(), "closeTab");
  render(<Workspace />);
  const tab = screen.getByRole("tab", { name: /^Ideas/ });
  fireEvent.keyDown(tab, { key: "End" });
  const welcome = screen.getByRole("tab", { name: /^Welcome/ });
  await waitFor(() => expect(document.activeElement).toBe(welcome));
  expect(welcome.getAttribute("aria-selected")).toBe("true");
  activate.mockClear();
  within(welcome).getByRole("button", { name: "Close tab" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(close).toHaveBeenCalledWith("first", "Welcome.md");
  expect(activate).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /^Ideas/ })));
});

test("workspace split handles expose keyboard limits and balance adjacent panes", () => {
  render(<Workspace />);
  const handle = screen.getByRole("separator", { name: "Resize workspace panes" });
  expect(handle.getAttribute("aria-orientation")).toBe("vertical");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle.getAttribute("aria-valuenow")).toBe("52");
  fireEvent.keyDown(handle, { key: "Home" });
  expect(handle.getAttribute("aria-valuenow")).toBe("10");
  fireEvent.keyDown(handle, { key: "End" });
  expect(handle.getAttribute("aria-valuenow")).toBe("90");
  fireEvent.keyDown(handle, { key: "Enter" });
  expect(handle.getAttribute("aria-valuenow")).toBe("50");
});

test("unmounting a dragging split handle removes its listeners", () => {
  const resize = vi.spyOn(useWorkspace.getState(), "resize");
  const { unmount } = render(<Workspace />);
  const handle = screen.getByRole("separator", { name: "Resize workspace panes" });
  vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 1000, height: 500 } as DOMRect);
  fireEvent.mouseDown(handle, { clientX: 500, button: 0 });
  fireEvent.mouseMove(window, { clientX: 600 });
  expect(resize).toHaveBeenCalledWith(0, 0.1);
  unmount();
  expect(document.body.classList.contains("resizing")).toBe(false);
  resize.mockClear();
  fireEvent.mouseMove(window, { clientX: 650 });
  expect(resize).not.toHaveBeenCalled();
});
