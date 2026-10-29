import { expect, test, type Page } from "@playwright/test";

async function openDetail(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("radio", { name: "Automations", exact: true }).click();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Workflow catalog", exact: true })
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
}
test("workflow detail and context preserve edit, cancel, pause, run and source navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openDetail(page);
  const detail = page.getByRole("group", { name: "Workflow detail", exact: true });
  const context = page.getByRole("group", { name: "Workflow context", exact: true });
  await expect(detail.getByRole("heading", { name: "Weekly review", level: 1, exact: true })).toBeVisible();
  await expect(context).toContainText("sonnet");
  const edit = detail.getByRole("button", { name: "Edit workflow", exact: true });
  await edit.click();
  const editor = page.getByRole("group", { name: "Workflow editor", exact: true });
  await expect(editor.getByLabel("Instructions", { exact: true })).toBeFocused();
  const original = await editor.getByLabel("Instructions", { exact: true }).inputValue();
  await editor.getByLabel("Instructions", { exact: true }).fill(`${original}\nDraft change`);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(edit).toBeFocused();
  await detail.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await expect(context.locator(".mds-status")).toHaveText("Paused");
  await detail.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await detail.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Run log", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
  await expect(detail.locator(".mds-workflow-last-run")).toContainText("Mock run completed");
  await context.getByRole("button", { name: "Edit source", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Weekly review Close tab", exact: true })).toBeVisible();
});

test("workflow detail and context follow themes and fit narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openDetail(page);
  const detail = page.getByRole("group", { name: "Workflow detail", exact: true });
  const context = page.getByRole("group", { name: "Workflow context", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page
      .getByRole("navigation", { name: "AI views", exact: true })
      .getByRole("button", { name: "Weekly review", exact: true })
      .click();
    await expect(detail).toHaveCSS("font-size", "14px");
    await expect(context).toHaveCSS("font-size", "14px");
    await expect(context.getByRole("heading", { name: "Weekly review", exact: true })).toHaveCSS(
      "text-transform",
      "none",
    );
    await expect(context.locator("dt").first()).toHaveCSS("font-size", "13px");
    await expect(detail).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await detail.locator("summary").click();
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`workflow-detail-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
  await expect(detail).toHaveAttribute("data-density", "compact");
  await expect
    .poll(() => context.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await detail.locator("summary").click();
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.locator(".workflow-list-page").evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.locator(".workflow-list-page").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("workflow-detail-narrow.png") });
});
