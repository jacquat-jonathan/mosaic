import { test as base, type Page } from "@playwright/test";

// Wednesday midday: the five-day week contains today and scheduling the next hour cannot
// cross a day/week boundary. Install before navigation so mock seeding and UI use one clock.
export const CALENDAR_NOW = "2026-11-04T12:00:00Z";
export async function freezeCalendarTime(page: Page, time = CALENDAR_NOW) {
  // Fix Date without pausing timers: debounce, requests and animation callbacks still run.
  await page.clock.setFixedTime(new Date(time));
}

export const test = base.extend<{ calendarNow: string | null }>({
  calendarNow: [CALENDAR_NOW, { option: true }],
  page: async ({ page, calendarNow }, use) => {
    if (calendarNow) await freezeCalendarTime(page, calendarNow);
    await use(page);
  },
});
