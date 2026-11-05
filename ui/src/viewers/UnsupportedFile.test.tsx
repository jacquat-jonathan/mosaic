// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../ipc/api", async (original) => ({
  ...(await original<typeof import("../ipc/api")>()),
  openInDefaultApp: mocks.open,
}));
import { UnsupportedFile } from "./UnsupportedFile";
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test("external opening serializes and reports refusal without losing its file", async () => {
  let fail!: (error: Error) => void;
  mocks.open.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  render(<UnsupportedFile path="file.bin" message="No preview" />);
  fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));
  fireEvent.click(screen.getByRole("button", { name: "Opening…" }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("file.bin");
  await act(async () => fail(new Error("opening refused")));
  expect((await screen.findByRole("alert")).textContent).toContain("opening refused");
  expect(screen.getByRole("button", { name: "Open in default app" })).toHaveProperty("disabled", false);
});
test("late refusals do not leak into another selected file", async () => {
  let fail!: (error: Error) => void;
  mocks.open.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const view = render(<UnsupportedFile path="old.bin" message="Old file" />);
  fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));
  view.rerender(<UnsupportedFile path="new.bin" message="New file" />);
  await act(async () => fail(new Error("old refusal")));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("New file");
});
