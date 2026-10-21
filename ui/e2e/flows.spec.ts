import { expect, test, type Page } from "@playwright/test";

/** Opens the mock vault from the welcome screen and waits for its file tree. */
async function openVault(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…" }).click();
  await expect(page.getByRole("treeitem", { name: /^Welcome/ })).toBeVisible();
  // The dev-only handle for driving the mock (see main.tsx) is installed after the first render.
  await page.waitForFunction(() => "__mosaic" in window);
}

test("open a note", async ({ page }) => {
  await openVault(page);
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Ideas");
});

test("rename a note and its links follow", async ({ page }) => {
  await openVault(page);
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke: (c: string, a: object) => Promise<unknown> } }).__mosaic;
    await m.mockInvoke("create_file", { path: "E2E/Target.md", content: "# Target", root: null });
    await m.mockInvoke("create_file", { path: "E2E/Source.md", content: "See [[Target]].", root: null });
    (window as unknown as { __mosaic: { external: (p: string[]) => void } }).__mosaic.external([
      "E2E/Target.md",
      "E2E/Source.md",
    ]);
  });
  await page.getByRole("treeitem", { name: "E2E" }).click();
  const target = page.getByRole("treeitem", { name: "Target", exact: true });
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.getByRole("textbox", { name: "New name" });
  await input.fill("Renamed");
  await input.press("Enter");
  await expect(page.getByRole("treeitem", { name: "Renamed", exact: true })).toBeVisible();
  const source = await page.evaluate(() =>
    (window as unknown as { __mosaic: { mockInvoke: (c: string, a: object) => Promise<{ content: string }> } }).__mosaic
      .mockInvoke("read_file", { path: "E2E/Source.md" })
      .then((f) => f.content),
  );
  expect(source).toBe("See [[Renamed]].");
});

test("an outside change to a note being edited asks which version to keep", async ({ page }) => {
  await openVault(page);
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  // Hold the page's timers so the 400 ms autosave can't run: the words stay unsaved. 50 ms lets
  // the editor report the edit to the workspace.
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await page.keyboard.type(" my unsaved words");
  await page.clock.runFor(50);
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: { mockInvoke: (c: string, a: object) => Promise<unknown>; external: (p: string[]) => void };
      }
    ).__mosaic;
    await m.mockInvoke("write_file", {
      path: "Ideas.md",
      content: "# Ideas\n\nChanged by an agent.\n",
      expectedHash: null,
      root: null,
    });
    m.external(["Ideas.md"]);
  });
  await expect(page.getByText("This file changed on disk while you were editing it.")).toBeVisible();
  await page.getByRole("button", { name: "Keep mine" }).click();
  await expect(editor).toContainText("my unsaved words");
});

test("accept an agent's proposal from review", async ({ page }) => {
  await openVault(page);
  await page.evaluate(() =>
    (globalThis as unknown as { mosaicMock: { propose: (p: string, c: string) => number } }).mosaicMock.propose(
      "Welcome.md",
      "# Welcome\n\nRewritten by an agent.\n",
    ),
  );
  await page.getByRole("tab", { name: "AI" }).click();
  await page.getByRole("button", { name: /Activity · 1 need review/ }).click();
  await page.getByRole("region", { name: "Waiting for your review" }).getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByRole("treeitem", { name: /^Welcome/ }).click();
  await expect(page.locator(".cm-content")).toContainText("Rewritten by an agent.");
});

test("calendar event cards only wrap titles when they have room for another line", async ({ page }) => {
  await openVault(page);
  await page.getByRole("tab", { name: "Plan" }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("tab", { name: "Week", exact: true }).click();

  const card = page.locator(".planner-timed-item.overlay"),
    title = card.locator(".planner-card-title");
  await expect(card).toBeVisible();
  await expect(card).toHaveText("Design sync");
  await expect(title).toHaveCSS("text-align", "left");
  await expect(card).toHaveCSS("height", "30px");
  await expect(title).toHaveCSS("white-space", "nowrap");
  const bounds = await card.evaluate((element) => {
    const cardBounds = element.getBoundingClientRect(),
      titleBounds = element.querySelector(".planner-card-title")?.getBoundingClientRect();
    return titleBounds
      ? {
          cardLeft: cardBounds.left,
          cardRight: cardBounds.right,
          titleLeft: titleBounds.left,
          titleRight: titleBounds.right,
        }
      : null;
  });
  expect(bounds).not.toBeNull();
  expect(bounds!.titleLeft).toBeGreaterThanOrEqual(bounds!.cardLeft);
  expect(bounds!.titleRight).toBeLessThanOrEqual(bounds!.cardRight);

  await page.setViewportSize({ width: 1280, height: 1200 });
  await expect(card).toHaveClass(/multiline-title/);
  await expect(title).toHaveCSS("white-space", "normal");
});
