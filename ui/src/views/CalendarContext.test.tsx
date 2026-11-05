// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { Days } from "../ipc/types";
import { usePlanning } from "../state/planning";
import { CalendarContext } from "./CalendarContext";
const data: Days = {
  days: [{ date: "2026-10-29", note: null, tasks: [] }],
  overdue: [
    {
      path: "Plan.md",
      line: 2,
      status: "open",
      mark: " ",
      text: "Ship",
      depth: 0,
      parent: null,
      due: "2026-10-20",
      daily: false,
    },
  ],
};
beforeEach(() => {
  usePlanning.setState({ selectedDay: "2026-10-29" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("calendar context distinguishes failed loads and returns focus after retry", async () => {
  vi.spyOn(api, "days").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(data);
  render(<CalendarContext />);
  expect(await screen.findByText("offline")).toBeTruthy();
  expect(screen.queryByText("No overdue tasks.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry calendar details" }));
  await screen.findByRole("checkbox", { name: "Ship" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Overdue" })));
});
test("overdue updates serialize and keep the row until acknowledgement", async () => {
  vi.spyOn(api, "days")
    .mockResolvedValueOnce(data)
    .mockResolvedValue({ ...data, overdue: [] });
  let finish!: () => void;
  const save = vi.spyOn(api, "setTask").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ path: "Plan.md", hash: "new", review: null });
      }),
  );
  render(<CalendarContext />);
  const checkbox = await screen.findByRole("checkbox", { name: "Ship" });
  await userEvent.click(checkbox);
  expect(checkbox).toHaveProperty("disabled", true);
  await userEvent.click(checkbox);
  expect(save).toHaveBeenCalledTimes(1);
  finish();
  expect(await screen.findByText("No overdue tasks.")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Overdue" })));
});
test("old context reads cannot replace a newer day", async () => {
  let finish!: (value: Days) => void;
  vi.spyOn(api, "days")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ ...data, overdue: [] });
  const view = render(<CalendarContext />);
  usePlanning.setState({ selectedDay: "2026-10-30" });
  view.rerender(<CalendarContext />);
  expect(await screen.findByText("No overdue tasks.")).toBeTruthy();
  finish(data);
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Ship" })).toBeNull());
});
