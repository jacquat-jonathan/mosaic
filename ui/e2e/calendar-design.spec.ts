import { expect, test, type Page } from "@playwright/test";
async function openCalendar(page: Page, route = "today", withSession = false) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.evaluate(
    async ({ route, withSession }) => {
      const mock = (
        window as unknown as {
          __mosaic: {
            mockInvoke(command: string, args: object): Promise<{ id: string }>;
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
      if (withSession) {
        const task = await mock.mockInvoke("planner_create_task", {
          input: {
            epic_id: null,
            parent_id: null,
            title: "Session demo",
            description: "",
            status: "new",
            due_date: null,
            estimate_minutes: 60,
          },
        });
        await mock.mockInvoke("planner_create_work_session", {
          input: {
            task_id: task.id,
            all_day: false,
            start_value: start.toISOString(),
            end_value: end.toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        });
      }
      await mock.useWorkspace.getState().open(`mosaic:${route}`, { newTab: true });
    },
    { route, withSession },
  );
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
for (const [route, label] of [
  ["today", "Today"],
  ["week", "My week"],
  ["calendar", "Calendar"],
]) {
  test(`${label} calendar shares themes and fits scaled narrow panes`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    if (route === "calendar")
      await page.addInitScript(() => localStorage.setItem("mosaic:planner-calendar-mode", "month"));
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

test("week calendar retains five-day layout, keyboard view choices and month navigation", async ({ page }) => {
  await openCalendar(page, "week");
  let calendar = page.getByRole("main", { name: "Calendar", exact: true });
  await expect(calendar.locator(".planner-time-day")).toHaveCount(5);
  const week = calendar.getByRole("radio", { name: "Week", exact: true });
  await week.focus();
  await week.press("ArrowRight");
  await expect(calendar.getByRole("radio", { name: "Day", exact: true })).toBeChecked();
  await expect(calendar.getByRole("radio", { name: "Day", exact: true })).toBeFocused();
  await calendar.getByRole("radio", { name: "Day", exact: true }).press("ArrowLeft");
  await expect(week).toBeFocused();
  await calendar.getByRole("radio", { name: "Month", exact: true }).click();
  calendar = page.getByRole("main", { name: "Calendar", exact: true });
  await expect(calendar).toHaveCSS("font-size", "14px");
  await expect(calendar.getByRole("radio", { name: "Month", exact: true })).toBeFocused();
});

test("month retains its grid, keyboard event opening and day navigation", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mosaic:planner-calendar-mode", "month"));
  await openCalendar(page, "calendar");
  const calendar = page.getByRole("main", { name: "Calendar", exact: true });
  await expect(calendar.getByRole("gridcell")).toHaveCount(30);
  await calendar.getByRole("button", { name: "Calendar demo", exact: true }).press("Enter");
  await expect(page.getByRole("complementary", { name: "Edit Calendar demo", exact: true })).toBeVisible();
  await expect(calendar.getByRole("radio", { name: "Month", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Close event editor", exact: true }).click();
  await calendar.getByRole("gridcell").first().press("Enter");
  await expect(calendar.getByRole("radio", { name: "Day", exact: true })).toBeChecked();
  await expect(calendar.getByRole("radio", { name: "Day", exact: true })).toBeFocused();
});

test("event editor retains dates, recurrence and focus after cancellation", async ({ page }) => {
  await openCalendar(page);
  const create = page
    .getByRole("main", { name: "Calendar", exact: true })
    .getByRole("button", { name: "New event", exact: true });
  await create.click();
  const editor = page.getByRole("complementary", { name: "New event", exact: true });
  await expect(editor.getByLabel("Title", { exact: true })).toBeFocused();
  await editor.getByLabel("Title", { exact: true }).fill("Recurring review");
  await editor.getByRole("combobox", { name: "Repeat", exact: true }).selectOption("weekly");
  await editor.getByLabel("Every", { exact: true }).fill("2");
  await editor.getByLabel("Color", { exact: true }).fill("#2255aa");
  await editor.getByRole("button", { name: "Close event editor", exact: true }).click();
  await expect(create).toBeFocused();
});
test("event editor follows themes and fills scaled narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openCalendar(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
    await page
      .getByRole("main", { name: "Calendar", exact: true })
      .getByRole("button", { name: "New event", exact: true })
      .click();
    const editor = page.getByRole("complementary", { name: "New event", exact: true });
    await expect(editor).toHaveCSS("font-size", "14px");
    await expect(editor.getByLabel("Title", { exact: true })).toHaveCSS("font-size", "14px");
    await expect(editor).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`event-editor-${theme.toLowerCase()}.png`) });
    await editor.getByRole("button", { name: "Close event editor", exact: true }).click();
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
  await page
    .getByRole("main", { name: "Calendar", exact: true })
    .getByRole("button", { name: "New event", exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 900 });
  const editor = page.getByRole("complementary", { name: "New event", exact: true });
  await expect(editor.getByLabel("Title", { exact: true })).toBeInViewport();
  await expect.poll(() => editor.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("event-editor-narrow.png") });
});

test("work session editor preserves exact minutes, all-day moves and focus", async ({ page }) => {
  await openCalendar(page, "today", true);
  const card = page.locator(".planner-timed-item.session", { hasText: "Session demo" });
  await card.press("Enter");
  const editor = page.getByRole("complementary", { name: "Edit work session for Session demo", exact: true });
  await expect(editor.getByLabel("Day", { exact: true })).toBeFocused();
  await editor.getByLabel("End time", { exact: true }).fill("");
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(editor.getByText("Enter a start and end time.")).toBeVisible();
  await editor.getByLabel("Start time", { exact: true }).fill("09:13");
  await editor.getByLabel("End time", { exact: true }).fill("10:47");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(card).toContainText("94 min");
  await expect(card).toBeFocused();
  await card.press("Enter");
  await editor.getByLabel("All day", { exact: true }).check();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("button", { name: "◷ Session demo", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Day", exact: true })).toBeFocused();
});
test("work session editor follows themes and fills narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openCalendar(page, "today", true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
    await page.locator(".planner-timed-item.session", { hasText: "Session demo" }).press("Enter");
    const editor = page.getByRole("complementary", { name: "Edit work session for Session demo", exact: true });
    await expect(editor).toHaveCSS("font-size", "14px");
    await expect(editor).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`work-session-${theme.toLowerCase()}.png`) });
    await editor.getByRole("button", { name: "Close work session editor", exact: true }).click();
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
  await page.locator(".planner-timed-item.session", { hasText: "Session demo" }).press("Enter");
  await page.setViewportSize({ width: 320, height: 900 });
  const editor = page.getByRole("complementary", { name: "Edit work session for Session demo", exact: true });
  await expect(editor.getByLabel("Day", { exact: true })).toBeInViewport();
  await expect(editor.getByRole("button", { name: "Close work session editor", exact: true })).toBeInViewport();
  await expect.poll(() => editor.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("work-session-narrow.png") });
});
