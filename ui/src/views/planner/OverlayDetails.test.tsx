// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { CalendarOverlayOccurrence } from "../../ipc/types";
import { OverlayDetails } from "./OverlayDetails";
const occurrence: CalendarOverlayOccurrence = {
  source_id: "source",
  source_name: "Team",
  uid: "meeting",
  title: "Planning",
  description: "Review",
  location: "Studio",
  meeting_url: "https://example.com/meeting",
  all_day: false,
  start_value: "2026-11-12T09:00:00Z",
  end_value: "2026-11-12T10:00:00Z",
  timezone: "UTC",
  occurrence_key: "2026-11-12",
  color: "#6477d4",
  read_only: true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("subscribed details serialize copies and retain read-only information after errors", async () => {
  let reject!: (reason: Error) => void;
  const copy = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(<OverlayDetails occurrence={occurrence} onImport={copy} onClose={vi.fn()} />);
  expect(screen.getByRole("link", { name: "Open meeting link" }).getAttribute("href")).toBe(
    "https://example.com/meeting",
  );
  await userEvent.click(screen.getByRole("button", { name: "Copy this occurrence to Mosaic" }));
  await userEvent.click(screen.getByRole("button", { name: "Copying…" }));
  expect(copy).toHaveBeenCalledTimes(1);
  reject(new Error("copy failed"));
  expect(await screen.findByText("copy failed")).toBeTruthy();
  expect(screen.getByText("Studio")).toBeTruthy();
  expect(screen.getByText(/This event is read-only/)).toBeTruthy();
});
