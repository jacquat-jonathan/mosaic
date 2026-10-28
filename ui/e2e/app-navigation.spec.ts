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
  await expect(page.locator(".settings-workspace")).not.toHaveClass(/mosaic-ds/);
});

test("destination rail preserves keyboard activation sidebar toggling and accessible attention counts", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Destinations", exact: true });
  const files = nav.getByRole("tab", { name: "Files", exact: true });
  const find = nav.getByRole("tab", { name: "Find", exact: true });
  const plan = nav.getByRole("tab", { name: "Plan", exact: true });
  const ai = nav.getByRole("tab", { name: "AI", exact: true });
  await files.press("End");
  await expect(ai).toBeFocused();
  await expect(ai).toHaveAttribute("aria-selected", "true");
  await ai.press("ArrowUp");
  await expect(plan).toBeFocused();
  await plan.press("ArrowUp");
  await expect(find).toBeFocused();
  await expect(page.getByLabel("Search notes", { exact: true })).toBeVisible();
  await find.press("Home");
  await expect(files).toBeFocused();
  await expect(files).toHaveCSS("outline-style", "solid");
  await files.click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await files.click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page.evaluate(() =>
    (globalThis as unknown as { mosaicMock: { propose(path: string, content: string): number } }).mosaicMock.propose(
      "Welcome.md",
      "Proposed update",
    ),
  );
  await expect(ai).toHaveAccessibleDescription("1 need attention");
  await expect(ai.locator(".destination-attention")).toHaveText("1");
  const settings = nav.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toHaveAttribute("title", /Settings \(.+\)/);
  await settings.click();
  await expect(settings).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
});

test("destination rail follows themes and remains reachable at maximum scale", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Destinations", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await nav.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(nav).toHaveCSS("font-size", "14px");
    await expect(nav).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`destination-rail-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  for (const width of [720, 480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(nav.getByRole("tab", { name: "Files", exact: true })).toBeInViewport();
    await expect(nav.getByRole("button", { name: "Settings", exact: true })).toBeInViewport();
    await expect
      .poll(() => nav.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath("destination-rail-narrow.png") });
  await expect(page.locator(".settings-workspace")).not.toHaveClass(/mosaic-ds/);
});
