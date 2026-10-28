import { expect, test } from "@playwright/test";

test("file tree preserves creation, rename cancellation, keyboard selection and theme boundaries", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "Files actions", exact: true });
  const tree = page.getByRole("tree", { name: "Files", exact: true });
  await toolbar.getByRole("button", { name: "New folder", exact: true }).click();
  const name = page.getByRole("textbox", { name: "New name", exact: true });
  await name.fill("Migration folder");
  await name.press("Enter");
  await expect(tree.getByRole("treeitem", { name: "Migration folder", exact: true })).toBeVisible();
  const ideas = tree.getByRole("treeitem", { name: "Ideas", exact: true });
  await ideas.click();
  await tree.press("Enter");
  await expect(name).toBeFocused();
  await name.fill("Cancelled rename");
  await name.press("Escape");
  await expect(ideas).toBeVisible();
  await tree.press("ArrowDown");
  await expect(tree.getByRole("treeitem", { name: /^Welcome/ })).toHaveAttribute("aria-selected", "true");
  await tree.press("Shift+ArrowUp");
  await expect(ideas).toHaveAttribute("aria-selected", "true");
  await tree.press("Escape");
  await expect(tree.locator('[aria-selected="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(tree).toHaveCSS("font-size", "14px");
    await expect(tree.locator("..")).toHaveCSS(
      "background-color",
      theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)",
    );
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`file-tree-${theme.toLowerCase()}.png`) });
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await expect(ideas).toHaveCSS("height", "28px");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("separator", { name: "Resize sidebar", exact: true }).press("Home");
  await expect(toolbar.getByRole("button", { name: "Collapse all folders", exact: true })).toBeInViewport();
  await expect.poll(() => tree.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "New note", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("file-tree-narrow.png") });
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toHaveCSS("font-size", "13px");
});
