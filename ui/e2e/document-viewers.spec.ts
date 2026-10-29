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

test("chart controls preserve local-data rendering, source edits and error recovery", async ({ page }) => {
  await setup(page);
  await openFile(page, "Charts/Sales.vl.json");
  const controls = page.getByRole("group", { name: "Chart controls", exact: true });
  const preview = page.getByRole("region", { name: "Chart preview", exact: true });
  await expect(preview.locator("svg")).toBeVisible();
  await controls.getByRole("radio", { name: "Source", exact: true }).click();
  await replaceSource(page, "{not json");
  await controls.getByRole("radio", { name: "Chart", exact: true }).click();
  await expect(controls.getByRole("alert")).toContainText("not valid JSON");
  await controls.getByRole("radio", { name: "Source", exact: true }).click();
  await replaceSource(
    page,
    '{"data":{"values":[{"x":"Alpha","y":3},{"x":"Beta","y":7}]},"mark":"bar","encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}',
  );
  await controls.getByRole("radio", { name: "Chart", exact: true }).click();
  await expect(preview.locator("svg")).toContainText("Alpha");
  await expect(controls.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => readFile(page, "Charts/Sales.vl.json")).toContain("Beta");
  await preview.focus();
  await expect(preview).toBeFocused();
});
test("chart controls share themes and fit scaled narrow panes", async ({ page }, info) => {
  await setup(page);
  await openFile(page, "Charts/Sales.vl.json");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openFile(page, "Charts/Sales.vl.json");
    const controls = page.getByRole("group", { name: "Chart controls", exact: true });
    await expect(controls).toHaveCSS("font-size", "14px");
    await expect(controls).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    await expect(page.getByRole("region", { name: "Chart preview", exact: true }).locator("svg")).toBeVisible();
    await expect(controls.getByRole("status")).toHaveCount(0);
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`chart-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openFile(page, "Charts/Sales.vl.json");
  await page.setViewportSize({ width: 320, height: 900 });
  const controls = page.getByRole("group", { name: "Chart controls", exact: true });
  await expect(controls.getByRole("radio", { name: "Source", exact: true })).toBeInViewport();
  await expect.poll(() => controls.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("region", { name: "Chart preview", exact: true }).locator("svg")).toBeVisible();
  await expect(controls.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("chart-narrow.png") });
});

test("table controls preserve cell edits, structural actions, keyboard menus and source", async ({ page }) => {
  await setup(page);
  await openFile(page, "Projects/Data.csv");
  const controls = page.getByRole("group", { name: "Table controls", exact: true });
  const cell = page.getByRole("textbox", { name: "Row 1, column 2", exact: true });
  await cell.fill("Migrated cell");
  await cell.press("Enter");
  await expect.poll(() => readFile(page, "Projects/Data.csv")).toContain("Migrated cell");
  await controls.getByRole("button", { name: "Row", exact: true }).click();
  await controls.getByRole("button", { name: "Column", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Column 4 header", exact: true })).toHaveText("column 4");
  await cell.focus();
  await cell.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Insert row above", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(cell).toBeFocused();
  await cell.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Insert row below", exact: true }).click();
  await controls.getByRole("radio", { name: "Source", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Migrated cell");
  await controls.getByRole("radio", { name: "Table", exact: true }).click();
  await expect(cell).toHaveText("Migrated cell");
});
test("table controls share themes and fit scaled narrow panes", async ({ page }, info) => {
  await setup(page);
  await openFile(page, "Projects/Data.csv");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openFile(page, "Projects/Data.csv");
    const controls = page.getByRole("group", { name: "Table controls", exact: true });
    await expect(controls).toHaveCSS("font-size", "14px");
    await expect(controls).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`table-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openFile(page, "Projects/Data.csv");
  await page.setViewportSize({ width: 320, height: 900 });
  const controls = page.getByRole("group", { name: "Table controls", exact: true });
  await expect(controls.getByRole("radio", { name: "Source", exact: true })).toBeInViewport();
  await expect(controls.getByRole("button", { name: "Column", exact: true })).toBeInViewport();
  await expect.poll(() => controls.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("table-narrow.png") });
});

