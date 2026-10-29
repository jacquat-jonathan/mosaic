import { expect, test, type Page } from "@playwright/test";
async function openAbout(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "About & updates", exact: true })
    .click();
}
test("update checks, cancellation and ready progress survive Settings navigation", async ({ page }) => {
  await openAbout(page);
  const about = page.getByRole("group", { name: "About and update preferences", exact: true });
  const check = about.getByRole("button", { name: "Check for updates", exact: true });
  const download = about.getByRole("button", { name: "Download update", exact: true });
  await expect(download).toBeDisabled();
  await check.focus();
  await check.press("Space");
  await expect(about.getByRole("region", { name: "Available releases", exact: true })).toBeVisible();
  await download.click();
  await expect(check).toBeDisabled();
  await about.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(about.getByText("Update cancelled. The installed app wasn't changed.", { exact: true })).toBeVisible();
  await expect(check).toBeFocused();
  await download.click();
  const nav = page.getByRole("navigation", { name: "Settings sections", exact: true });
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  await nav.getByRole("button", { name: "About & updates", exact: true }).click();
  await expect(about.getByRole("button", { name: "Restart to finish", exact: true })).toBeVisible();
  await about.locator("summary").click();
  await expect(about.getByRole("log", { name: "Update log", exact: true })).toContainText("BUILT_APP=");
  await expect(about.getByRole("button", { name: "Download update", exact: true })).toHaveCount(0);
});

test("update controls follow themes and fit narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openAbout(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const about = page.getByRole("group", { name: "About and update preferences", exact: true });
  await expect(about).toHaveCSS("font-size", "14px");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await navigation.getByRole("button", { name: "About & updates", exact: true }).click();
    await expect(about).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await about.getByRole("button", { name: "Check for updates", exact: true }).click();
    await expect(about.getByRole("region", { name: "Available releases", exact: true })).toBeVisible();
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`about-updates-${theme.toLowerCase()}.png`) });
  }
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await navigation.getByRole("button", { name: "About & updates", exact: true }).click();
  await expect(about).toHaveAttribute("data-density", "compact");
  await about.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(about.getByRole("region", { name: "Available releases", exact: true })).toBeVisible();
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
  await page.screenshot({ path: testInfo.outputPath("about-updates-narrow.png") });
});
