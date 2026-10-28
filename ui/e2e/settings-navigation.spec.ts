import { expect, test, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Settings sections", exact: true })).toBeVisible();
}

test("settings search and navigation work with the keyboard and close their tab", async ({ page, browserName }) => {
  // Safari's default Tab preference skips buttons; Option-Tab includes every native control.
  const nextControl = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await openSettings(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const search = navigation.getByRole("textbox", { name: "Search settings", exact: true });
  await search.fill("trash");
  const result = navigation.getByRole("region", { name: "Settings search results", exact: true });
  await search.press(nextControl);
  await expect(result.getByRole("button", { name: "Editor & files", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(result).toHaveCount(0);
  await expect(page.locator(".settings-head").getByRole("heading", { name: "Editor & files" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Editor & files", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("switch", { name: "Spellcheck", exact: true })).toHaveClass("toggle on");
  await expect(page.locator(".settings-scroll")).toHaveCSS("font-size", "13px");
  await expect(page.locator(".settings-scroll .mosaic-ds")).toHaveCount(0);

  await search.fill("definitely absent");
  await expect(navigation.getByRole("status")).toHaveText("No matching settings.");
  await search.clear();
  const about = navigation.getByRole("button", { name: "About & updates", exact: true });
  await about.focus();
  await about.press("Enter");
  await expect(page.locator(".settings-head h2")).toHaveText("About & updates");
  await about.press(nextControl);
  const close = page.getByRole("button", { name: "Close settings", exact: true });
  await expect(close).toBeFocused();
  await close.press("Enter");
  await expect(page.locator(".settings")).toHaveCount(0);
});

test("settings chrome follows themes and fits narrow panes at maximum scale", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openSettings(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const header = page.locator(".settings-head");
  const appearance = page.getByRole("group", { name: "Appearance preferences", exact: true });
  await expect(navigation).toHaveCSS("font-size", "14px");
  await expect(header.locator("h2")).toHaveCSS("font-size", "17px");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await appearance
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(navigation).toHaveCSS(
      "background-color",
      theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)",
    );
    await expect(header).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`settings-navigation-${theme.toLowerCase()}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expect(navigation).toHaveCSS("background-color", "rgb(246, 246, 248)");
  await appearance.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await expect(navigation).toHaveAttribute("data-density", "compact");
  await appearance.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    for (const selector of [".settings", ".settings-nav", ".settings-scroll"]) {
      await expect
        .poll(() => page.locator(selector).evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1);
    }
    await navigation.getByRole("button", { name: "About & updates", exact: true }).click();
    await expect(header.locator("h2")).toHaveText("About & updates");
    await navigation.getByRole("button", { name: "Editor & files", exact: true }).click();
    await expect(header.locator("h2")).toHaveText("Editor & files");
    await expect(page.getByRole("switch", { name: "Spellcheck", exact: true })).toBeVisible();
  }
  await navigation.getByRole("textbox", { name: "Search settings", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("settings-navigation-narrow.png") });
});
