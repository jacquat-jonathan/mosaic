// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import type { PlannerWorkSession } from "../../ipc/types";
import { useVault } from "../../state/vault";
import { WorkSessionEditor } from "./WorkSessionEditor";
const session: PlannerWorkSession = {
  id: "session",
  task_id: "task",
  all_day: false,
  start_value: "2026-11-12T09:00:00Z",
  end_value: "2026-11-12T10:00:00Z",
  timezone: "UTC",
  state: "scheduled",
  revision: 1,
  created_at: "",
  updated_at: "",
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("work-session validation is associated with its time field and failed writes retain the draft", async () => {
  let reject!: (reason: Error) => void;
  const update = vi.spyOn(api, "updatePlannerWorkSession").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const done = vi.fn(),
    reload = vi.fn();
  render(<WorkSessionEditor session={session} taskTitle="Release" onClose={vi.fn()} onDone={done} onReload={reload} />);
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "08:00" } });
  const end = screen.getByLabelText("End time");
  expect(end.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(end.getAttribute("aria-describedby")!)?.textContent).toContain(
    "End time must be after start time.",
  );
  fireEvent.change(end, { target: { value: "10:47" } });
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(end).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "Saving…" }));
  expect(update).toHaveBeenCalledTimes(1);
  reject({ code: "conflict", message: "revision changed" } as unknown as Error);
  expect(await screen.findByText("revision changed")).toBeTruthy();
  expect(end).toHaveProperty("value", "10:47");
  expect(done).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Reload latest" }));
  expect(reload).toHaveBeenCalledOnce();
});
test("late work-session acknowledgements cannot affect another vault", async () => {
  let finish!: () => void;
  vi.spyOn(api, "updatePlannerWorkSession").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(session);
      }),
  );
  const done = vi.fn();
  render(
    <WorkSessionEditor session={session} taskTitle="Release" onClose={vi.fn()} onDone={done} onReload={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  useVault.setState({ vault: { root: "/other", name: "Other" } });
  finish();
  await waitFor(() => expect(done).not.toHaveBeenCalled());
});

test("background refreshes of the same revision preserve edited minutes", () => {
  const props = { taskTitle: "Release", onClose: vi.fn(), onDone: vi.fn(), onReload: vi.fn() };
  const view = render(<WorkSessionEditor session={session} {...props} />);
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "10:47" } });
  view.rerender(<WorkSessionEditor session={{ ...session }} {...props} />);
  expect(screen.getByLabelText("End time")).toHaveProperty("value", "10:47");
});
