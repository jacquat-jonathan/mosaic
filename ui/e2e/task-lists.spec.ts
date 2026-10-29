import { expect, test, type Page } from "@playwright/test";
async function openView(page: Page, kind: string, id?: string) {
  await page.evaluate(
    async ({ kind, id }) => {
      const { useWorkspace } = (
        window as unknown as {
          __mosaic: { useWorkspace: { getState(): { open(path: string, options: object): Promise<void> } } };
        }
      ).__mosaic;
      await useWorkspace.getState().open(`mosaic:${kind}${id ? `/${encodeURIComponent(id)}` : ""}`, { newTab: true });
    },
    { kind, id },
  );
}
test("Tasks retain completion, note navigation and focus after removing a result", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await openView(page, "tasks");
  const view = page.getByRole("main", { name: "Tasks", exact: true });
  const checkbox = view.getByRole("checkbox", { name: /^Ship the calendar/ });
  await expect(checkbox).toBeVisible();
  await checkbox.press("Space");
  await expect(checkbox).toHaveCount(0);
  await expect(view.locator("input[type=checkbox]:focus")).toHaveCount(1);
  await view.getByRole("button", { name: "Tasks", exact: true }).first().click();
  await expect(page.locator(".cm-content")).toContainText("Ship the calendar");
});
test("Tasks follow themes and fit narrow scaled panes", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openView(page, "tasks");
  const view = page.getByRole("main", { name: "Tasks", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page.getByRole("tab", { name: "Tasks Close tab", exact: true }).click();
    await expect(view).toHaveCSS("font-size", "14px");
    await expect(view.getByRole("heading")).toHaveCSS("font-size", "17px");
    await expect(view).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: testInfo.outputPath(`tasks-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Tasks Close tab", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => view.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("tasks-narrow.png") });
});
