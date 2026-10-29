// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Resizer } from "./Resizer";
afterEach(cleanup);
function Panel({ side = "right" }: { side?: "left" | "right" }) {
  const [width, setWidth] = useState(260);
  return (
    <div>
      <Resizer side={side} width={width} onResize={setWidth} onReset={() => setWidth(260)} label="Resize panel" />
    </div>
  );
}
test("keyboard resizing respects limits direction and reset", () => {
  const { rerender } = render(<Panel />);
  const handle = screen.getByRole("separator", { name: "Resize panel" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle.getAttribute("aria-valuenow")).toBe("270");
  fireEvent.keyDown(handle, { key: "End" });
  expect(handle.getAttribute("aria-valuenow")).toBe("560");
  fireEvent.keyDown(handle, { key: "Home" });
  expect(handle.getAttribute("aria-valuenow")).toBe("180");
  fireEvent.keyDown(handle, { key: "Enter" });
  expect(handle.getAttribute("aria-valuenow")).toBe("260");
  rerender(<Panel side="left" />);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(handle.getAttribute("aria-valuenow")).toBe("270");
});
test("dragging accounts for interface scale and cleans up when unmounted", () => {
  const onResize = vi.fn();
  const { unmount } = render(
    <div>
      <Resizer side="right" width={260} onResize={onResize} onReset={vi.fn()} label="Resize panel" />
    </div>,
  );
  const handle = screen.getByRole("separator", { name: "Resize panel" });
  const parent = handle.parentElement!;
  Object.defineProperty(parent, "offsetWidth", { value: 260 });
  vi.spyOn(parent, "getBoundingClientRect").mockReturnValue({ width: 338 } as DOMRect);
  fireEvent.mouseDown(handle, { clientX: 338, button: 0 });
  fireEvent.mouseMove(window, { clientX: 364 });
  expect(onResize).toHaveBeenLastCalledWith(280);
  expect(document.body.classList.contains("resizing")).toBe(true);
  unmount();
  expect(document.body.classList.contains("resizing")).toBe(false);
  fireEvent.mouseMove(window, { clientX: 390 });
  expect(onResize).toHaveBeenCalledTimes(1);
});
