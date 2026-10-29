import { expect, test, type Page } from "@playwright/test";
async function openCalendar(page: Page, route = "today") {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.evaluate(async (route) => {
    const mock = (
      window as unknown as {
        __mosaic: {
          mockInvoke(command: string, args: object): Promise<unknown>;
          useWorkspace: { getState(): { open(path: string, options: object): Promise<void> } };
        };
      }
    ).__mosaic;
    const start = new Date();
    start.setHours(9, 0, 0, 0);
    const end = new Date(start);
    end.setHours(10);
    await mock.mockInvoke("planner_create_event", {
      input: {
        title: "Calendar demo",
        description: "Review calendar migration",
        location: "",
        meeting_url: null,
        participants: [],
        epic_id: null,
        color: "#6477d4",
        all_day: false,
        start_value: start.toISOString(),
        end_value: end.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        recurrence_rule: null,
      },
    });
    await mock.useWorkspace.getState().open(`mosaic:${route}`, { newTab: true });
  }, route);
}
test("day calendar retains period navigation, layer filters and keyboard event creation", async ({ page }) => {
  await openCalendar(page);
  const calendar = page.getByRole("main", { name: "Calendar", exact: true });
  const event = calendar.locator(".planner-timed-item.event", { hasText: "Calendar demo" });
  await expect(event).toBeVisible();
  await expect(event).toHaveCSS("font-size", "13px");
  await calendar.getByRole("button", { name: "Next period", exact: true }).click();
  await expect(event).toHaveCount(0);
  await calendar.getByRole("button", { name: "Today", exact: true }).click();
  await expect(event).toBeVisible();
  await calendar.locator(".calendar-chooser summary").click();
  await calendar.getByLabel("Local events", { exact: true }).uncheck();
  await expect(event).toHaveCount(0);
  await calendar.getByLabel("Local events", { exact: true }).check();
  await calendar.locator(".calendar-chooser summary").click();
  await calendar
    .getByRole("button", { name: /^Create event / })
    .first()
    .press("Enter");
  await expect(page.getByRole("complementary", { name: "New event", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close event editor", exact: true }).click();
});
for (const [route, label] of [["today", "Today"]]) {
  test(`${label} calendar shares themes and fits scaled narrow panes`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await openCalendar(page, route);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const calendar = page.getByRole("main", { name: "Calendar", exact: true });
    for (const theme of ["Light", "Dark", "System"] as const) {
      await page.getByRole("radio", { name: theme, exact: true }).check();
      await page.getByRole("tab", { name: `${label} Close tab`, exact: true }).click();
      await expect(calendar).toHaveCSS("font-size", "14px");
      await expect(calendar.getByRole("button", { name: "New event", exact: true })).toHaveCSS("font-size", "14px");
      await expect(calendar).toHaveCSS(
        "background-color",
        theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)",
      );
      await expect(calendar.getByRole("radiogroup", { name: "Calendar view", exact: true })).toBeVisible();
      if (theme !== "System")
        await page.screenshot({ path: testInfo.outputPath(`${route}-${theme.toLowerCase()}.png`) });
      await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
    }
    await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
    await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
    await page.getByRole("tab", { name: `${label} Close tab`, exact: true }).click();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => calendar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect(calendar.getByRole("radio", { name: "Day", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`${route}-narrow.png`) });
  });
}
