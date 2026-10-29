import { expect, test, type Page } from "@playwright/test";
async function setup(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.waitForFunction(() => "__mosaic" in window);
}
async function prompt(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/state/ui.ts";
    const { useUi } = await import(path);
    void useUi.getState().askText({ title: "Rename file", value: "Original.md" });
  });
}
test("prompt contains keyboard focus, selects text and returns focus", async ({ page }) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "New note", exact: true });
  await opener.focus();
  await prompt(page);
  const dialog = page.getByRole("dialog", { name: "Rename file", exact: true });
  const input = dialog.getByRole("textbox", { name: "Rename file", exact: true });
  await expect(input).toBeFocused();
  expect(await input.evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!)).toBe(11);
  await dialog.getByRole("button", { name: "OK", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await input.fill("Updated.md");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await prompt(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
test("prompt shares themes and fits scaled narrow windows", async ({ page }, info) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await prompt(page);
    const dialog = page.getByRole("dialog", { name: "Rename file", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`prompt-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await prompt(page);
  const dialog = page.getByRole("dialog", { name: "Rename file", exact: true });
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("prompt-narrow.png") });
});

async function confirm(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/state/ui.ts";
    const { useUi } = await import(path);
    void useUi.getState().ask({
      title: "Delete file?",
      body: "Move this file to trash. You can restore it from history.",
      confirmLabel: "Delete",
      danger: true,
    });
  });
}
test("confirmation traps focus and cancels with focus return", async ({ page }) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "New note", exact: true });
  await opener.focus();
  await confirm(page);
  const dialog = page.getByRole("dialog", { name: "Delete file?", exact: true });
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await confirm(page);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test("confirmation shares themes and fits scaled narrow windows", async ({ page }, info) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await confirm(page);
    const dialog = page.getByRole("dialog", { name: "Delete file?", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`confirmation-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await confirm(page);
  const dialog = page.getByRole("dialog", { name: "Delete file?", exact: true });
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("confirmation-narrow.png") });
});
