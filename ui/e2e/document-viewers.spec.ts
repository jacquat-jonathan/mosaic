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

async function replaceSource(page: Page, content: string) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText(content);
}
test("diagram controls preserve source editing, render errors and recovery", async ({ page }) => {
  await setup(page);
  await openFile(page, "Graph.dot");
  const controls = page.getByRole("group", { name: "Graph controls", exact: true });
  const preview = page.getByRole("region", { name: "Graph preview", exact: true });
  await expect(preview.locator("svg")).toBeVisible();
  await controls.getByRole("radio", { name: "Source", exact: true }).click();
  await replaceSource(page, "this is not a graph");
  await controls.getByRole("radio", { name: "Graph", exact: true }).click();
  await expect(controls.getByRole("alert")).toBeVisible();
  await controls.getByRole("radio", { name: "Source", exact: true }).click();
  await replaceSource(page, "digraph { Migrated -> Ready }");
  await controls.getByRole("radio", { name: "Graph", exact: true }).click();
  await expect(preview.locator("svg")).toContainText("Migrated");
  await expect(controls.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => readFile(page, "Graph.dot")).toContain("Migrated -> Ready");
  await preview.focus();
  await expect(preview).toBeFocused();
});
test("diagram controls share themes and fit scaled narrow panes", async ({ page }, info) => {
  await setup(page);
  await openFile(page, "Graph.dot");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openFile(page, "Graph.dot");
    const controls = page.getByRole("group", { name: "Graph controls", exact: true });
    await expect(controls).toHaveCSS("font-size", "14px");
    await expect(controls).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    await expect(page.getByRole("region", { name: "Graph preview", exact: true }).locator("svg")).toBeVisible();
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`diagram-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openFile(page, "Graph.dot");
  await page.setViewportSize({ width: 320, height: 900 });
  const controls = page.getByRole("group", { name: "Graph controls", exact: true });
  await expect(controls.getByRole("radio", { name: "Source", exact: true })).toBeInViewport();
  await expect.poll(() => controls.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("region", { name: "Graph preview", exact: true }).locator("svg")).toBeVisible();
  await expect(controls.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("diagram-narrow.png") });
});

async function drawing(page: Page) {
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } })
      .__mosaic;
    await m.mockInvoke("write_file", {
      path: "Sketch.excalidraw",
      content: JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "mosaic",
        elements: [],
        appState: {},
        files: {},
      }),
      expectedHash: null,
    });
  });
  await openFile(page, "Sketch.excalidraw");
}
test("drawing controls preserve source repair and load the drawing engine", async ({ page }) => {
  await setup(page);
  await drawing(page);
  const controls = page.getByRole("group", { name: "Drawing controls", exact: true });
  await expect(page.locator(".excalidraw-host .excalidraw")).toBeVisible();
  await controls.getByRole("radio", { name: "Source", exact: true }).click();
  await replaceSource(page, "{broken");
  await controls.getByRole("radio", { name: "Drawing", exact: true }).click();
  await expect(controls.getByRole("alert")).toContainText("Can't open this drawing");
  await expect(controls.getByRole("radio", { name: "Source", exact: true })).toBeChecked();
  await replaceSource(page, '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}');
  await controls.getByRole("radio", { name: "Drawing", exact: true }).click();
  await expect(page.locator(".excalidraw-host .excalidraw")).toBeVisible();
  await expect(controls.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => readFile(page, "Sketch.excalidraw")).toContain('"elements":[]');
});
test("drawing controls share themes and fit scaled narrow panes", async ({ page }, info) => {
  await setup(page);
  await drawing(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openFile(page, "Sketch.excalidraw");
    const controls = page.getByRole("group", { name: "Drawing controls", exact: true });
    await expect(controls).toHaveCSS("font-size", "14px");
    await expect(controls).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    await expect(page.locator(".excalidraw-host .excalidraw")).toBeVisible();
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`drawing-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openFile(page, "Sketch.excalidraw");
  await page.setViewportSize({ width: 320, height: 900 });
  const controls = page.getByRole("group", { name: "Drawing controls", exact: true });
  await expect(controls.getByRole("radio", { name: "Source", exact: true })).toBeInViewport();
  await expect.poll(() => controls.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator(".excalidraw-host .excalidraw")).toBeVisible();
  await page.screenshot({ path: info.outputPath("drawing-narrow.png") });
});
