import { expect, test, type Page } from "@playwright/test";
async function openWorkspace(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
}
async function vaultPreferences(page: Page) {
  return page.evaluate(async () =>
    (
      window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<object> } }
    ).__mosaic.mockInvoke("vault_preferences", {}),
  );
}
test("workspace defaults, startup note and app reset retain their scopes", async ({ page }) => {
  await openWorkspace(page);
  const workspace = page.getByRole("group", { name: "Workspace preferences", exact: true });
  await workspace.getByLabel("Startup destination", { exact: true }).selectOption("note");
  const note = workspace.getByRole("button", { name: "Startup note", exact: true });
  await note.click();
  await page.getByRole("dialog", { name: "Choose startup note", exact: true }).getByRole("combobox").press("Escape");
  await expect(note).toBeFocused();
  await note.click();
  await page
    .getByRole("dialog", { name: "Choose startup note", exact: true })
    .getByRole("option", { name: "Welcome.md", exact: true })
    .click();
  await expect(note).toBeFocused();
  await expect.poll(() => vaultPreferences(page)).toMatchObject({ startup_note: "Welcome.md" });
  await workspace.getByRole("slider", { name: "Default left sidebar width", exact: true }).press("End");
  await workspace.getByRole("slider", { name: "Default context panel width", exact: true }).press("Home");
  await workspace.getByRole("switch", { name: "Show left sidebar by default", exact: true }).click();
  await workspace.getByRole("switch", { name: "Show context panel by default", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mosaic:settings") ?? "{}"))).toMatchObject({
    startup: "note",
    sidebarWidth: 600,
    contextWidth: 180,
    sidebarVisible: false,
    contextVisible: false,
  });
  const reset = workspace.getByRole("button", { name: "Reset Workspace…", exact: true });
  await reset.click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reset).toBeFocused();
  await expect(workspace.getByLabel("Startup destination", { exact: true })).toHaveValue("note");
  await reset.click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset section", exact: true }).click();
  await expect(reset).toBeFocused();
  await expect(workspace.getByLabel("Startup destination", { exact: true })).toHaveValue("restore");
  await expect(workspace.getByRole("slider", { name: "Default left sidebar width", exact: true })).toHaveValue("260");
  await expect(workspace.getByRole("slider", { name: "Default context panel width", exact: true })).toHaveValue("280");
  expect(await vaultPreferences(page)).toMatchObject({ startup_note: "Welcome.md" });
  await workspace.getByLabel("Startup destination", { exact: true }).selectOption("note");
  await workspace.getByRole("button", { name: "Reset Startup note", exact: true }).click();
  await expect.poll(() => vaultPreferences(page)).toMatchObject({ startup_note: "" });
});

test("workspace preferences follow themes and fit narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openWorkspace(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const workspace = page.getByRole("group", { name: "Workspace preferences", exact: true });
  await expect(workspace).toHaveCSS("font-size", "14px");
  await workspace.getByLabel("Startup destination", { exact: true }).selectOption("note");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await navigation.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(workspace).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`workspace-${theme.toLowerCase()}.png`) });
  }
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await navigation.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(workspace).toHaveAttribute("data-density", "compact");
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
  await page.screenshot({ path: testInfo.outputPath("workspace-narrow.png") });
});
