import { expect, test, type Page } from "@playwright/test";
async function openHistory(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: /Activity & review/ }).click();
  await showHistory(page);
}
async function showHistory(page: Page) {
  const row = page
    .getByRole("region", { name: "Applied changes", exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "Ideas", exact: true }) });
  await row.getByRole("button", { name: "File history", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "History of Ideas", exact: true }).getByRole("option")).toHaveCount(2);
}
for (const fallback of [false, true]) {
  test(`${fallback ? "fallback" : "native"} history preserves keyboard selection restore and return focus`, async ({
    page,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: undefined });
        Reflect.deleteProperty(HTMLElement.prototype, "inert");
      });
    await openHistory(page);
    const dialog = page.getByRole("dialog", { name: "History of Ideas", exact: true });
    await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Restore this version", exact: true })).toBeDisabled();
    const selected = dialog.getByRole("option", { selected: true });
    await selected.focus();
    await selected.press("ArrowDown");
    await expect(dialog.getByRole("option", { selected: true })).toContainText("Earlier version");
    await expect(dialog.locator(".mds-diff")).toContainText("File history (added by an agent)");
    await dialog.getByRole("button", { name: "Restore this version", exact: true }).click();
    await expect(
      dialog.getByText("Version restored. The previous file remains available in history.", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Restore this version", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const row = page
      .getByRole("region", { name: "Applied changes", exact: true })
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name: "Ideas", exact: true }) })
      .first();
    await expect(row.getByRole("button", { name: "File history", exact: true })).toBeFocused();
    await row.getByRole("button", { name: "Ideas", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("Graph view");
    await expect(page.locator(".cm-content")).not.toContainText("File history (added by an agent)");
  });
}
test("file history follows themes and keeps version selection and restore visible in narrow windows", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openHistory(page);
  const dialog = page.getByRole("dialog", { name: "History of Ideas", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page.getByRole("button", { name: /Activity & review/ }).click();
    await showHistory(page);
    await dialog.getByRole("option", { selected: true }).press("ArrowDown");
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await expect(dialog.locator(".mds-diff")).toBeVisible();
    if (theme !== "System") await page.screenshot({ path: testInfo.outputPath(`history-${theme.toLowerCase()}.png`) });
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("button", { name: /Activity & review/ }).click();
  await showHistory(page);
  await dialog.getByRole("option", { selected: true }).press("ArrowDown");
  for (const width of [920, 720, 650, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect(dialog.getByRole("button", { name: "Restore this version", exact: true })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeInViewport();
  }
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("history-narrow.png") });
});
