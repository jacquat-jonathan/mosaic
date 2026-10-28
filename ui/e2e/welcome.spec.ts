import { expect, test } from "@playwright/test";

test("welcome preserves create cancellation and opens the named vault", async ({ page }) => {
  await page.goto("/");
  const welcome = page.getByRole("main", { name: "Welcome", exact: true });
  const create = welcome.getByRole("button", { name: "Create new vault…", exact: true });
  await create.click();
  await expect(welcome.getByRole("button", { name: "Open folder…", exact: true })).toBeDisabled();
  await expect(page.locator(".modal input")).toBeFocused();
  await page.locator(".modal").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(create).toBeFocused();
  await create.press("Enter");
  await page.locator(".modal input").fill("Migration welcome vault");
  await page.locator(".modal").getByRole("button", { name: "OK", exact: true }).click();
  await expect(welcome).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: /^Welcome/ })).toBeVisible();
});

test("welcome follows saved themes and fits narrow and short windows", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const query = new URLSearchParams(location.search);
    localStorage.setItem(
      "mosaic:settings",
      JSON.stringify({
        theme: query.get("welcomeTheme") || "system",
        uiScale: Number(query.get("welcomeScale") || 1),
        density: query.get("welcomeDensity") || "comfortable",
      }),
    );
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const welcome = page.getByRole("main", { name: "Welcome", exact: true });
  for (const theme of ["light", "dark", "system"]) {
    await page.goto(`/?welcomeTheme=${theme}`);
    await expect(welcome.getByRole("button", { name: "Open folder…", exact: true })).toBeEnabled();
    await expect(welcome).toHaveCSS("font-size", "14px");
    await expect(welcome).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "system") await page.screenshot({ path: testInfo.outputPath(`welcome-${theme}.png`) });
  }
  await page.goto("/?welcomeTheme=system&welcomeScale=1.3&welcomeDensity=compact");
  await expect(welcome.getByRole("button", { name: "Open folder…", exact: true })).toBeEnabled();
  await expect(welcome).toHaveAttribute("data-density", "compact");
  for (const width of [720, 480, 320]) {
    await page.setViewportSize({ width, height: 720 });
    await expect
      .poll(() => welcome.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect(welcome.getByRole("button", { name: "Open folder…", exact: true })).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("welcome-narrow.png") });
  await page.setViewportSize({ width: 480, height: 320 });
  await welcome.getByRole("button", { name: "Create new vault…", exact: true }).scrollIntoViewIfNeeded();
  await expect(welcome.getByRole("button", { name: "Create new vault…", exact: true })).toBeInViewport();
  await welcome.getByRole("button", { name: "Open folder…", exact: true }).click();
  await expect(welcome).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Destinations", exact: true })).toBeVisible();
});
