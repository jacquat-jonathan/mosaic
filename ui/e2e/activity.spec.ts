import { expect, test, type Page } from "@playwright/test";
async function openActivity(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.evaluate(() =>
    (globalThis as unknown as { mosaicMock: { propose(path: string, content: string): number } }).mosaicMock.propose(
      "Welcome.md",
      "# Welcome\n\nProposed summary.\n",
    ),
  );
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("radio", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: /Activity & review/ }).click();
}
test("activity keeps pending proposals first and restores review history and undo focus", async ({ page }) => {
  await openActivity(page);
  const pending = page.getByRole("region", { name: "Waiting for your review", exact: true });
  const applied = page.getByRole("region", { name: "Applied changes", exact: true });
  expect((await pending.boundingBox())!.y).toBeLessThan((await applied.boundingBox())!.y);
  const review = pending.getByRole("button", { name: "Review", exact: true });
  await review.click();
  const dialog = page.getByRole("dialog", { name: /Review the change to Welcome/ });
  await expect(dialog).toHaveCSS("font-size", "14px");
  expect(await dialog.evaluate((element) => element.closest(".mosaic-ds") !== null)).toBe(true);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(review).toBeFocused();
  const row = applied
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "Agent notes", exact: true }) });
  const history = row.getByRole("button", { name: "File history", exact: true });
  await history.click();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(history).toBeFocused();
  await row.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row.getByRole("button", { name: "Undone", exact: true })).toBeDisabled();
  await expect(history).toBeFocused();
});
test("activity rows follow themes and wrap in narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openActivity(page);
  const ledger = page.getByRole("group", { name: "Activity and review", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page.getByRole("button", { name: /Activity & review/ }).click();
    await expect(ledger).toHaveCSS("font-size", "14px");
    await expect(ledger).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await expect(ledger.locator(".mds-change-meta").first()).toHaveCSS("font-size", "13px");
    if (theme !== "System") await page.screenshot({ path: testInfo.outputPath(`activity-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("button", { name: /Activity & review/ }).click();
  await expect(ledger).toHaveAttribute("data-density", "compact");
  for (const width of [920, 720, 650, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => ledger.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("activity-narrow.png") });
});
