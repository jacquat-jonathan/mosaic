import { expect, test } from "@playwright/test";
import { openMockVault } from "./mock-vault";

test("mock vault setup waits for slow preferences and layout restoration", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open folder…", exact: true })).toBeEnabled();
  await page.waitForFunction(() => "__mosaic" in window);
  await page.evaluate(async () => {
    const source = "/src/ipc/api.ts";
    const { api } = await import(/* @vite-ignore */ source);
    const preferences = api.vaultPreferences;
    // Reproduce the initialization gap on a busy CI runner, without slowing other tests.
    api.vaultPreferences = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return preferences();
    };
    const workspace = (
      window as unknown as {
        __mosaic: {
          useWorkspace: {
            getState(): { restoreLayout(root: string): Promise<void> };
            setState(state: { restoreLayout(root: string): Promise<void> }): void;
          };
        };
      }
    ).__mosaic.useWorkspace;
    const restore = workspace.getState().restoreLayout;
    workspace.setState({
      async restoreLayout(root) {
        await restore(root);
        document.documentElement.dataset.testVaultRestored = "true";
      },
    });
  });
  await openMockVault(page);
  // An immediate assertion catches a helper that only awaits the Open folder click.
  expect(await page.evaluate(() => document.documentElement.dataset.testVaultRestored)).toBe("true");
  await page.evaluate(async () => {
    const mock = (
      window as unknown as {
        __mosaic: { useWorkspace: { getState(): { open(path: string, options: object): Promise<void> } } };
      }
    ).__mosaic;
    await mock.useWorkspace.getState().open("mosaic:board", { newTab: true });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Task board Close tab", exact: true }).click();
  await expect(page.getByRole("main", { name: "Task board", exact: true })).toBeVisible();
});
