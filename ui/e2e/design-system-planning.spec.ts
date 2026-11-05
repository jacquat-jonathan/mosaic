import { expect, test } from "@playwright/test";

test("board patterns filter, reorder, move tasks and restore export-menu focus", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/design-system.html#board");
  const board = page.locator("#board");
  await expect(board.getByRole("heading", { name: "Board", exact: true })).toBeInViewport();
  const card = board.getByRole("article", { name: "Write release notes", exact: true });
  await card.getByRole("button", { name: "Write release notes", exact: true }).click();
  await expect(card).toHaveAttribute("data-selected", "true");
  await expect(board.getByRole("article").getByRole("combobox")).toHaveCount(0);
  await card.dragTo(board.getByRole("region", { name: "Release board columns" }).locator(".mds-board-column").last());
  await expect(
    board.getByRole("region", { name: "Release board columns" }).locator(".mds-board-column").last(),
  ).toContainText("Write release notes");
  await expect(card.locator(".mds-planning-meta")).toHaveText("30 min");
  await expect(card.getByRole("button", { name: "Write release notes", exact: true })).toBeFocused();
  await expect(board.locator(".mds-epic-header h3").first()).toHaveText("Release");
  await card.getByRole("button", { name: "Write release notes", exact: true }).press("Alt+ArrowLeft");
  await expect(
    board.getByRole("region", { name: "Release board columns" }).locator(".mds-board-column").nth(3),
  ).toContainText("Write release notes");
  await expect(card.locator(".mds-planning-meta")).toHaveText("30 min");
  await board.getByLabel("Search board tasks", { exact: true }).fill("no matching task");
  await expect(board.getByRole("article")).toHaveCount(0);
  await expect(board.getByText("No tasks", { exact: true })).toHaveCount(10);
  await board.getByLabel("Search board tasks", { exact: true }).fill("");
  await board.getByRole("button", { name: "Move Research up", exact: true }).click();
  await expect(board.locator(".mds-epic-header h3").first()).toHaveText("Research");
  await board.getByRole("button", { name: "Collapse Research", exact: true }).click();
  await expect(board.getByRole("region", { name: "Research board columns" })).toHaveCount(0);
  const exportButton = board.getByRole("button", { name: "Export plan", exact: true });
  await exportButton.focus();
  await exportButton.press("ArrowDown");
  const menu = board.getByRole("menu", { name: "Export plan", exact: true });
  await expect(menu.getByRole("menuitem", { name: "JSON export", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(exportButton).toBeFocused();
  await expect(page.locator(".ds-preview-status")).toContainText("CSV export selected");
});

test("epics create tasks in their own lane and drag without a grip", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1500 });
  await page.goto("/design-system.html#board");
  const board = page.locator("#board");
  const research = board.getByRole("region", { name: "Research epic", exact: true });
  const release = board.getByRole("region", { name: "Release epic", exact: true });
  const add = research.getByRole("button", { name: "Add task to Research", exact: true });
  await research.getByRole("button", { name: "Collapse Research", exact: true }).click();
  await add.click();
  const dialog = page.getByRole("dialog", { name: "New task in Research", exact: true });
  await expect(dialog.getByLabel("Task title", { exact: true })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Add task", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(add).toBeFocused();
  await add.click();
  await dialog.getByLabel("Task title", { exact: true }).fill("Interview planning users");
  await dialog.getByLabel("Task title", { exact: true }).press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(add).toBeFocused();
  await expect(research.getByRole("article", { name: "Interview planning users", exact: true })).toBeVisible();
  await expect(release.getByRole("article", { name: "Interview planning users", exact: true })).toHaveCount(0);
  await expect(research).toHaveAttribute("draggable", "true");
  // Epic backgrounds remain draggable; nested cards own their separate task drag.
  await research
    .getByText("No tasks", { exact: true })
    .first()
    .dragTo(release.getByRole("heading", { name: "Release", exact: true }));
  await expect(board.locator(".mds-epic-header h3").first()).toHaveText("Research");
  await page
    .getByRole("radiogroup", { name: "Preview theme", exact: true })
    .getByLabel("Dark", { exact: true })
    .check();
  await research.locator(".mds-epic-header").screenshot({
    path: testInfo.outputPath("epic-header.png"),
    style: ".ds-topbar, .ds-preview-status { visibility: hidden !important; }",
  });
});

