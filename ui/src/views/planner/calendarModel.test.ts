import { describe, expect, it } from "vitest";
import {
  CALENDAR_END_HOUR,
  CALENDAR_START_HOUR,
  EXPANDED_CALENDAR_MIN_WIDTH,
  formatCalendarDate,
  isCompactCalendarWidth,
  parseCalendarDate,
  timedLayout,
  visibleCalendarHours,
  visibleDays,
} from "./calendarModel";
import type { CalendarWorkSession, EventOccurrence } from "../../ipc/types";

const event = (id: string, start: string, end: string): EventOccurrence => ({
  event_id: id,
  series_id: id,
  occurrence_key: start.slice(0, 10),
  title: id,
  description: "",
  location: "",
  meeting_url: null,
  participants: [],
  epic_id: null,
  color: null,
  all_day: false,
  start_value: start,
  end_value: end,
  timezone: "UTC",
  recurring: false,
});
describe("planner calendar presentation", () => {
  it("uses six Monday-Friday rows for a month and five weekdays for a week", () => {
    const month = visibleDays(new Date(2026, 9, 13), "month"),
      week = visibleDays(new Date(2026, 9, 13), "week");
    expect(month).toHaveLength(30);
    expect(week).toHaveLength(5);
    expect([...month, ...week].every((day) => day.getDay() !== 0 && day.getDay() !== 6)).toBe(true);
    expect(visibleDays(new Date(2026, 9, 13), "day")).toHaveLength(1);
  });
  it("pads the visible hours before 6am and after 10pm", () => {
    const hours = visibleCalendarHours();
    expect(hours[0]).toBe(5);
    expect(hours.at(-1)).toBe(22);
    expect(hours[0]).toBe(CALENDAR_START_HOUR);
    expect(hours.at(-1)).toBe(CALENDAR_END_HOUR - 1);
    expect(hours).toHaveLength(18);
  });
  it("collapses the task tray from the calendar pane width, not the window width", () => {
    expect(isCompactCalendarWidth(EXPANDED_CALENDAR_MIN_WIDTH - 1)).toBe(true);
    expect(isCompactCalendarWidth(EXPANDED_CALENDAR_MIN_WIDTH)).toBe(false);
  });
  it("formats and validates calendar editor dates as dd/mm/yyyy", () => {
    expect(formatCalendarDate("2026-10-14")).toBe("14/10/2026");
    expect(parseCalendarDate("14/10/2026")).toBe("2026-10-14");
    expect(parseCalendarDate("31/02/2026")).toBeNull();
    expect(parseCalendarDate("2026-10-14")).toBeNull();
  });
  it("places overlaps side by side and later items back in the first column", () => {
    const items = timedLayout(
      [
        event("a", "2026-10-13T09:00:00Z", "2026-10-13T11:00:00Z"),
        event("b", "2026-10-13T10:00:00Z", "2026-10-13T10:30:00Z"),
        event("c", "2026-10-13T11:00:00Z", "2026-10-13T12:00:00Z"),
      ],
      [] as CalendarWorkSession[],
      "2026-10-13",
    );
    expect(items.map((item) => item.column)).toEqual([0, 1, 0]);
    expect(items.slice(0, 2).every((item) => item.columns === 2)).toBe(true);
  });
});
