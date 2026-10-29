// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { useVault } from "../state/vault";
import { SpecialView } from "./SpecialView";
import type { QueryResult } from "../ipc/types";
const result: QueryResult = {
  columns: ["status"],
  total: 1,
  rows: [
    {
      path: "Plan.md",
      title: "Plan",
      modified: 1,
      tags: [],
      props: {},
      task: { workflow: "", line: 3, text: "Ship", status: "open", mark: " ", depth: 0, parent: null, due: null },
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("retry keeps errors distinct from empty results and moves focus to the result", async () => {
  vi.spyOn(api, "query").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(result);
  render(<SpecialView path="mosaic:tasks" />);
  expect(await screen.findByText("offline")).toBeTruthy();
  expect(screen.queryByText(/No tasks match/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Ship" })));
});
test("completion serializes writes, waits for acknowledgement and returns focus when the row disappears", async () => {
  vi.spyOn(api, "query").mockResolvedValueOnce(result).mockResolvedValue({ columns: [], rows: [], total: 0 });
  let finish!: () => void;
  const save = vi.spyOn(api, "setTask").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ path: "Plan.md", hash: "new", review: null });
      }),
  );
  render(<SpecialView path="mosaic:tasks" />);
  const control = await screen.findByRole("checkbox", { name: "Ship" });
  await userEvent.click(control);
  expect((control as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByText(/No tasks match/)).toBeNull();
  await userEvent.click(control);
  expect(save).toHaveBeenCalledTimes(1);
  finish();
  expect(await screen.findByText(/No tasks match/)).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Tasks" })));
});
test("late query responses from a replaced vault cannot replace the current list", async () => {
  let finish!: (value: QueryResult) => void;
  vi.spyOn(api, "query")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ columns: [], rows: [], total: 0 });
  const view = render(<SpecialView path="mosaic:tasks" />);
  useVault.setState({ vault: { root: "/another" } as NonNullable<ReturnType<typeof useVault.getState>["vault"]> });
  view.rerender(<SpecialView path="mosaic:tasks" />);
  expect(await screen.findByText(/No tasks match/)).toBeTruthy();
  finish(result);
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Ship" })).toBeNull());
});

test("note queries keep metadata and source actions without task completion controls", async () => {
  vi.spyOn(api, "query").mockResolvedValue({
    columns: ["tags", "priority"],
    total: 1,
    rows: [{ path: "Plan.md", title: "Plan", modified: 1, tags: ["project"], props: { priority: "high" } }],
  });
  render(<SpecialView path="mosaic:query/tag%3Aproject" />);
  expect(await screen.findByText("priority: high")).toBeTruthy();
  expect(screen.getByText("tags: #project")).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
});
