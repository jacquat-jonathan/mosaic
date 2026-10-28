import { expect, test, type Page } from "@playwright/test";

async function openAppearance(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("group", { name: "Appearance preferences", exact: true })).toBeVisible();
}

test("appearance follows themes and persists native control changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openAppearance(page);
  const appearance = page.getByRole("group", { name: "Appearance preferences", exact: true });
  const theme = appearance.getByRole("radiogroup", { name: "Theme", exact: true });
  await theme.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(appearance).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await theme.getByRole("radio", { name: "Light", exact: true }).press("ArrowRight");
  await expect(theme.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(appearance).toHaveCSS("background-color", "rgb(30, 31, 36)");
  await theme.getByRole("radio", { name: "System", exact: true }).check();
  await expect(appearance).toHaveCSS("background-color", "rgb(30, 31, 36)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(appearance).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await appearance.getByLabel("Note font", { exact: true }).fill("Georgia");
  await appearance.getByLabel("Code font", { exact: true }).fill("Menlo");
  await appearance.getByRole("slider", { name: "Note text size", exact: true }).press("End");
  await appearance
    .getByRole("radiogroup", { name: "Note width", exact: true })
    .getByRole("radio", { name: "Full", exact: true })
    .check();
  await appearance.getByLabel("Accent color", { exact: true }).selectOption("green");
  await expect
    .poll(() => appearance.evaluate((element) => getComputedStyle(element).getPropertyValue("--mds-accent").trim()))
    .toBe("#15803d");
  await appearance.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await expect(appearance).toHaveAttribute("data-density", "compact");
  await appearance.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await expect(page.locator("html")).toHaveCSS("zoom", "1.3");
  await expect(appearance.getByRole("group", { name: "Appearance preview", exact: true })).toHaveCSS(
    "font-size",
    "22px",
  );

  await openAppearance(page);
  await expect(appearance.getByLabel("Note font", { exact: true })).toHaveValue("Georgia");
  await expect(appearance.getByLabel("Code font", { exact: true })).toHaveValue("Menlo");
  await expect(appearance.getByRole("slider", { name: "Note text size", exact: true })).toHaveValue("22");
  await expect(appearance.getByLabel("Accent color", { exact: true })).toHaveValue("green");
  await expect(appearance.getByLabel("Interface density", { exact: true })).toHaveValue("compact");
  await expect(page.locator("html")).toHaveCSS("zoom", "1.3");
});

test("appearance resets respect cancellation and other settings", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("mosaic:settings", JSON.stringify({ sourceLineNumbers: true, confirmTrash: false })),
  );
  await openAppearance(page);
  const appearance = page.getByRole("group", { name: "Appearance preferences", exact: true });
  await appearance.getByLabel("Note font", { exact: true }).fill("Georgia");
  await appearance.getByLabel("Code font", { exact: true }).fill("Menlo");
  await appearance.getByRole("button", { name: "Reset Note font", exact: true }).click();
  await expect(appearance.getByLabel("Note font", { exact: true })).toHaveValue("system");
  await expect(appearance.getByLabel("Code font", { exact: true })).toHaveValue("Menlo");
  await appearance.getByRole("button", { name: "Reset Appearance…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(appearance.getByRole("button", { name: "Reset Appearance…", exact: true })).toBeFocused();
  await expect(appearance.getByLabel("Code font", { exact: true })).toHaveValue("Menlo");
  await appearance.getByRole("button", { name: "Reset Appearance…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset section", exact: true }).click();
  await expect(appearance.getByRole("button", { name: "Reset Appearance…", exact: true })).toBeFocused();
  await expect(appearance.getByLabel("Code font", { exact: true })).toHaveValue("system");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("mosaic:settings") ?? "{}"));
  expect(stored).toMatchObject({
    sourceLineNumbers: true,
    confirmTrash: false,
    theme: "system",
    noteFont: "system",
    codeFont: "system",
    noteSize: 16,
    noteWidth: "medium",
    lineSpacing: 1.7,
    headingScale: 1,
    accent: "blue",
    uiScale: 1,
    density: "comfortable",
  });
});

test("appearance stays scoped and fits narrow windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await openAppearance(page);
  const appearance = page.getByRole("group", { name: "Appearance preferences", exact: true });
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  await expect(navigation).toHaveCSS("font-size", "14px");
  await expect(appearance).toHaveCSS("font-size", "14px");
  for (const theme of ["Light", "Dark"] as const) {
    await appearance
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page.screenshot({ path: testInfo.outputPath(`appearance-${theme.toLowerCase()}.png`) });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await appearance.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await appearance
    .getByRole("radiogroup", { name: "Note width", exact: true })
    .getByRole("radio", { name: "Full", exact: true })
    .check();
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.locator(".settings-scroll").evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath("appearance-narrow.png") });
  await appearance.getByRole("button", { name: "Reset Interface scale", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expect(page.locator(".sidebar .tree.mosaic-ds")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveCSS("font-size", "13px");
});
