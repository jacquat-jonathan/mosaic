import { expect, test, type Page } from "@playwright/test";
async function setup(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.waitForFunction(() => "__mosaic" in window);
}
async function openFile(page: Page, path: string) {
  await page.evaluate(async (path) => {
    const m = (
      window as unknown as {
        __mosaic: { useWorkspace: { getState(): { open(path: string, options: { newTab: boolean }): Promise<void> } } };
      }
    ).__mosaic;
    await m.useWorkspace.getState().open(path, { newTab: true });
  }, path);
}
async function readFile(page: Page, path: string) {
  return page.evaluate(async (path) => {
    const m = (
      window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<{ content: string }> } }
    ).__mosaic;
    return (await m.mockInvoke("read_file", { path })).content;
  }, path);
}
async function canvasCount(page: Page) {
  return JSON.parse(await readFile(page, "Board.canvas")).nodes.length as number;
}
test("canvas preserves card and shape editing, source choices, palette dragging and focus", async ({ page }) => {
  await setup(page);
  await openFile(page, "Board.canvas");
  const controls = page.getByRole("group", { name: "Canvas controls", exact: true });
  await expect(controls.getByRole("radio", { name: "Canvas", exact: true })).toBeChecked();
  const before = await canvasCount(page);
  await controls.getByRole("button", { name: "Card", exact: true }).click();
  await expect.poll(() => canvasCount(page)).toBe(before + 1);
  const shape = controls.getByRole("button", { name: "Shape", exact: true });
  await shape.click();
  const palette = page.getByRole("dialog", { name: "Shapes and icons", exact: true });
  await expect(palette.locator(".palette-tile").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(shape).toBeFocused();
  await shape.click();
  await palette.getByTitle(/^Rectangle: click to add/).click();
  await expect.poll(() => canvasCount(page)).toBe(before + 2);
  await expect(page.locator(".canvas-text-edit")).toBeFocused();
  await shape.click();
  const pane = page.locator(".react-flow__pane");
  const target = await pane.evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (let y = 20; y < r.height - 20; y += 30)
      for (let x = 20; x < r.width - 20; x += 30)
        if (document.elementFromPoint(r.left + x, r.top + y) === el) return { x, y };
    throw new Error("No empty canvas drop position");
  });
  await palette.getByTitle(/^Rectangle: click to add/).dragTo(pane, { targetPosition: target });
  await expect.poll(() => canvasCount(page)).toBe(before + 3);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await controls.getByRole("radio", { name: "Source", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText('"nodes"');
  await controls.getByRole("radio", { name: "Canvas", exact: true }).click();
  await expect(pane).toBeVisible();
});
test("canvas controls and palette share themes and fit scaled narrow panes", async ({ page }, info) => {
  await setup(page);
  await openFile(page, "Board.canvas");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openFile(page, "Board.canvas");
    const controls = page.getByRole("group", { name: "Canvas controls", exact: true });
    await expect(controls).toHaveCSS("font-size", "14px");
    await expect(controls).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    expect(await page.locator(".canvas-host").evaluate((el) => !!el.closest(".mosaic-ds"))).toBe(false);
    await controls.getByRole("button", { name: "Shape", exact: true }).click();
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`canvas-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openFile(page, "Board.canvas");
  await page.setViewportSize({ width: 320, height: 900 });
  const controls = page.getByRole("group", { name: "Canvas controls", exact: true });
  await expect.poll(() => controls.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await controls.getByRole("button", { name: "Shape", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Shapes and icons", exact: true });
  await expect(palette.getByRole("button", { name: "Close shapes", exact: true })).toBeInViewport();
  await expect.poll(() => palette.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(321);
  await expect.poll(() => palette.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("canvas-narrow.png") });
});
