import { expect, type Page } from "@playwright/test";

/** Finish vault restoration before fixture writes or workspace navigation. A button click only
 * waits for the click handler: openVault can still replace tabs or reset planning state later. */
export async function openMockVault(page: Page) {
  await expect(page.getByRole("button", { name: "Open folder…", exact: true })).toBeEnabled();
  await page.waitForFunction(() => "__mosaic" in window);
  await page.evaluate(async () => {
    const mock = (
      window as unknown as {
        __mosaic: { useVault: { getState(): { openVault(path: string): Promise<void> } } };
      }
    ).__mosaic;
    await mock.useVault.getState().openVault("/mock/vault");
  });
  await expect(page.getByRole("treeitem", { name: /^Welcome/ })).toBeVisible();
}
