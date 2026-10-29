import { expect, test, type Page } from "@playwright/test";
import { openMockVault } from "./mock-vault";
async function board(page: Page) {
  await page.goto("/");
  await openMockVault(page);
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
test("shared board persists epic task creation, card status moves and full-epic reordering", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await board(page);
  const view = page.getByRole("main", { name: "Task board", exact: true });
  const release = view.getByRole("region", { name: "Release epic", exact: true });
  await expect(view.getByRole("region", { name: "Unassigned epic", exact: true })).not.toHaveAttribute(
    "data-dragging",
    "true",
  );
  await release.getByRole("button", { name: "Add task to Release", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "New task in Release", exact: true });
  await prompt.getByPlaceholder("What needs doing?").fill("Prepare deployment");
  await prompt.getByRole("button", { name: "OK", exact: true }).click();
  const card = release.getByRole("article", { name: "Prepare deployment", exact: true });
  await expect(release.getByRole("region", { name: "Release: New", exact: true })).toContainText("Prepare deployment");
  await expect(view.getByRole("article").getByRole("combobox")).toHaveCount(0);
  await page.getByRole("button", { name: "Close task editor", exact: true }).click();
  await card.dragTo(release.getByRole("region", { name: "Release: Blocked", exact: true }));
  await expect(release.getByRole("region", { name: "Release: Blocked", exact: true })).toContainText(
    "Prepare deployment",
  );
  const readPlanner = (command: "planner_tasks" | "planner_epics") =>
    page.evaluate(async (command) => {
      const mock = (
        window as unknown as {
          __mosaic: {
            mockInvoke(command: string, args: object): Promise<{ title: string; status?: string; position: number }[]>;
          };
        }
      ).__mosaic;
      return mock.mockInvoke(command, { includeArchived: false, includeTrashed: false });
    }, command);
  await expect
    .poll(async () => (await readPlanner("planner_tasks")).find((task) => task.title === "Prepare deployment")?.status)
    .toBe("blocked");
  await expect(view.locator(".mds-epic-header h2").first()).toHaveText("Release");
  await page.getByRole("button", { name: "Close task editor", exact: true }).click();
  await page.getByRole("button", { name: "New epic", exact: true }).click();
  const epicDialog = page.getByRole("dialog", { name: "New epic", exact: true });
  await epicDialog.getByLabel("Title", { exact: true }).fill("Research");
  await epicDialog.getByRole("button", { name: "Save epic", exact: true }).click();
  const research = view.getByRole("region", { name: "Research epic", exact: true });
  await expect(research).toHaveAttribute("draggable", "true");
  await research
    .getByText("No tasks", { exact: true })
    .first()
    .dragTo(release.getByRole("heading", { name: "Release", exact: true }));
  await expect(view.locator(".mds-epic-header h2").first()).toHaveText("Research");
  await expect
    .poll(async () => (await readPlanner("planner_epics")).sort((a, b) => a.position - b.position)[0]?.title)
    .toBe("Research");
  await page.screenshot({ path: testInfo.outputPath("app-board.png") });
});
test("board header aligns actions above filters and wraps in narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark" });
  await board(page);
  const view = page.getByRole("main", { name: "Task board", exact: true });
  const header = view.locator(".board-header");
  await expect(view.getByRole("button", { name: /import|preview/i })).toHaveCount(0);
  const heading = await header.getByRole("heading", { name: "Board", exact: true }).boundingBox();
  const action = await header.getByRole("button", { name: "New task", exact: true }).boundingBox();
  expect(heading).not.toBeNull();
  expect(action).not.toBeNull();
  expect(Math.abs(heading!.y + heading!.height / 2 - action!.y - action!.height / 2)).toBeLessThanOrEqual(1);
  const fields = await Promise.all(
    ["Search planner tasks", "Filter by epic", "Filter by status", "Planner lifecycle view"].map((label) =>
      header.getByLabel(label, { exact: true }).boundingBox(),
    ),
  );
  for (const field of fields) expect(field).not.toBeNull();
  const bottoms = fields.map((field) => field!.y + field!.height);
  expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
  const tops = fields.map((field) => field!.y);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  for (const field of fields) expect(field!.height).toBe(34);
  expect(Math.min(...fields.map((field) => field!.y))).toBeGreaterThan(action!.y + action!.height);
  await header.screenshot({ path: testInfo.outputPath("board-header-dark.png") });
  await page.setViewportSize({ width: 320, height: 900 });
  await expect
    .poll(() => header.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await expect(header.getByLabel("Planner lifecycle view", { exact: true })).toBeInViewport();
  await header.screenshot({ path: testInfo.outputPath("board-header-narrow.png") });
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
    await expect(view.locator(".mds-planning-meta").first()).toHaveCSS("font-size", "13px");
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

test("task editor saves fields and returns focus to its card", async ({ page }) => {
  await board(page);
  await page.getByRole("article", { name: "Ship release", exact: true }).press("Enter");
  let editor = page.getByRole("complementary", { name: "Edit Ship release", exact: true });
  await expect(editor.getByLabel("Title", { exact: true })).toBeFocused();
  await editor.getByLabel("Title", { exact: true }).fill("");
  await expect(editor.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await editor.getByLabel("Title", { exact: true }).fill("Release Mosaic");
  await editor.getByLabel("Description", { exact: true }).fill("Verified on both browsers");
  await editor.getByLabel("Due date", { exact: true }).fill("2026-11-12");
  await editor.getByLabel("Estimate (minutes)", { exact: true }).fill("45");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  editor = page.getByRole("complementary", { name: "Edit Release Mosaic", exact: true });
  await expect(editor.getByLabel("Title", { exact: true })).toHaveValue("Release Mosaic");
  await editor.getByLabel("Status", { exact: true }).selectOption("blocked");
  await expect(page.getByLabel("Release: Blocked", { exact: true })).toContainText("Release Mosaic");
  await editor.getByRole("button", { name: "Close task editor", exact: true }).click();
  await expect(page.getByRole("article", { name: "Release Mosaic", exact: true })).toBeFocused();
});
test("task editor shares themes and fills narrow scaled panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await board(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
    await page.getByRole("article", { name: "Ship release", exact: true }).press("Enter");
    const editor = page.getByRole("complementary", { name: "Edit Ship release", exact: true });
    await expect(editor).toHaveCSS("font-size", "14px");
    await expect(editor).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`task-editor-${theme.toLowerCase()}.png`) });
    await editor.getByRole("button", { name: "Close task editor", exact: true }).click();
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
  await page.getByRole("article", { name: "Ship release", exact: true }).press("Enter");
  await page.setViewportSize({ width: 320, height: 900 });
  const editor = page.getByRole("complementary", { name: "Edit Ship release", exact: true });
  await expect(editor.getByLabel("Title", { exact: true })).toBeInViewport();
  await expect(page.getByRole("main", { name: "Task board", exact: true })).toHaveCount(0);
  await expect.poll(() => editor.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("task-editor-narrow.png") });
  await editor.getByRole("button", { name: "Close task editor", exact: true }).click();
  await expect(page.getByRole("article", { name: "Ship release", exact: true })).toBeFocused();
});

