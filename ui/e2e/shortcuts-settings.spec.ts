import { expect, test, type Page } from "@playwright/test";
async function openShortcuts(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Shortcuts", exact: true })
    .click();
}
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("mosaic:settings") ?? "{}").shortcuts ?? {});
test("shortcut capture supports cancel, conflicts, removal and reset without running commands", async ({
  page,
  browserName,
}) => {
  await openShortcuts(page);
  const shortcuts = page.getByRole("group", { name: "Shortcut preferences", exact: true });
  const palette = shortcuts.getByRole("button", { name: "Change shortcut for Open command palette", exact: true });
  const switcher = shortcuts.getByRole("button", {
    name: "Change shortcut for Quick switcher: open a file",
    exact: true,
  });
  await palette.click();
  await expect(palette).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(palette).toBeFocused();
  expect(await saved(page)).toEqual({});
  await palette.press("Space");
  await page.keyboard.press("a");
  await expect(shortcuts.getByText("Shortcuts start with", { exact: false })).toBeVisible();
  expect(await saved(page)).toEqual({});
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(palette).toHaveAttribute("aria-pressed", "false");
  await palette.click();
  await page.keyboard.press("Meta+o");
  await expect(palette).toHaveText("⌘O");
  await expect(switcher).toHaveText("None");
  await expect(shortcuts.getByText(/was used by.*Quick switcher/)).toBeVisible();
  expect(await saved(page)).toMatchObject({ palette: { code: "KeyO", meta: true }, switcher: null });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await palette.click();
  await page.keyboard.press("Backspace");
  await expect(palette).toHaveText("None");
  expect(await saved(page)).toMatchObject({ palette: null });
  await shortcuts.getByRole("button", { name: "Reset all shortcuts", exact: true }).click();
  await expect(palette).toBeFocused();
  await expect(palette).toHaveText("⌘P");
  await expect(switcher).toHaveText("⌘O");
  expect(await saved(page)).toEqual({});
});

test("shortcut preferences follow themes and fit narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openShortcuts(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const shortcuts = page.getByRole("group", { name: "Shortcut preferences", exact: true });
  await expect(shortcuts).toHaveCSS("font-size", "14px");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await navigation.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await expect(shortcuts).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`shortcuts-${theme.toLowerCase()}.png`) });
  }
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await navigation.getByRole("button", { name: "Shortcuts", exact: true }).click();
  await expect(shortcuts).toHaveAttribute("data-density", "compact");
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.locator(".settings-scroll").evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.locator(".settings-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await navigation.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("shortcuts-narrow.png") });
});