test("PDF preserves pages, retries invalid files, and resizes page rendering", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } })
      .__mosaic;
    await m.mockInvoke("write_file", {
      path: "Docs/broken.pdf",
      content: "data:application/pdf;base64,YnJva2Vu",
      expectedHash: null,
    });
  });
  await openFile(page, "Docs/broken.pdf");
  await expect(page.getByRole("alert")).toContainText("Couldn't open this PDF");
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } })
      .__mosaic;
    const content = await m.mockInvoke("read_raw", { path: "Docs/sample.pdf" });
    await m.mockInvoke("write_file", { path: "Docs/broken.pdf", content, expectedHash: null });
  });
  await page.getByRole("button", { name: "Retry PDF", exact: true }).click();
  await expect(page.getByRole("group", { name: "PDF details", exact: true })).toHaveText("2 pages");
  const canvas = page.getByRole("img", { name: "Page 1", exact: true });
  await expect(canvas.locator("..")).not.toHaveAttribute("aria-busy", "true");
  await page.setViewportSize({ width: 500, height: 900 });
  await expect
    .poll(() =>
      canvas.evaluate((el) => el.getBoundingClientRect().width - el.parentElement!.getBoundingClientRect().width),
    )
    .toBeLessThanOrEqual(1);
});
test("PDF metadata and notices share themes and fit scaled narrow panes", async ({ page }, info) => {
  await setup(page);
  await openFile(page, "Docs/sample.pdf");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openFile(page, "Docs/sample.pdf");
    const details = page.getByRole("group", { name: "PDF details", exact: true });
    await expect(details).toHaveCSS("font-size", "13px");
    await expect(details).toHaveCSS("color", theme === "Light" ? "rgb(107, 112, 128)" : "rgb(154, 159, 173)");
    await expect(page.getByRole("img", { name: "Page 1", exact: true }).locator("..")).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`pdf-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openFile(page, "Docs/sample.pdf");
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.getByRole("group", { name: "PDF details", exact: true })).toBeInViewport();
  const canvas = page.getByRole("img", { name: "Page 1", exact: true });
  await expect(canvas.locator("..")).not.toHaveAttribute("aria-busy", "true");
  await expect
    .poll(() =>
      canvas.evaluate((el) => el.getBoundingClientRect().width - el.parentElement!.getBoundingClientRect().width),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("pdf-narrow.png") });
});

async function brokenImage(page: Page) {
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } })
      .__mosaic;
    await m.mockInvoke("write_file", {
      path: "Docs/broken.svg",
      content: "data:image/svg+xml,not-an-image",
      expectedHash: null,
    });
  });
  await openFile(page, "Docs/broken.svg");
}
test("image previews preserve content and retry failed decoding", async ({ page }) => {
  await setup(page);
  await brokenImage(page);
  await expect(page.getByRole("alert")).toContainText("Couldn't open this image");
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } })
      .__mosaic;
    const content = await m.mockInvoke("read_raw", { path: "Attachments/diagram.svg" });
    await m.mockInvoke("write_file", { path: "Docs/broken.svg", content, expectedHash: null });
  });
  await page.getByRole("button", { name: "Retry image", exact: true }).click();
  const image = page.getByRole("img", { name: "Docs/broken.svg", exact: true });
  await expect(image).toBeVisible();
  expect(await image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const preview = page.getByRole("region", { name: "Image preview: Docs/broken.svg", exact: true });
  await preview.focus();
  await expect(preview).toBeFocused();
});
test("image notices share themes and fit scaled narrow panes", async ({ page }, info) => {
  await setup(page);
  await brokenImage(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openFile(page, "Docs/broken.svg");
    const alert = page.getByRole("alert");
    await expect(alert).toHaveCSS("font-size", "14px");
    await expect(alert).toHaveCSS("background-color", theme === "Light" ? "rgb(253, 228, 226)" : "rgb(67, 35, 31)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`image-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openFile(page, "Docs/broken.svg");
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.getByRole("button", { name: "Retry image", exact: true })).toBeInViewport();
  const state = page.getByRole("alert").locator("..");
  await expect.poll(() => state.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("image-narrow.png") });
});
