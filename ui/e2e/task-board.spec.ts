import { expect, test, type Page } from "@playwright/test";
async function board(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.evaluate(async () => {
    const mock = (
      window as unknown as {
        __mosaic: {
          mockInvoke(command: string, args: object): Promise<{ id: string }>;
          useWorkspace: { getState(): { open(path: string, options: object): Promise<void> } };
        };
      }
    ).__mosaic;
    const epic = await mock.mockInvoke("planner_create_epic", {
      input: { title: "Release", description: "", color: "#6477d4" },
    });
    const parent = await mock.mockInvoke("planner_create_task", {
      input: {
        epic_id: epic.id,
        parent_id: null,
        title: "Ship release",
        description: "Publish the verified release",
        status: "new",
        due_date: null,
        estimate_minutes: 60,
      },
    });
    await mock.mockInvoke("planner_create_task", {
      input: {
        epic_id: epic.id,
        parent_id: parent.id,
        title: "Write notes",
        description: "",
        status: "new",
        due_date: null,
        estimate_minutes: 15,
      },
    });
    await mock.useWorkspace.getState().open("mosaic:board", { newTab: true });
  });
}
test("board retains filters, keyboard subtask completion and drag destinations", async ({ page }) => {
  await board(page);
  const view = page.getByRole("main", { name: "Task board", exact: true });
  const card = view.getByRole("article", { name: "Ship release", exact: true });
  await view.getByLabel("Search planner tasks", { exact: true }).fill("Write notes");
  await expect(card).toBeVisible();
  await view.getByLabel("Search planner tasks", { exact: true }).fill("");
  const checkbox = card.getByRole("checkbox", { name: "Mark Write notes done", exact: true });
  await checkbox.press("Space");
  await expect(card.getByRole("checkbox", { name: "Mark Write notes not done", exact: true })).toBeChecked();
  await expect(page.getByRole("complementary", { name: "Edit Write notes", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Edit Ship release", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close task editor", exact: true }).click();
  await card.focus();
  await card.press("Enter");
  await expect(page.getByRole("complementary", { name: "Edit Ship release", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close task editor", exact: true }).click();
  await view.getByRole("button", { name: "Collapse Release", exact: true }).click();
  await expect(card).toHaveCount(0);
  await view.getByRole("button", { name: "Expand Release", exact: true }).click();
  await expect(card).toBeVisible();
});
test("board shares themes and keeps wide lanes inside a scaled narrow scroller", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await board(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const view = page.getByRole("main", { name: "Task board", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
    await expect(view).toHaveCSS("font-size", "14px");
    await expect(view).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await expect(view.locator(".planner-card-meta").first()).toHaveCSS("font-size", "13px");
    if (theme !== "System") await page.screenshot({ path: testInfo.outputPath(`board-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => view.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(view.getByLabel("Filter by status", { exact: true })).toBeInViewport();
  await expect
    .poll(() => view.locator(".board-scroll").evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("board-narrow.png") });
});
