import { expect, test, type Page } from "@playwright/test";

async function openCalendar(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Calendar & links", exact: true })
    .click();
}
async function vaultPreferences(page: Page) {
  return page.evaluate(async () =>
    (
      window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<object> } }
    ).__mosaic.mockInvoke("vault_preferences", {}),
  );
}
test("calendar preferences persist and reset keeps vault choices", async ({ page }) => {
  await openCalendar(page);
  const calendar = page.getByRole("group", { name: "Calendar & links preferences", exact: true });
  await calendar.getByLabel("Week starts on", { exact: true }).selectOption("sunday");
  await calendar.getByRole("switch", { name: "Open note links in a new tab", exact: true }).focus();
  await page.keyboard.press("Space");
  await calendar.getByLabel("Daily file name", { exact: true }).selectOption("YYYYMMDD");
  await expect(calendar.getByLabel("Daily file name", { exact: true })).toBeEnabled();
  await expect(calendar.getByText("Daily/20261008.md", { exact: true })).toBeVisible();
  await calendar.getByLabel("New link syntax", { exact: true }).selectOption("markdown");
  await expect.poll(() => vaultPreferences(page)).toMatchObject({ daily_format: "YYYYMMDD", link_style: "markdown" });
  await expect(calendar.getByLabel("New link syntax", { exact: true })).toBeEnabled();
  const reset = calendar.getByRole("button", { name: "Reset Calendar app preferences…", exact: true });
  await reset.click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reset).toBeFocused();
  await expect(calendar.getByLabel("Week starts on", { exact: true })).toHaveValue("sunday");
  await reset.click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset section", exact: true }).click();
  await expect(reset).toBeFocused();
  await expect(calendar.getByLabel("Week starts on", { exact: true })).toHaveValue("monday");
  expect(await vaultPreferences(page)).toMatchObject({ daily_format: "YYYYMMDD", link_style: "markdown" });
  await calendar.getByRole("button", { name: "Reset Daily file name", exact: true }).click();
  await expect.poll(() => vaultPreferences(page)).toMatchObject({ daily_format: "YYYY-MM-DD", link_style: "markdown" });
  await expect(calendar.getByLabel("Daily file name", { exact: true })).toBeEnabled();
  await calendar.getByRole("button", { name: "Reset New link syntax", exact: true }).click();
  await expect.poll(() => vaultPreferences(page)).toMatchObject({ link_style: "wiki" });
});

test("calendar preferences follow themes and fit narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openCalendar(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const calendar = page.getByRole("group", { name: "Calendar & links preferences", exact: true });
  await expect(calendar).toHaveCSS("font-size", "14px");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await navigation.getByRole("button", { name: "Calendar & links", exact: true }).click();
    await expect(calendar).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`calendar-links-${theme.toLowerCase()}.png`) });
  }
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await navigation.getByRole("button", { name: "Calendar & links", exact: true }).click();
  await expect(calendar).toHaveAttribute("data-density", "compact");
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
  await page.screenshot({ path: testInfo.outputPath("calendar-links-narrow.png") });
});
