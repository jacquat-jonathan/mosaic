import { expect, test } from "@playwright/test";

test("daily notes are optional and keep all creation preferences in Vault folders", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await expect(page.getByRole("button", { name: "Today's note", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: "Vault folders", exact: true }).click();
  const enabled = page.getByRole("switch", { name: "Enable daily notes" });
  await expect(enabled).not.toBeChecked();
  await expect(page.getByLabel("Daily file name", { exact: true })).toHaveCount(0);
  await enabled.click();
  await expect(enabled).toBeEnabled();
  await page.getByLabel("Daily file name", { exact: true }).selectOption("YYYYMMDD");
  await expect(page.getByLabel("Daily file name", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Today's note", exact: true })).toBeVisible();
  await enabled.click();
  await expect(enabled).toBeEnabled();
  await expect(page.getByRole("button", { name: "Today's note", exact: true })).toHaveCount(0);
  await enabled.click();
  await expect(page.getByLabel("Daily file name", { exact: true })).toHaveValue("YYYYMMDD");
  await nav.getByRole("button", { name: "Calendar & note links", exact: true }).click();
  await expect(page.getByLabel("Daily file name", { exact: true })).toHaveCount(0);
});

test("Connections and safety has one home and folder swatches work with the keyboard", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: "Connections & safety", exact: true }).click();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Connections and safety", exact: true })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Connections Close tab", exact: true })).toHaveCount(0);
  await nav.getByRole("button", { name: "Vault folders", exact: true }).click();
  await page.getByRole("textbox", { name: "Filter folders" }).fill("Projects");
  const colors = page.getByRole("radiogroup", { name: "Color for Projects", exact: true });
  await colors.getByRole("radio", { name: "Default", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const red = colors.getByRole("radio", { name: "Red", exact: true });
  await expect(red).toBeChecked();
  await expect(red).toBeEnabled();
  await expect(red).toBeFocused();
  await page.getByRole("region", { name: "Folder colors", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("folder-colors.png") });
});

test("folder color hierarchy expands without changing saved colors and search reveals children", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Vault folders", exact: true })
    .click();
  const child = page.getByRole("radiogroup", { name: "Color for Projects/Mosaic", exact: true });
  await expect(child).toHaveCount(0);
  const expand = page.getByRole("button", { name: "Expand Projects", exact: true });
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(child).toBeVisible();
  await child.getByRole("radio", { name: "Purple", exact: true }).check();
  await expect(child.getByRole("radio", { name: "Purple", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Collapse Projects", exact: true }).click();
  await expect(child).toHaveCount(0);
  const filter = page.getByRole("textbox", { name: "Filter folders" });
  await filter.fill("Mosaic");
  await expect(child).toBeVisible();
  await expect(child.getByRole("radio", { name: "Purple", exact: true })).toBeChecked();
  await filter.clear();
  await expect(child).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Projects", exact: true }).click();
  await expect(child.getByRole("radio", { name: "Purple", exact: true })).toBeChecked();
  await page.getByRole("region", { name: "Folder colors", exact: true }).scrollIntoViewIfNeeded();
  await child.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("folder-color-hierarchy.png") });
});
