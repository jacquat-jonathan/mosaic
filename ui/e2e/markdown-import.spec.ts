import { expect, test, type Page } from "@playwright/test";
async function setup(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "Plan", exact: true }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
}
async function preview(page: Page) {
  await page.getByRole("button", { name: "Preview import", exact: true }).click();
}
async function welcome(page: Page) {
  return page.evaluate(async () =>
    (
      window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<{ content: string }> } }
    ).__mosaic
      .mockInvoke("read_file", { path: "Welcome.md" })
      .then((file) => file.content),
  );
}
test("Markdown migration retains group selection, source notes and focus", async ({ page }) => {
  await setup(page);
  await preview(page);
  const region = page.getByRole("region", { name: "Import Markdown tasks", exact: true });
  await expect(region.getByRole("heading", { name: "Preview Markdown task import", exact: true })).toBeFocused();
  await region.press("Escape");
  await expect(page.getByRole("button", { name: "Preview import", exact: true })).toBeFocused();
  await preview(page);
  const group = region.getByRole("checkbox", { name: /^Select all from / }).first();
  await group.uncheck();
  await group.check();
  const before = await welcome(page);
  await region.getByRole("button", { name: /^Import \d+ items$/ }).click();
  await expect(region).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeFocused();
  expect(await welcome(page)).toBe(before);
});
test("Markdown migration shares themes and fits scaled narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await setup(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
    await preview(page);
    const region = page.getByRole("region", { name: "Import Markdown tasks", exact: true });
    await expect(region).toHaveCSS("font-size", "14px");
    await expect(region).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`markdown-import-${theme.toLowerCase()}.png`) });
    await region.getByRole("button", { name: "Close import preview", exact: true }).click();
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
  await preview(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const region = page.getByRole("region", { name: "Import Markdown tasks", exact: true });
  await expect(region.getByRole("button", { name: "Close import preview", exact: true })).toBeInViewport();
  await expect.poll(() => region.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("markdown-import-narrow.png") });
});
