// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import { useVault } from "../../state/vault";
import { EpicEditor } from "./EpicEditor";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("epic writes serialize, block dismissal while pending, and retain failed drafts", async () => {
  let reject!: (reason: Error) => void;
  const create = vi.spyOn(api, "createPlannerEpic").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const close = vi.fn(),
    done = vi.fn();
  render(<EpicEditor epic={null} defaultColor="#6477d4" onClose={close} onDone={done} />);
  await userEvent.type(screen.getByLabelText("Title"), "Release");
  await userEvent.click(screen.getByRole("button", { name: "Save epic" }));
  expect(screen.getByLabelText("Title")).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "Saving…" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
  reject(new Error("save failed"));
  expect(await screen.findByText("save failed")).toBeTruthy();
  expect(screen.getByLabelText("Title")).toHaveProperty("value", "Release");
  expect(done).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});
test("late epic acknowledgements cannot affect another vault", async () => {
  let finish!: () => void;
  vi.spyOn(api, "createPlannerEpic").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({} as Awaited<ReturnType<typeof api.createPlannerEpic>>);
      }),
  );
  const done = vi.fn();
  render(<EpicEditor epic={null} defaultColor="#6477d4" onClose={vi.fn()} onDone={done} />);
  await userEvent.type(screen.getByLabelText("Title"), "Release");
  await userEvent.click(screen.getByRole("button", { name: "Save epic" }));
  useVault.setState({ vault: { root: "/other", name: "Other" } });
  finish();
  await waitFor(() => expect(done).not.toHaveBeenCalled());
});
