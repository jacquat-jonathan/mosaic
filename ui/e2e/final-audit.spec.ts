import { expect, test, type Page } from "@playwright/test";
async function conflict(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await page.keyboard.type(" my unsaved words");
  await page.clock.runFor(50);
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: { mockInvoke(command: string, args: object): Promise<unknown>; external(paths: string[]): void };
      }
    ).__mosaic;
    await m.mockInvoke("write_file", {
      path: "Ideas.md",
      content: "# Ideas\n\nChanged by an agent.\n",
      expectedHash: null,
    });
    m.external(["Ideas.md"]);
  });
  await expect(page.getByText("This file changed on disk while you were editing it.", { exact: true })).toBeVisible();
  await page.clock.resume();
}
async function openIdeas(page: Page) {
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: { useWorkspace: { getState(): { open(path: string, options: { newTab: boolean }): Promise<void> } } };
      }
    ).__mosaic;
    await m.useWorkspace.getState().open("Ideas.md", { newTab: true });
  });
}
test("conflict dialog preserves review, cancellation focus and explicit resolution", async ({ page }) => {
  await conflict(page);
  const compare = page.getByRole("button", { name: "Compare", exact: true });
  await compare.click();
  const dialog = page.getByRole("dialog", { name: "Disk version → your version", exact: true });
  await expect(dialog).toContainText("Changed by an agent.");
  await expect(dialog).toContainText("my unsaved words");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(compare).toBeFocused();
  await compare.click();
  await dialog.getByRole("button", { name: "Keep mine", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toContainText("my unsaved words");
});
test("conflict notices and comparison share themes and fit scaled narrow windows", async ({ page }, info) => {
  await conflict(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openIdeas(page);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Disk version → your version", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await expect(dialog).toContainText("my unsaved words");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`conflict-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openIdeas(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const notice = page.getByText("This file changed on disk while you were editing it.", { exact: true }).locator("..");
  await expect.poll(() => notice.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Disk version → your version", exact: true });
  await expect(dialog.getByRole("button", { name: "Keep mine", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("conflict-narrow.png") });
});
