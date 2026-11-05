import { expect, test, type Page } from "@playwright/test";
import { COLOR_THEMES } from "../src/colorThemes";

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
async function openAppearance(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("group", { name: "Appearance preferences", exact: true });
}

test("every palette colors notes, navigation, settings and dialogs in both modes", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const appearance = await openAppearance(page);
  for (const palette of COLOR_THEMES) {
    await appearance
      .getByRole("radiogroup", { name: "Color theme", exact: true })
      .getByRole("radio", { name: palette.name, exact: true })
      .check();
    for (const mode of ["light", "dark"] as const) {
      await appearance
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "light" ? "Light" : "Dark", exact: true })
        .check();
      const colors = palette[mode];
      await expect(appearance).toHaveCSS("background-color", rgb(colors.bg));
      await expect(appearance).toHaveCSS("color", rgb(colors.text));
      await expect(page.locator("html")).toHaveCSS("background-color", rgb(colors.bg));
      await expect(page.getByRole("navigation", { name: "Settings sections", exact: true })).toHaveCSS(
        "background-color",
        rgb(colors.side),
      );
      await expect
        .poll(() => appearance.evaluate((el) => getComputedStyle(el).getPropertyValue("--mds-accent").trim()))
        .toBe(colors.accent);
      await appearance.scrollIntoViewIfNeeded();
      await page.locator(".settings-scroll").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({ path: info.outputPath(`${palette.id}-${mode}.png`) });
    }
  }
  await appearance.getByRole("button", { name: "Reset Appearance…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCSS("background-color", rgb(COLOR_THEMES[4].dark.bg));
  await expect(dialog.getByRole("button", { name: "Reset section", exact: true })).toHaveCSS(
    "color",
    rgb(COLOR_THEMES[4].dark.text),
  );
  await expect
    .poll(() => dialog.evaluate((el) => getComputedStyle(el).getPropertyValue("--mds-on-accent").trim()))
    .toBe(COLOR_THEMES[4].dark.bg);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("palette keyboard selection persists, follows system changes and preserves custom accents", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  const appearance = await openAppearance(page);
  const palettes = appearance.getByRole("radiogroup", { name: "Color theme", exact: true });
  await palettes.getByRole("radio", { name: "Classic", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(palettes.getByRole("radio", { name: "Paper", exact: true })).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(palettes.getByRole("radio", { name: "Forest", exact: true })).toBeChecked();
  await expect(appearance).toHaveCSS("background-color", rgb(COLOR_THEMES[2].light.bg));
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(appearance).toHaveCSS("background-color", rgb(COLOR_THEMES[2].dark.bg));
  await appearance.getByLabel("Accent color", { exact: true }).selectOption("violet");
  await palettes.getByRole("radio", { name: "Ocean", exact: true }).check();
  await expect
    .poll(() => appearance.evaluate((el) => getComputedStyle(el).getPropertyValue("--mds-accent").trim()))
    .toBe("#c4acff");
  await openAppearance(page);
  await expect(palettes.getByRole("radio", { name: "Ocean", exact: true })).toBeChecked();
  await expect(appearance.getByLabel("Accent color", { exact: true })).toHaveValue("violet");
  await appearance.getByRole("button", { name: "Reset Color theme", exact: true }).click();
  await expect(palettes.getByRole("radio", { name: "Classic", exact: true })).toBeChecked();
  await expect(appearance.getByLabel("Accent color", { exact: true })).toHaveValue("violet");
  await palettes.getByRole("radio", { name: "Dusk", exact: true }).check();
  await appearance.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() => page.locator(".color-theme-options").evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await palettes.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("palette-picker-narrow.png") });
});
