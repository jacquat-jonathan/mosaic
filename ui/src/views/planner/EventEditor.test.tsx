// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import { useVault } from "../../state/vault";
import { EventEditor } from "./EventEditor";
import type { PlannerEvent } from "../../ipc/types";
const props = {
  occurrence: null,
  series: null,
  epics: [],
  initialStart: "2026-11-12T09:00:00Z",
  initialEnd: "2026-11-12T10:00:00Z",
  onClose: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("editing an imported series title preserves its month-day recurrence rule", async () => {
  const series: PlannerEvent = {
    id: "monthly",
    series_id: null,
    title: "Month end",
    description: "",
    location: "",
    meeting_url: null,
    participants: [],
    epic_id: null,
    color: null,
    all_day: false,
    start_value: "2026-01-31T08:00:00Z",
    end_value: "2026-01-31T09:00:00Z",
    timezone: "Europe/Zurich",
    recurrence_rule: "FREQ=MONTHLY;BYMONTHDAY=-1",
    revision: 1,
    created_at: "",
    updated_at: "",
    archived_at: null,
    trashed_at: null,
  };
  const update = vi.spyOn(api, "updatePlannerEvent").mockResolvedValue(series);
  render(<EventEditor {...props} series={series} onDone={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Title"), " review");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(update).toHaveBeenCalledWith(
    "monthly",
    expect.objectContaining({
      expected_revision: 1,
      title: "Month end review",
      recurrence_rule: "FREQ=MONTHLY;BYMONTHDAY=-1",
    }),
  );
});
test("event fields retain recurrence and date parsing while failed saves keep the draft", async () => {
  let reject!: (reason: Error) => void;
  const create = vi.spyOn(api, "createPlannerEvent").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const done = vi.fn();
  render(<EventEditor {...props} onDone={done} />);
  await userEvent.type(screen.getByLabelText("Title"), "Release planning");
  fireEvent.change(screen.getByLabelText("Start day"), { target: { value: "12/11/2026" } });
  await userEvent.selectOptions(screen.getByLabelText("Repeat"), "daily");
  fireEvent.change(screen.getByLabelText("Every"), { target: { value: "2" } });
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByLabelText("Title").matches(":disabled")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Saving…" }));
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Release planning", recurrence_rule: "FREQ=DAILY;INTERVAL=2" }),
  );
  reject(new Error("save failed"));
  expect(await screen.findByText("save failed")).toBeTruthy();
  expect(screen.getByLabelText("Title")).toHaveProperty("value", "Release planning");
  expect(done).not.toHaveBeenCalled();
});
test("late event acknowledgements cannot close a different vault's editor", async () => {
  let finish!: () => void;
  vi.spyOn(api, "createPlannerEvent").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({} as Awaited<ReturnType<typeof api.createPlannerEvent>>);
      }),
  );
  const done = vi.fn();
  render(<EventEditor {...props} onDone={done} />);
  await userEvent.type(screen.getByLabelText("Title"), "Release");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  useVault.setState({ vault: { root: "/other", name: "Other" } });
  finish();
  await waitFor(() => expect(done).not.toHaveBeenCalled());
});
