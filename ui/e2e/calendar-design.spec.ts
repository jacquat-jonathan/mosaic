import { expect, test, type Page } from "@playwright/test";
import { openMockVault } from "./mock-vault";
async function openCalendar(page: Page, route = "today", withSession = false) {
  await page.goto("/");
  await openMockVault(page);
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

test("calendar details retain overdue completion, focus and daily-note opening", async ({ page }) => {
  await openCalendar(page);
  const details = page.getByRole("group", { name: "Calendar details", exact: true });
  await details.getByRole("checkbox", { name: /^Overdue review/ }).press("Space");
  await expect(details.getByText("No overdue tasks.")).toBeVisible();
  await expect(details.getByRole("heading", { name: "Overdue", exact: true })).toBeFocused();
  await details.getByRole("button", { name: "Open daily note", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Write the release notes");
  await expect(details).toHaveCount(0);
});
test("calendar details follow themes and fit the scaled context drawer", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openCalendar(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const details = page.getByRole("group", { name: "Calendar details", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
    await expect(details).toHaveCSS("font-size", "14px");
    await expect(details).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`calendar-details-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Show right panel", exact: true }).click();
  await expect(details.getByRole("button", { name: "Open daily note", exact: true })).toBeInViewport();
  await expect.poll(() => details.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("calendar-details-narrow.png") });
});

test("calendar subscriptions retain visibility, removal and modal focus", async ({ page }) => {
  await openCalendar(page);
  await page.locator(".calendar-chooser summary").click();
  const manage = page.getByRole("button", { name: "Manage subscriptions…", exact: true });
  await manage.click();
  const dialog = page.getByRole("dialog", { name: "Calendar subscriptions", exact: true });
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await dialog.getByLabel("Name", { exact: true }).fill("Migration calendar");
  await dialog.getByLabel("Subscription URL", { exact: true }).fill("https://example.com/team.ics");
  await dialog.getByRole("button", { name: "Add calendar", exact: true }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await dialog.getByRole("checkbox", { name: "Migration calendar", exact: true }).uncheck();
  await expect(dialog.getByRole("checkbox", { name: "Migration calendar", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Remove Migration calendar", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Migration calendar", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await dialog.press("Escape");
  await expect(manage).toBeFocused();
});
test("calendar subscriptions share themes and fit scaled narrow windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openCalendar(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
    const summary = page.locator(".calendar-chooser summary");
    if (!(await page.locator(".calendar-chooser").evaluate((el) => el.hasAttribute("open")))) await summary.click();
    await page.getByRole("button", { name: "Manage subscriptions…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Calendar subscriptions", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`subscriptions-${theme.toLowerCase()}.png`) });
    await dialog.press("Escape");
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  if (!(await page.locator(".calendar-chooser").evaluate((el) => el.hasAttribute("open"))))
    await page.locator(".calendar-chooser summary").click();
  await page.getByRole("button", { name: "Manage subscriptions…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Calendar subscriptions", exact: true });
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("subscriptions-narrow.png") });
});

async function archiveDemo(page: Page) {
  await page.evaluate(async () => {
    const mock = (window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } })
      .__mosaic;
    const events = (await mock.mockInvoke("planner_events", { includeArchived: false, includeTrashed: false })) as {
      id: string;
      title: string;
      revision: number;
    }[];
    const item = events.find((item) => item.title === "Calendar demo")!;
    await mock.mockInvoke("planner_archive_event", { id: item.id, expectedRevision: item.revision });
  });
}
async function openArchive(page: Page) {
  if (!(await page.locator(".calendar-chooser").evaluate((el) => el.hasAttribute("open"))))
    await page.locator(".calendar-chooser summary").click();
  await page.getByRole("button", { name: "Archived local events…", exact: true }).click();
}
test("event archive retains delete, restore, keyboard selection and focus", async ({ page }) => {
  await openCalendar(page);
  await archiveDemo(page);
  await openArchive(page);
  const dialog = page.getByRole("dialog", { name: "Local event archive", exact: true });
  await expect(dialog.getByText("Calendar demo", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog.getByText("No events here.")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Archive", exact: true })).toBeFocused();
  await dialog.getByRole("radio", { name: "Archive", exact: true }).press("ArrowRight");
  await expect(dialog.getByText("Calendar demo", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(dialog.getByText("No events here.")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Deleted", exact: true })).toBeFocused();
  await dialog.press("Escape");
  await expect(page.getByRole("button", { name: "Archived local events…", exact: true })).toBeFocused();
});
test("event archive shares themes and fits scaled narrow windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openCalendar(page);
  await archiveDemo(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
    await openArchive(page);
    const dialog = page.getByRole("dialog", { name: "Local event archive", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`event-archive-${theme.toLowerCase()}.png`) });
    await dialog.press("Escape");
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await openArchive(page);
  const dialog = page.getByRole("dialog", { name: "Local event archive", exact: true });
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("event-archive-narrow.png") });
});

test("subscribed event details retain source information, copy and focus return", async ({ page }) => {
  await openCalendar(page);
  const card = page.locator(".planner-timed-item.overlay", { hasText: "Design sync" });
  await card.press("Enter");
  const details = page.getByRole("complementary", { name: "Read-only calendar event", exact: true });
  await expect(details.getByRole("button", { name: "Close event details", exact: true })).toBeFocused();
  await expect(details).toContainText("Studio 4");
  await details.getByRole("button", { name: "Close event details", exact: true }).click();
  await expect(card).toBeFocused();
  await card.press("Enter");
  await details.getByRole("button", { name: "Copy this occurrence to Mosaic", exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(card).toBeFocused();
  await expect(page.locator(".planner-timed-item.event", { hasText: "Design sync" })).toBeVisible();
});
test("subscribed event details share themes and fit narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openCalendar(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
    await page.locator(".planner-timed-item.overlay", { hasText: "Design sync" }).press("Enter");
    const details = page.getByRole("complementary", { name: "Read-only calendar event", exact: true });
    await expect(details).toHaveCSS("font-size", "14px");
    await expect(details).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`subscribed-event-${theme.toLowerCase()}.png`) });
    await details.getByRole("button", { name: "Close event details", exact: true }).click();
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
  await page.locator(".planner-timed-item.overlay", { hasText: "Design sync" }).press("Enter");
  await page.setViewportSize({ width: 320, height: 900 });
  const details = page.getByRole("complementary", { name: "Read-only calendar event", exact: true });
  await expect(details.getByRole("button", { name: "Close event details", exact: true })).toBeInViewport();
  await expect.poll(() => details.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("subscribed-event-narrow.png") });
});

async function chooseImport(page: Page) {
  const day = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  });
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:migration-import-demo",
    "SUMMARY:Imported planning",
    `DTSTART:${day}T120000Z`,
    `DTEND:${day}T130000Z`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import iCalendar file", exact: true }).click();
  await (await chooser).setFiles({
    name: "migration-preview.ics",
    mimeType: "text/calendar",
    buffer: Buffer.from(content),
  });
}
test("iCalendar import preserves selection, duplicate controls and focus", async ({ page }) => {
  await openCalendar(page);
  await chooseImport(page);
  const dialog = page.getByRole("dialog", { name: "Import calendar events", exact: true });
  await expect(dialog.getByRole("checkbox", { name: /^Imported planning/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Import 1 events", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import iCalendar file", exact: true })).toBeFocused();
  await expect(page.locator(".planner-timed-item.event", { hasText: "Imported planning" })).toBeVisible();
  await chooseImport(page);
  const duplicate = dialog.getByRole("checkbox", { name: /^Imported planning/ });
  await expect(duplicate).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Import 0 events", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Allow intentional duplicates", exact: true }).check();
  await duplicate.check();
  await dialog.getByRole("checkbox", { name: "Allow intentional duplicates", exact: true }).uncheck();
  await expect(duplicate).not.toBeChecked();
  await expect(duplicate).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import iCalendar file", exact: true })).toBeFocused();
});
test("iCalendar import shares themes and fits scaled narrow windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openCalendar(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
    await chooseImport(page);
    const dialog = page.getByRole("dialog", { name: "Import calendar events", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`ical-import-${theme.toLowerCase()}.png`) });
    await dialog.press("Escape");
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Today Close tab", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await chooseImport(page);
  const dialog = page.getByRole("dialog", { name: "Import calendar events", exact: true });
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("ical-import-narrow.png") });
});
