import { expect, test } from "@playwright/test";

test("window strip follows themes, retains native drag regions and fits narrow windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const strip = page.getByRole("banner", { name: "Window title", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(strip).toHaveCSS("font-size", "13px");
    await expect(strip).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    await expect(strip.locator(".window-version")).toHaveCSS("font-size", "12.5px");
    await expect(strip).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(strip.locator("[data-tauri-drag-region]")).toHaveCount(2);
    await expect(strip).toContainText("Mosaic — Mock vault");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`window-strip-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  for (const width of [720, 480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => strip.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect(strip.locator(".window-version")).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("window-strip-narrow.png") });
  await expect(page.getByRole("navigation", { name: "Destinations", exact: true })).toHaveCSS("font-size", "13px");
});
