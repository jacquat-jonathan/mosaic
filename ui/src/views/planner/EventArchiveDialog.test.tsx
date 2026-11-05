// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import type { PlannerEvent } from "../../ipc/types";
import { EventArchiveDialog } from "./EventArchiveDialog";
const item: PlannerEvent = {
  id: "event",
  series_id: null,
  title: "Release",
  description: "",
  location: "",
  meeting_url: null,
  participants: [],
  epic_id: null,
  color: null,
  all_day: true,
  start_value: "2026-11-12",
  end_value: "2026-11-13",
  timezone: "UTC",
  recurrence_rule: null,
  revision: 1,
  created_at: "",
  updated_at: "",
  archived_at: "2026-10-29",
  trashed_at: null,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("archive load errors remain distinct from empty results and retry", async () => {
  vi.spyOn(api, "plannerEvents").mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
  render(<EventArchiveDialog onClose={vi.fn()} onChange={vi.fn()} />);
  expect(await screen.findByText("offline")).toBeTruthy();
  expect(screen.queryByText("No events here.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry archived events" }));
  expect(await screen.findByText("No events here.")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Archive" })));
});
test("archive actions serialize and return focus after a restored row disappears", async () => {
  vi.spyOn(api, "plannerEvents").mockResolvedValueOnce([item]).mockResolvedValue([]);
  let finish!: () => void;
  const restore = vi.spyOn(api, "restorePlannerEvent").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ...item, archived_at: null });
      }),
  );
  render(<EventArchiveDialog onClose={vi.fn()} onChange={vi.fn()} />);
  const action = await screen.findByRole("button", { name: "Restore" });
  await userEvent.click(action);
  expect(action).toHaveProperty("disabled", true);
  await userEvent.click(action);
  expect(restore).toHaveBeenCalledTimes(1);
  finish();
  expect(await screen.findByText("No events here.")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Archive" })));
});
