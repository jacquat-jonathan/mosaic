// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import { useVault } from "../../state/vault";
import { CalendarSourcesDialog } from "./CalendarSourcesDialog";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("subscription failures preserve fields and serialize pending decisions", async () => {
  let reject!: (reason: Error) => void;
  const add = vi.spyOn(api, "addCalendarSubscription").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const change = vi.fn(),
    close = vi.fn();
  render(<CalendarSourcesDialog subscriptions={[]} onChange={change} onClose={close} />);
  await userEvent.type(screen.getByLabelText("Name"), "Team");
  await userEvent.type(screen.getByLabelText("Subscription URL"), "https://example.com/calendar.ics");
  await userEvent.click(screen.getByRole("button", { name: "Add calendar" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "Working…" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(add).toHaveBeenCalledTimes(1);
  reject(new Error("feed unavailable"));
  expect(await screen.findByText("feed unavailable")).toBeTruthy();
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Team");
  expect(screen.getByLabelText("Subscription URL")).toHaveProperty("value", "https://example.com/calendar.ics");
  expect(change).not.toHaveBeenCalled();
});
test("late subscriptions do not refresh a different vault", async () => {
  let finish!: () => void;
  vi.spyOn(api, "addCalendarSubscription").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({} as Awaited<ReturnType<typeof api.addCalendarSubscription>>);
      }),
  );
  const change = vi.fn();
  render(<CalendarSourcesDialog subscriptions={[]} onChange={change} onClose={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Name"), "Team");
  await userEvent.type(screen.getByLabelText("Subscription URL"), "https://example.com/calendar.ics");
  await userEvent.click(screen.getByRole("button", { name: "Add calendar" }));
  useVault.setState({ vault: { root: "/other", name: "Other" } });
  finish();
  await waitFor(() => expect(change).not.toHaveBeenCalled());
});