test("calendar patterns filter sources, schedule tasks and offer keyboard session actions", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/design-system.html#calendar");
  const calendar = page.locator("#calendar");
  await expect(calendar.getByRole("heading", { name: "Calendar", exact: true })).toBeInViewport();
  const chooser = calendar.getByRole("button", { name: "Calendars", exact: true });
  await chooser.click();
  const layers = calendar.getByRole("group", { name: "Calendars", exact: true });
  await layers.getByRole("checkbox", { name: "Local events", exact: true }).uncheck();
  await expect(calendar.getByRole("button", { name: "09:00–09:30 Release planning Event", exact: true })).toHaveCount(
    0,
  );
  await layers.getByRole("checkbox", { name: "Local events", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(chooser).toBeFocused();
  await expect(layers).toHaveCount(0);
  await calendar.getByRole("button", { name: "Schedule Prepare Mosaic release", exact: true }).click();
  const session = calendar.getByRole("button", {
    name: "11:00–12:00 Prepare Mosaic release Work session",
    exact: true,
  });
  await expect(session).toBeVisible();
  await session.click();
  const actions = calendar.getByRole("button", { name: "Session actions", exact: true });
  await actions.focus();
  await actions.press("ArrowUp");
  const unschedule = calendar.getByRole("menuitem", { name: "Unschedule session", exact: true });
  await expect(unschedule).toBeFocused();
  await unschedule.press("Enter");
  await expect(session).toHaveCount(0);
  await expect(calendar.getByRole("button", { name: "Today", exact: true })).toBeFocused();
  await expect(calendar.getByRole("button", { name: "Schedule Prepare Mosaic release", exact: true })).toBeVisible();
  await calendar.getByRole("button", { name: "Hide open tasks", exact: true }).click();
  await expect(calendar.getByLabel("Search open preview tasks", { exact: true })).toHaveCount(0);
  await calendar.getByRole("button", { name: "Show open tasks", exact: true }).click();
  await calendar.getByLabel("Search open preview tasks", { exact: true }).fill("unmatched");
  await expect(calendar.getByText("No open tasks match these filters.", { exact: true })).toBeVisible();
  expect(requests.some((url) => /\/src\/(App|ipc|state)\b/.test(url))).toBe(false);
});

test("planning patterns share themes, compact spacing and locally scrolling narrow layouts", async ({
  page,
}, testInfo) => {
  await page.goto("/design-system.html#calendar");
  const theme = page.getByRole("radiogroup", { name: "Preview theme", exact: true });
  const chip = page.locator("#calendar").getByRole("button", { name: "09:00–09:30 Selected event Event", exact: true });
  await expect(chip).toHaveCSS("border-radius", "5px");
  await expect(chip).toHaveCSS("font-size", "13px");
  await theme.getByLabel("Dark", { exact: true }).check();
  await expect(chip).toHaveCSS("color", "rgb(228, 229, 234)");
  await theme.getByLabel("Light", { exact: true }).check();
  await expect(chip).toHaveCSS("color", "rgb(29, 31, 38)");
  const card = page.locator("#board .mds-board-card").first();
  await expect(card).toHaveCSS("padding", "12px");
  await page.setViewportSize({ width: 1600, height: 1100 });
  // Keep fixed gallery navigation out of component-only review captures.
  const screenshotStyle = ".ds-topbar, .ds-preview-status { visibility: hidden !important; }";
  await page.locator("#board").screenshot({ path: testInfo.outputPath("board-patterns.png"), style: screenshotStyle });
  await page
    .locator("#calendar")
    .screenshot({ path: testInfo.outputPath("calendar-patterns.png"), style: screenshotStyle });
  await page
    .locator("#board")
    .getByRole("article", { name: "Collect planning feedback", exact: true })
    .screenshot({ path: testInfo.outputPath("task-card.png"), style: screenshotStyle });
  await page.getByRole("radiogroup", { name: "Board preview density" }).getByLabel("Compact", { exact: true }).check();
  await expect(card).toHaveCSS("padding", "8px");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const mode of ["Month", "Week", "Day"] as const) {
    await page.getByRole("radiogroup", { name: "Calendar preview view" }).getByLabel(mode, { exact: true }).check();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(1);
  }
  await expect(
    page.locator("#calendar").getByRole("button", { name: "Unavailable session Work session", exact: true }),
  ).toBeDisabled();
});
