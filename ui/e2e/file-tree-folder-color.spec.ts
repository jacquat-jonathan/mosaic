import { expect, test, type Page } from "@playwright/test";
import type { VaultPreferences } from "../src/state/vaultPreferences";

const preferences = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } }
    ).__mosaic.mockInvoke("vault_preferences", {}),
  ) as Promise<VaultPreferences>;

async function chooseColor(page: Page, folder: string, color: string) {
  await page.locator(`.tree-row[data-path="${folder}"]`).click({ button: "right" });
  const menu = page.getByRole("menu").first();
  await menu.getByRole("menuitem", { name: /^Color/ }).hover();
  const option = page.getByRole("menuitemcheckbox", { name: color, exact: true });
  await expect(option).toBeVisible();
  await option.click();
}

test("folder colors can be set and cleared from the file tree context menu", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const projects = page.locator('.tree-row[data-path="Projects"]');
  await expect(projects).toBeVisible();
  await expect(projects).not.toHaveAttribute("data-folder-color");

  await chooseColor(page, "Projects", "Purple");
  await expect(projects).toHaveAttribute("data-folder-color", "purple");
  await expect(projects).toHaveAccessibleName("Projects, purple folder");
  await expect.poll(async () => (await preferences(page)).folder_colors).toEqual({ Projects: "purple" });

  await projects.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Color/ }).hover();
  await expect(page.getByRole("menuitemcheckbox", { name: "Purple", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("menuitemcheckbox", { name: "No color", exact: true }).click();
  await expect(projects).not.toHaveAttribute("data-folder-color");
  await expect.poll(async () => (await preferences(page)).folder_colors).toEqual({});
});
