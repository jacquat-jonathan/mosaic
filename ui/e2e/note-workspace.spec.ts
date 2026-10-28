import { expect, test } from "@playwright/test";

test("workspace tabs preserve keyboard selection, closing, splits and resize controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  await page.getByRole("treeitem", { name: /^Welcome/ }).click({ modifiers: ["Alt"] });
  const tabs = page.getByRole("tablist", { name: "Workspace tabs", exact: true });
  const welcome = tabs.getByRole("tab", { name: "Welcome Close tab", exact: true });
  await welcome.press("Home");
  const ideas = tabs.getByRole("tab", { name: "Ideas Close tab", exact: true });
  await expect(ideas).toBeFocused();
  await expect(ideas).toHaveAttribute("aria-selected", "true");
  await ideas.press("End");
  await welcome.getByRole("button", { name: "Close tab", exact: true }).press("Enter");
  await expect(welcome).toHaveCount(0);
  await expect(ideas).toHaveAttribute("aria-selected", "true");
  await expect(ideas).toBeFocused();
  await page.getByRole("button", { name: "Split right", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workspace pane", exact: true })).toHaveCount(2);
  const handle = page.getByRole("separator", { name: "Resize workspace panes", exact: true });
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await handle.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "52");
  await handle.press("Enter");
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  const count = await page.getByRole("tab", { name: "Ideas Close tab", exact: true }).count();
  expect(count).toBe(2);
});

test("workspace chrome follows themes and keeps controls reachable in narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const bar = page.locator(".workspace-tabbar");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(bar).toHaveCSS("font-size", "14px");
    await expect(bar).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`workspace-tabs-${theme.toLowerCase()}.png`) });
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(bar.locator('[role="tab"][aria-selected="true"]')).toBeInViewport();
  await expect(bar.getByRole("button", { name: "Split right", exact: true })).toBeHidden();
  await expect(bar.getByRole("button", { name: "More workspace actions", exact: true })).toBeInViewport();
  await expect.poll(() => bar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("workspace-tabs-narrow.png") });
  await bar.getByRole("button", { name: "More workspace actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Split right/ }).click();
  await expect(page.locator(".workspace-tabbar")).toHaveCount(2);
  for (const header of await page.locator(".workspace-tabbar").all()) {
    await expect(header.getByRole("button", { name: "More workspace actions", exact: true })).toBeInViewport();
    await expect
      .poll(() => header.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath("workspace-tabs-narrow-split.png") });
  await expect(page.locator(".pane-body.mosaic-ds")).toHaveCount(0);
});
