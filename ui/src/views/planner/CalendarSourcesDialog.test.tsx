// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import { useVault } from "../../state/vault";
import { CalendarSourcesDialog } from "./CalendarSourcesDialog";
import type { CalendarSubscription } from "../../ipc/types";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("editing a calendar saves metadata, preserves its URL by default and retains failed drafts", async () => {
  const item: CalendarSubscription = {
    id: "team",
    name: "Team",
    color: "#6477d4",
    visible: false,
    refresh_minutes: 30,
    last_success: null,
    last_error: null,
    has_cache: true,
  };
  const update = vi.spyOn(api, "updateCalendarSubscription").mockResolvedValue(item);
  const change = vi.fn();
  render(<CalendarSourcesDialog subscriptions={[item]} onChange={change} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit Team" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Team");
  expect(screen.getByLabelText("Replacement URL (optional)")).toHaveProperty("value", "");
  await userEvent.clear(screen.getByLabelText("Name"));
  await userEvent.type(screen.getByLabelText("Name"), "Delivery");
  fireEvent.change(screen.getByLabelText("Color"), { target: { value: "#112233" } });
  await userEvent.selectOptions(screen.getByLabelText("Refresh"), "60");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(update).toHaveBeenLastCalledWith("team", "Delivery", "#112233", false, 60, null);
  expect(change).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Edit Team" }));
  await userEvent.type(screen.getByLabelText("Replacement URL (optional)"), "webcal://example.test/replacement.ics");
  update.mockRejectedValueOnce(new Error("Keychain unavailable"));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Keychain unavailable")).toBeTruthy();
  expect(screen.getByLabelText("Replacement URL (optional)")).toHaveProperty(
    "value",
    "webcal://example.test/replacement.ics",
  );
  expect(change).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(update).toHaveBeenLastCalledWith(
    "team",
    "Team",
    "#6477d4",
    false,
    30,
    "webcal://example.test/replacement.ics",
  );
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
