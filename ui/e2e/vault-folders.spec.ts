import { expect, test, type Page } from "@playwright/test";
import type { VaultPreferences } from "../src/state/vaultPreferences";

async function openVaultFolders(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Vault folders", exact: true })
    .click();
}
async function mock<T>(page: Page, command: string, args: object = {}) {
  return page.evaluate(
    async ({ command, args }) =>
      (
        window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } }
      ).__mosaic.mockInvoke(command, args),
    { command, args },
  ) as Promise<T>;
}
const preferences = (page: Page) => mock<VaultPreferences>(page, "vault_preferences");
async function choose(page: Page, label: string, path: string) {
  const button = page
    .getByRole("group", { name: "Vault folder preferences", exact: true })
    .getByRole("button", { name: label, exact: true });
  await button.click();
  const picker = page.getByRole("dialog", { name: `Choose ${label.toLowerCase()}`, exact: true });
  await picker.getByRole("textbox").fill(path);
  await picker.getByRole("option", { name: path, exact: true }).click();
  await expect(button).toBeEnabled();
  await expect(button).toBeFocused();
}

test("vault folder choices, note defaults, attachment visibility and colors persist", async ({ page }) => {
  await openVaultFolders(page);
  const vault = page.getByRole("group", { name: "Vault folder preferences", exact: true });
  const daily = vault.getByRole("button", { name: "Daily notes folder", exact: true });
  await daily.click();
  await page.getByRole("dialog", { name: "Choose daily notes folder" }).getByRole("textbox").press("Escape");
  await expect(daily).toBeFocused();
  await choose(page, "Agents folder", "Projects");
  await expect.poll(async () => (await preferences(page)).agents_folder).toBe("Projects");
  await vault.getByRole("button", { name: "Reset Agents folder", exact: true }).click();
  await expect.poll(async () => (await preferences(page)).agents_folder).toBe("Agents");
  await choose(page, "Daily notes folder", "Projects");
  await choose(page, "Daily note template", "Welcome.md");
  await vault.getByRole("button", { name: "Reset Daily note template", exact: true }).click();
  await expect.poll(async () => (await preferences(page)).daily_template).toBe("");
  await vault.getByLabel("New notes go in", { exact: true }).selectOption("folder");
  await choose(page, "New notes folder", "Projects");
  await vault.getByLabel("New attachments go in", { exact: true }).selectOption("folder");
  await choose(page, "Attachments folder", "Attachments");
  await vault.getByRole("switch", { name: "Show attachments in file tree", exact: true }).focus();
  await page.keyboard.press("Space");
  await vault.locator("summary").click();
  const colors = vault.locator("details");
  await colors.getByRole("button", { name: "Choose folder…", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Choose a folder to color" })
    .getByRole("option", { name: "Projects", exact: true })
    .click();
  await colors.getByLabel("Folder color", { exact: true }).selectOption("purple");
  await expect.poll(async () => (await preferences(page)).folder_colors.Projects).toBe("purple");
  expect(await preferences(page)).toMatchObject({
    daily_folder: "Projects",
    new_note_location: "folder",
    new_note_folder: "Projects",
    attachment_location: "folder",
    attachment_folder: "Attachments",
    show_attachments_in_tree: true,
  });
  await colors.getByRole("button", { name: "Reset color for Projects", exact: true }).click();
  await expect.poll(async () => (await preferences(page)).folder_colors).toEqual({});
});

test("missing folders require explicit creation and section reset preserves unrelated data", async ({ page }) => {
  await openVaultFolders(page);
  const { root } = await mock<{ root: string }>(page, "current_vault");
  await mock(page, "set_vault_preferences", {
    root,
    patch: {
      allow_html_scripts: true,
      link_style: "markdown",
      daily_format: "DD-MM-YYYY",
      folder_colors: { Projects: "purple" },
    },
  });
  const original = await mock<{ content: string }>(page, "read_file", { path: "Welcome.md" });
  const templates = await mock(page, "template_config");
  const vault = page.getByRole("group", { name: "Vault folder preferences", exact: true });
  const setPath = vault.getByRole("button", { name: "Set daily notes folder path", exact: true });
  await setPath.click();
  await page.getByPlaceholder("Vault-relative folder").fill("Journal");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(setPath).toBeFocused();
  const exists = () =>
    mock<Array<{ path: string; is_dir: boolean }>>(page, "list_dir", { dir: "", recursive: true }).then((entries) =>
      entries.some((entry) => entry.is_dir && entry.path === "Journal"),
    );
  expect(await exists()).toBe(false);
  await vault.getByRole("button", { name: "Create daily notes folder", exact: true }).click();
  await expect.poll(exists).toBe(true);
  await expect(vault.getByRole("button", { name: "Create daily notes folder", exact: true })).toHaveCount(0);
  await vault.getByRole("switch", { name: "Show attachments in file tree", exact: true }).click();
  const reset = vault.getByRole("button", { name: "Reset vault folders…", exact: true });
  await reset.click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reset).toBeFocused();
  expect((await preferences(page)).daily_folder).toBe("Journal");
  await reset.click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset section", exact: true }).click();
  await expect(reset).toBeFocused();
  expect(await preferences(page)).toMatchObject({
    agents_folder: "Agents",
    daily_folder: "Daily",
    daily_template: "",
    new_note_location: "current",
    attachment_location: "next-to-note",
    show_attachments_in_tree: false,
    folder_colors: {},
    allow_html_scripts: true,
    link_style: "markdown",
    daily_format: "DD-MM-YYYY",
  });
  expect(await exists()).toBe(true);
  expect((await mock<{ content: string }>(page, "read_file", { path: "Welcome.md" })).content).toBe(original.content);
  expect(await mock(page, "template_config")).toEqual(templates);
});

test("vault settings match both themes and fit narrow panes at maximum scale", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openVaultFolders(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const vault = page.getByRole("group", { name: "Vault folder preferences", exact: true });
  await expect(vault).toHaveCSS("font-size", "14px");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await navigation.getByRole("button", { name: "Vault folders", exact: true }).click();
    await expect(vault).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await vault.locator("summary").click();
    await vault.locator("details").getByRole("button", { name: "Choose folder…", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Choose a folder to color" })
      .getByRole("option", { name: "Projects", exact: true })
      .click();
    await vault.getByLabel("Folder color", { exact: true }).selectOption("purple");
    await expect(vault.getByLabel("Folder color", { exact: true })).toBeEnabled();
    await page.locator(".settings-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`vault-folders-${theme.toLowerCase()}.png`) });
  }
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await navigation.getByRole("button", { name: "Vault folders", exact: true }).click();
  await expect(vault).toHaveAttribute("data-density", "compact");
  await vault.locator("summary").click();
  await vault.locator("details").getByRole("button", { name: "Choose folder…", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Choose a folder to color" })
    .getByRole("option", { name: "Projects", exact: true })
    .click();
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
  await page.screenshot({ path: testInfo.outputPath("vault-folders-narrow.png") });
  await navigation.getByRole("button", { name: "Connections & safety", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(page.locator(".connect-ai .mosaic-ds")).toHaveCount(0);
});