test("epic editor and history retain saving, keyboard dismissal and focus return", async ({ page }) => {
  await board(page);
  const create = page.getByRole("button", { name: "New epic", exact: true });
  await create.click();
  const dialog = page.getByRole("dialog", { name: "New epic", exact: true });
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  await dialog.getByLabel("Title", { exact: true }).fill("Next release");
  await dialog.getByLabel("Color", { exact: true }).fill("#2255aa");
  await dialog.getByLabel("Title", { exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(create).toBeFocused();
  const lane = page.locator(".mds-epic-lane", { hasText: "Next release" });
  await lane.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit epic", exact: true });
  await expect(edit.getByLabel("Color", { exact: true })).toHaveValue("#2255aa");
  await edit.getByLabel("Title", { exact: true }).fill("Final release");
  await edit.getByRole("button", { name: "Save epic", exact: true }).click();
  const renamed = page.locator(".mds-epic-lane", { hasText: "Final release" });
  await expect(renamed.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  const history = renamed.getByRole("button", { name: "History", exact: true });
  await history.click();
  const historyDialog = page.getByRole("dialog", { name: "Final release history", exact: true });
  await expect(historyDialog).toContainText("Created epic");
  await historyDialog.press("Escape");
  await expect(history).toBeFocused();
});
test("epic dialog shares themes and fits scaled narrow windows", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await board(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
    await page.getByRole("button", { name: "New epic", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New epic", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`epic-editor-${theme.toLowerCase()}.png`) });
    await dialog.press("Escape");
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "New epic", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New epic", exact: true });
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(() => dialog.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(321);
  await page.screenshot({ path: testInfo.outputPath("epic-editor-narrow.png") });
});
