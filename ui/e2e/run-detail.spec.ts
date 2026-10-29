import { expect, test, type Page } from "@playwright/test";

async function openRun(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("radio", { name: "Automations", exact: true }).click();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Workflow catalog", exact: true })
    .getByRole("article", { name: "Weekly review", exact: true })
    .getByRole("button", { name: "Run now", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Run log", exact: true })).toBeVisible();
}
async function returnToRun(page: Page) {
  const ai = page.getByRole("tab", { name: "AI", exact: true });
  if ((await ai.getAttribute("aria-selected")) !== "true") await ai.click();
  await page.getByRole("radio", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: "All runs", exact: true }).click();
  await page
    .getByRole("table", { name: "Workflow runs", exact: true })
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
}

test("run details retain expandable metadata, tool file links and review navigation", async ({ page }) => {
  await openRun(page);
  const run = page.getByRole("group", { name: "Workflow run", exact: true });
  const details = run.locator(".run-details").first();
  await expect(details.locator("dl")).toBeHidden();
  await details.locator("summary").press("Enter");
  await expect(details.locator("dl")).toContainText("Attempts");
  const tool = run.locator(".mds-tool").first();
  await tool.locator("summary").press("Enter");
  const source = tool.getByRole("button", { name: "Open Ideas.md", exact: true });
  await expect(source).toBeVisible();
  await source.click();
  await expect(page.getByRole("tab", { name: "Ideas Close tab", exact: true })).toBeVisible();
  await returnToRun(page);
  await run.getByRole("button", { name: "Open activity and reviews", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity & review", exact: true })).toBeVisible();
});

test("run panels follow themes and preserve readable logs at narrow sizes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openRun(page);
  const run = page.getByRole("group", { name: "Workflow run", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await returnToRun(page);
    await expect(run).toHaveCSS("font-size", "14px");
    await expect(run).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await run
      .locator(".run-details")
      .first()
      .evaluate((element) => {
        (element as HTMLDetailsElement).open = true;
      });
    await run
      .locator(".mds-tool")
      .first()
      .evaluate((element) => {
        (element as HTMLDetailsElement).open = true;
      });
    await expect(run.getByRole("region", { name: "Run log", exact: true }).locator(".mds-message").first()).toHaveCSS(
      "font-size",
      "14px",
    );
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`run-detail-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await returnToRun(page);
  await expect(run).toHaveAttribute("data-density", "compact");
  await run.locator(".mds-tool summary").first().press("Enter");
  for (const width of [920, 720, 650, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => run.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        run
          .getByRole("region", { name: "Run log", exact: true })
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeLessThanOrEqual(1);
  }
  await run.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("run-detail-narrow.png") });
});
