import { expect, test, type Page } from "@playwright/test";

async function openEditor(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Editor & files", exact: true })
    .click();
}

async function htmlPolicy(page: Page) {
  return page.evaluate(async () => {
    const mock = (
      window as unknown as {
        __mosaic: { mockInvoke(command: string, args: object): Promise<{ allow_html_scripts: boolean }> };
      }
    ).__mosaic;
    return (await mock.mockInvoke("vault_preferences", {})).allow_html_scripts;
  });
}

test("Editor switches persist and resets preserve vault and unrelated app preferences", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("mosaic:settings"))
      localStorage.setItem("mosaic:settings", JSON.stringify({ noteFont: "Georgia", weekStart: "sunday" }));
  });
  await openEditor(page);
  const editor = page.getByRole("group", { name: "Editor & files preferences", exact: true });
  const spellcheck = editor.getByRole("switch", { name: "Spellcheck", exact: true });
  const numbers = editor.getByRole("switch", { name: "Source line numbers", exact: true });
  const trash = editor.getByRole("switch", { name: "Ask before moving to the Trash", exact: true });
  const scripts = editor.getByRole("switch", { name: "Allow scripts in HTML previews", exact: true });
  await spellcheck.focus();
  await spellcheck.press("Space");
  await expect(spellcheck).toHaveAttribute("aria-checked", "false");
  await numbers.click();
  await trash.click();
  await scripts.click();
  await expect.poll(() => htmlPolicy(page)).toBe(true);
  await expect(scripts).toBeEnabled();
  await editor.getByRole("button", { name: "Reset Spellcheck", exact: true }).click();
  await expect(spellcheck).toHaveAttribute("aria-checked", "true");
  await expect(numbers).toHaveAttribute("aria-checked", "true");
  await spellcheck.click();
  const reset = editor.getByRole("button", { name: "Reset Editor…", exact: true });
  await reset.click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reset).toBeFocused();
  await expect(spellcheck).toHaveAttribute("aria-checked", "false");
  await reset.click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset section", exact: true }).click();
  await expect(reset).toBeFocused();
  await expect(spellcheck).toHaveAttribute("aria-checked", "true");
  await expect(numbers).toHaveAttribute("aria-checked", "false");
  await expect(trash).toHaveAttribute("aria-checked", "true");
  await expect(scripts).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => htmlPolicy(page)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mosaic:settings") ?? "{}"))).toMatchObject({
    noteFont: "Georgia",
    weekStart: "sunday",
  });
  await editor.getByRole("button", { name: "Reset Allow scripts in HTML previews", exact: true }).click();
  await expect.poll(() => htmlPolicy(page)).toBe(false);
  await spellcheck.click();
  await numbers.click();
  await trash.click();
  await openEditor(page);
  await expect(spellcheck).toHaveAttribute("aria-checked", "false");
  await expect(numbers).toHaveAttribute("aria-checked", "true");
  await expect(trash).toHaveAttribute("aria-checked", "false");
});

test("Editor follows the approved themes and stays scoped at maximum scale", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openEditor(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const editor = page.getByRole("group", { name: "Editor & files preferences", exact: true });
  await expect(editor).toHaveCSS("font-size", "14px");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await navigation.getByRole("button", { name: "Editor & files", exact: true }).click();
    await expect(editor).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`editor-files-${theme.toLowerCase()}.png`) });
  }
  // The app's reduced-motion rule uses a minimal duration so transition events still fire.
  await expect
    .poll(() =>
      editor
        .locator(".mds-switch span")
        .first()
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration)),
    )
    .toBeLessThanOrEqual(0.001);
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await navigation.getByRole("button", { name: "Editor & files", exact: true }).click();
  await expect(editor).toHaveAttribute("data-density", "compact");
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.locator(".settings-scroll").evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await navigation.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: testInfo.outputPath("editor-files-narrow.png") });
  await navigation.getByRole("button", { name: "Calendar & links", exact: true }).click();
  await expect(page.locator(".settings-scroll .mosaic-ds")).toHaveCount(0);
  await expect(page.locator(".settings-scroll")).toHaveCSS("font-size", "13px");
});
