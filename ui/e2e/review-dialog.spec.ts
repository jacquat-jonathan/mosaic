import { expect, test, type Page } from "@playwright/test";

async function openReview(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.evaluate(() =>
    (globalThis as unknown as { mosaicMock: { propose(path: string, content: string): number } }).mosaicMock.propose(
      "Welcome.md",
      "# Welcome\n\nProposed summary.\n",
    ),
  );
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: /Activity & review/ }).click();
  await page
    .getByRole("region", { name: "Waiting for your review", exact: true })
    .getByRole("button", { name: "Review", exact: true })
    .click();
}
for (const fallback of [false, true]) {
  test.describe(fallback ? "WebKit compatibility fallback" : "Native dialog", () => {
    test.beforeEach(async ({ page }) => {
      if (fallback)
        await page.addInitScript(() => {
          Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: undefined });
          Reflect.deleteProperty(HTMLElement.prototype, "inert");
        });
    });
    test("review contains focus, preserves rejection drafts and returns focus after Escape", async ({ page }) => {
      await openReview(page);
      const dialog = page.getByRole("dialog", { name: "Review the change to Welcome", exact: true });
      const close = dialog.getByRole("button", { name: "Close dialog", exact: true });
      await expect(close).toBeFocused();
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      if (fallback) await expect(dialog).toHaveClass(/mds-dialog--fallback/);
      await expect(dialog.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
      await close.press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: "Accept", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      if (fallback) {
        await page
          .getByRole("button", { name: "Settings", exact: true, includeHidden: true })
          .evaluate((element) => element.focus());
        await expect(close).toBeFocused();
      }
      await page.keyboard.press("Escape");
      const review = page
        .getByRole("region", { name: "Waiting for your review", exact: true })
        .getByRole("button", { name: "Review", exact: true });
      await expect(review).toBeFocused();
      await review.click();
      await dialog.getByRole("button", { name: "Reject…", exact: true }).click();
      const reason = dialog.getByRole("textbox", { name: /Tell the agent why/ });
      await expect(reason).toBeFocused();
      await reason.fill("Keep the original examples.");
      await dialog.getByRole("button", { name: "Back", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Reject…", exact: true })).toBeFocused();
      await dialog.getByRole("button", { name: "Reject…", exact: true }).click();
      await expect(reason).toHaveValue("Keep the original examples.");
      await dialog.getByRole("button", { name: "Reject", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Activity & review", exact: true })).toBeFocused();
      await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    });
    test("review follows themes and keeps diffs and actions within narrow windows", async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await openReview(page);
      const dialog = page.getByRole("dialog", { name: "Review the change to Welcome", exact: true });
      for (const theme of ["Light", "Dark", "System"] as const) {
        await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page
          .getByRole("radiogroup", { name: "Theme", exact: true })
          .getByRole("radio", { name: theme, exact: true })
          .check();
        await page.getByRole("button", { name: /Activity & review/ }).click();
        await page
          .getByRole("region", { name: "Waiting for your review", exact: true })
          .getByRole("button", { name: "Review", exact: true })
          .click();
        await expect(dialog).toHaveCSS("font-size", "14px");
        await expect(dialog).toHaveCSS(
          "background-color",
          theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)",
        );
        await expect(dialog.locator(".mds-diff")).toContainText("Proposed summary.");
        if (theme !== "System")
          await page.screenshot({ path: testInfo.outputPath(`review-${theme.toLowerCase()}.png`) });
      }
      await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
      await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
      await page.getByRole("button", { name: /Activity & review/ }).click();
      await page
        .getByRole("region", { name: "Waiting for your review", exact: true })
        .getByRole("button", { name: "Review", exact: true })
        .click();
      for (const width of [920, 720, 650, 480]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth))
          .toBeLessThanOrEqual(1);
        await expect
          .poll(async () => {
            const box = (await dialog.boundingBox())!;
            return Math.max(-box.x, box.x + box.width - width, -box.y, box.y + box.height - 900);
          })
          .toBeLessThanOrEqual(1);
      }
      await dialog.getByRole("button", { name: "Reject…", exact: true }).click();
      await dialog.getByRole("textbox", { name: /Tell the agent why/ }).fill("Keep the examples.");
      await dialog.getByRole("button", { name: "Reject", exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole("button", { name: "Reject", exact: true })).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeInViewport();
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await page.screenshot({ path: testInfo.outputPath("review-narrow.png") });
    });
  });
}
