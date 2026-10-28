import { expect, test } from "@playwright/test";

test("window strip follows themes, retains native drag regions and fits narrow windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const strip = page.getByRole("banner", { name: "Window title", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(strip).toHaveCSS("font-size", "13px");
    await expect(strip).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    await expect(strip.locator(".window-version")).toHaveCSS("font-size", "12.5px");
    await expect(strip).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(strip.locator("[data-tauri-drag-region]")).toHaveCount(2);
    await expect(strip).toContainText("Mosaic — Mock vault");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`window-strip-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  for (const width of [720, 480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => strip.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect(strip.locator(".window-version")).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("window-strip-narrow.png") });
  await expect(page.locator(".settings-workspace")).not.toHaveClass(/mosaic-ds/);
});

test("destination rail preserves keyboard activation sidebar toggling and accessible attention counts", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Destinations", exact: true });
  const files = nav.getByRole("tab", { name: "Files", exact: true });
  const find = nav.getByRole("tab", { name: "Find", exact: true });
  const plan = nav.getByRole("tab", { name: "Plan", exact: true });
  const ai = nav.getByRole("tab", { name: "AI", exact: true });
  await files.press("End");
  await expect(ai).toBeFocused();
  await expect(ai).toHaveAttribute("aria-selected", "true");
  await ai.press("ArrowUp");
  await expect(plan).toBeFocused();
  await plan.press("ArrowUp");
  await expect(find).toBeFocused();
  await expect(page.getByLabel("Search notes", { exact: true })).toBeVisible();
  await find.press("Home");
  await expect(files).toBeFocused();
  await expect(files).toHaveCSS("outline-style", "solid");
  await files.click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await files.click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page.evaluate(() =>
    (globalThis as unknown as { mosaicMock: { propose(path: string, content: string): number } }).mosaicMock.propose(
      "Welcome.md",
      "Proposed update",
    ),
  );
  await expect(ai).toHaveAccessibleDescription("1 need attention");
  await expect(ai.locator(".destination-attention")).toHaveText("1");
  const settings = nav.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toHaveAttribute("title", /Settings \(.+\)/);
  await settings.click();
  await expect(settings).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
});

test("destination rail follows themes and remains reachable at maximum scale", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Destinations", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await nav.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(nav).toHaveCSS("font-size", "14px");
    await expect(nav).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    await expect(nav.getByRole("tab", { name: "Files", exact: true })).toHaveCSS(
      "color",
      theme === "Light" ? "rgb(29, 31, 38)" : "rgb(228, 229, 234)",
    );
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`destination-rail-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  for (const width of [720, 480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(nav.getByRole("tab", { name: "Files", exact: true })).toBeInViewport();
    await expect(nav.getByRole("button", { name: "Settings", exact: true })).toBeInViewport();
    await expect
      .poll(() => nav.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath("destination-rail-narrow.png") });
  await expect(page.locator(".settings-workspace")).not.toHaveClass(/mosaic-ds/);
});

test("sidebar navigation returns vault-menu focus and preserves Find, Plan and AI selection", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const header = page.getByRole("group", { name: "Vault navigation", exact: true });
  const vault = header.getByRole("button", { name: "Mock vault", exact: true });
  await vault.click();
  await expect(page.getByRole("menuitem", { name: /Open folder as vault/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(vault).toBeFocused();
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  const find = page.getByRole("navigation", { name: "Find views", exact: true });
  await expect(find.getByRole("button", { name: "Search", exact: true })).toHaveAttribute("aria-pressed", "true");
  await find.getByRole("button", { name: "Tags", exact: true }).click();
  await expect(find.getByRole("button", { name: "Tags", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "Plan", exact: true }).click();
  const plan = page.getByRole("navigation", { name: "Plan views", exact: true });
  await plan.getByRole("button", { name: "Board", exact: true }).click();
  await expect(plan.getByRole("button", { name: "Board", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  const sections = page.getByRole("radiogroup", { name: "AI sidebar section", exact: true });
  await sections.getByRole("radio", { name: "Chats", exact: true }).press("ArrowRight");
  await expect(sections.getByRole("radio", { name: "Automations", exact: true })).toBeChecked();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "AI views", exact: true })
      .getByRole("button", { name: "Workflows", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await header.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(header).toHaveCount(0);
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await expect(sections.getByRole("radio", { name: "Automations", exact: true })).toBeChecked();
});

test("sidebar resizing respects scale, persists width and fits narrow windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const resize = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await resize.press("Home");
  await expect(resize).toHaveAttribute("aria-valuenow", "180");
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "190");
  await resize.press("Enter");
  await expect(resize).toHaveAttribute("aria-valuenow", "260");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  const header = page.getByRole("group", { name: "Vault navigation", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(header).toHaveCSS("font-size", "14px");
    await expect(header).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System") await page.screenshot({ path: testInfo.outputPath(`sidebar-${theme.toLowerCase()}.png`) });
  }
  const bounds = await resize.boundingBox();
  if (!bounds) throw new Error("Missing resize handle");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 120);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 52, bounds.y + 120);
  await page.mouse.up();
  await expect(resize).toHaveAttribute("aria-valuenow", "300");
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mosaic:ui") ?? "{}").sidebarWidth))
    .toBe(300);
  await expect(page.getByRole("tree")).toHaveCSS("font-size", "14px");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(header.getByRole("button", { name: "Hide sidebar", exact: true })).toBeInViewport();
  await expect
    .poll(() => page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(321);
  await page.screenshot({ path: testInfo.outputPath("sidebar-narrow.png") });
});
