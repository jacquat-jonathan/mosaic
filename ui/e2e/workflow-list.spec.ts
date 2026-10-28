import { expect, test, type Page } from "@playwright/test";

async function openWorkflows(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("radio", { name: "Automations", exact: true }).click();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
}
test("workflow cards retain run, pause, menu, confirmation and library actions", async ({ page }) => {
  await openWorkflows(page);
  const catalog = page.getByRole("group", { name: "Workflow catalog", exact: true });
  const card = catalog.getByRole("article").first();
  await expect(card.getByText("Reads", { exact: true })).toBeVisible();
  await expect(card.getByText("Produces", { exact: true })).toBeVisible();
  await expect(card.getByText(/Folder rules take precedence/)).toBeVisible();
  await expect(card.getByText("Not run yet", { exact: true })).toBeVisible();
  await card.locator("summary").click();
  await expect(card.locator(".mds-metadata")).toContainText("Model");
  const more = card.getByRole("button", { name: /^More actions for/ });
  await more.click();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole("menuitem", { name: "Delete workflow…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(more).toBeFocused();
  await catalog.getByRole("button", { name: "Pause automations", exact: true }).click();
  await expect(catalog.getByRole("button", { name: "Resume automations", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Run now", exact: true })).toBeEnabled();
  await catalog.getByRole("button", { name: "Resume automations", exact: true }).click();
  await expect(catalog.getByRole("button", { name: "Pause automations", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Run log", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await expect(catalog.getByRole("article").first().locator(".mds-workflow-last-run")).toContainText(
    "Mock run completed",
  );
  await catalog.getByRole("article").first().getByRole("button", { name: "Open run log", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Run log", exact: true })).toBeVisible();
  await page.locator(".ai-manage summary").click();
  await page.getByRole("button", { name: "Agent library", exact: true }).click();
  await expect(page.getByRole("group", { name: "Agent library", exact: true }).getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Recent runs", exact: true })).toHaveCount(0);
});

test("workflow cards match themes and wrap at maximum scale", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openWorkflows(page);
  const catalog = page.getByRole("group", { name: "Workflow catalog", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page
      .getByRole("navigation", { name: "AI views", exact: true })
      .getByRole("button", { name: "Workflows", exact: true })
      .click();
    await expect(catalog).toHaveCSS("font-size", "14px");
    await expect(catalog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await catalog.getByRole("article").first().locator("summary").click();
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`workflow-list-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await expect(catalog).toHaveAttribute("data-density", "compact");
  await catalog.getByRole("article").first().locator("summary").click();
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.locator(".workflow-list-page").evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.locator(".workflow-list-page").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("workflow-list-narrow.png") });
  await expect(page.getByRole("region", { name: "Recent runs", exact: true })).toHaveClass(/mosaic-ds/);
  await expect(page.getByRole("region", { name: "Recent runs", exact: true })).toHaveCSS("font-size", "14px");
});
