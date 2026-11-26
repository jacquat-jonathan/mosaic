import { expect, test, type Page } from "@playwright/test";

async function setShowHidden(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Vault folders", exact: true })
    .click();
  await page.getByRole("switch", { name: "Show hidden files and folders", exact: true }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
}

test("hidden files appear in the tree with the setting, open view-only, and go away again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const row = (path: string) => page.locator(`.tree-row[data-path="${path}"]`);
  await expect(row("Welcome.md")).toBeVisible();
  await expect(row(".claude")).toHaveCount(0);

  await setShowHidden(page);
  await expect(row(".claude")).toBeVisible();
  await expect(row(".gitignore")).toBeVisible();
  // Git's repository and Mosaic's own data never appear.
  await expect(row(".git")).toHaveCount(0);
  await expect(row(".mosaic")).toHaveCount(0);

  await row(".claude").click();
  await row(".claude/settings.json").click();
  await expect(page.getByText("Hidden files are view-only in Mosaic.")).toBeVisible();
  const editor = page.locator(".code-editor .cm-content");
  await expect(editor).toContainText("permissions");
  await editor.click();
  await page.keyboard.type("zzz");
  await expect(editor).not.toContainText("zzz");

  await setShowHidden(page);
  await expect(row(".claude")).toHaveCount(0);
  await expect(row("Welcome.md")).toBeVisible();
});
