import { expect, test, type Page } from "@playwright/test";
import { openMockVault } from "./mock-vault";

async function readNote(page: Page) {
  return page.evaluate(async () => {
    const mock = (
      window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<{ content: string }> } }
    ).__mosaic;
    return (await mock.mockInvoke("read_file", { path: "Resize.md" })).content;
  });
}

for (const [syntax, scale] of [
  ["wiki", 1],
  ["markdown", 1],
  ["wiki", 1.5],
  ["markdown", 1.5],
] as const) {
  test(`${syntax} image resizing at ${scale}x saves widths, supports undo, reset and reopening`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1280 * scale, height: 900 * scale });
    await page.goto("/");
    await openMockVault(page);
    await page.evaluate(async (syntax) => {
      const mock = (
        window as unknown as {
          __mosaic: {
            mockInvoke(command: string, args: object): Promise<unknown>;
            useVault: { getState(): { refresh(): Promise<void> } };
            useWorkspace: { getState(): { open(path: string, options: object): Promise<void> } };
          };
        }
      ).__mosaic;
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#6477d4"/><text x="30" y="160" fill="white" font-size="32">Resize this image</text></svg>';
      await mock.mockInvoke("create_file", {
        path: "Resize.svg",
        content: `data:image/svg+xml,${encodeURIComponent(svg)}`,
        root: null,
      });
      await mock.mockInvoke("create_file", {
        path: "Resize.md",
        content: `# Image sizing\n\n${syntax === "wiki" ? "![[Resize.svg|240]]" : "![Diagram|240](Resize.svg)"}\n\nEnd\n`,
        root: null,
      });
      await mock.useVault.getState().refresh();
      await mock.useWorkspace.getState().open("Resize.md", { newTab: true });
    }, syntax);
    await page.evaluate((scale) => {
      document.documentElement.style.zoom = String(scale);
    }, scale);
    const image = page.locator(".cm-embed-image img");
    const handle = page.getByRole("button", { name: /^Resize image / });
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty("naturalWidth", 600);
    const beforeClick = await readNote(page);
    await image.click();
    await expect(image).toBeVisible();
    expect(await readNote(page)).toBe(beforeClick);
    await handle.focus();
    await handle.press("ArrowRight");
    await expect.poll(() => readNote(page)).toContain("|250");
    await expect(image).toHaveAttribute("width", "250");
    await expect(handle).toBeFocused();
    await handle.press("Escape");
    await page.locator(".cm-content").press("Meta+z");
    await expect.poll(() => readNote(page)).toContain("|240");
    await image.hover();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100 * scale, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => readNote(page)).toContain("|340");
    await expect(image).toHaveAttribute("width", "340");
    await page.screenshot({ path: info.outputPath(`image-resize-${syntax}.png`) });
    await page.getByRole("treeitem", { name: /^Welcome/ }).click();
    await page.getByRole("treeitem", { name: /^Resize$/ }).click();
    await expect(image).toHaveAttribute("width", "340");
    await handle.focus();
    await handle.press("Home");
    await expect.poll(() => readNote(page)).not.toMatch(/\|\d+/);
    await expect(image).not.toHaveAttribute("width");
    const smaller = await image.evaluate((element) => element.clientWidth - 10);
    await handle.press("ArrowLeft");
    await expect.poll(() => readNote(page)).toContain(`|${smaller}`);
    await image.hover();
    const resetBox = (await handle.boundingBox())!;
    await page.mouse.move(resetBox.x + 9, resetBox.y + 9);
    await page.mouse.down();
    await page.mouse.move(resetBox.x - 80, resetBox.y + 9, { steps: 3 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(image).toHaveAttribute("width", String(smaller));
    expect(await readNote(page)).toContain(`|${smaller}`);
    await page.evaluate(() => {
      const state = { text: "", pngBytes: 0, pngType: "", pngWidth: 0, fail: false };
      (window as unknown as { imageClipboard: typeof state }).imageClipboard = state;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            state.text = text;
          },
          write: async (items: ClipboardItem[]) => {
            if (state.fail) throw new Error("Clipboard denied");
            const blob = await items[0].getType("image/png");
            state.pngBytes = blob.size;
            state.pngType = blob.type;
            const url = URL.createObjectURL(blob);
            try {
              const img = new Image();
              img.src = url;
              await img.decode();
              state.pngWidth = img.naturalWidth;
            } finally {
              URL.revokeObjectURL(url);
            }
          },
        },
      });
    });
    await image.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Actions", exact: true });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: info.outputPath(`image-actions-${syntax}.png`) });
    await menu.getByRole("menuitem", { name: "Copy image reference", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { imageClipboard: { text: string } }).imageClipboard.text))
      .toContain(`|${smaller}`);
    await image.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy image", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { imageClipboard: { pngWidth: number } }).imageClipboard.pngWidth),
      )
      .toBe(600);
    expect(
      await page.evaluate(() => (window as unknown as { imageClipboard: { pngType: string } }).imageClipboard.pngType),
    ).toBe("image/png");
    await image.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Reset image size", exact: true }).click();
    await expect(image).not.toHaveAttribute("width");
    await image.click();
    await page.getByRole("group", { name: "Image actions", exact: true }).press("Shift+F10");
    await menu.getByRole("menuitem", { name: "Edit image source", exact: true }).click();
    await expect(image).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText(
      syntax === "wiki" ? "![[Resize.svg]]" : "![Diagram](Resize.svg)",
    );
  });
}
