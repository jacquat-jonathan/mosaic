import { expect, test, type Page } from "@playwright/test";

async function openWorkflows(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
}
async function createRun(page: Page, title: string) {
  await page
    .getByRole("group", { name: "Workflow catalog", exact: true })
    .getByRole("article", { name: title, exact: true })
    .getByRole("button", { name: "Run now", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Run log", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
}
async function allRuns(page: Page) {
  await page.getByRole("button", { name: "All runs", exact: true }).click();
}

test("run history preserves empty state, recent filtering and keyboard navigation", async ({ page, browserName }) => {
  await openWorkflows(page);
  await allRuns(page);
  await expect(page.getByText("No runs yet. Run a workflow to see its history here.", { exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await createRun(page, "Weekly review");
  await createRun(page, "Inbox triage");
  const recent = page.getByRole("region", { name: "Recent runs", exact: true });
  await expect(recent.getByRole("table", { name: "Workflow runs", exact: true }).locator("tbody tr")).toHaveCount(2);
  await page
    .getByRole("group", { name: "Workflow catalog", exact: true })
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
  await expect(recent.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await expect(recent.getByRole("table").locator("tbody")).toContainText("Weekly review");
  await allRuns(page);
  const ledger = page.getByRole("table", { name: "Workflow runs", exact: true });
  await expect(ledger.locator("tbody tr").first()).toContainText("Inbox triage");
  const title = ledger.locator("tbody tr").first().getByRole("button");
  await title.focus();
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await page.keyboard.press(browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
  await expect(title).toBeFocused();
  await expect(title).toHaveCSS("outline-style", "solid");
  await expect(title).not.toHaveAttribute("aria-expanded");
  await title.press("Enter");
  await expect(page.getByRole("heading", { name: "Run log", exact: true })).toBeVisible();
});

test("run history follows themes and adapts to pane width at maximum scale", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openWorkflows(page);
  await createRun(page, "Weekly review");
  await createRun(page, "Inbox triage");
  await allRuns(page);
  const history = page.getByRole("group", { name: "Runs ledger", exact: true });
  const ledger = history.getByRole("table", { name: "Workflow runs", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await allRuns(page);
    await expect(history).toHaveCSS("font-size", "14px");
    await expect(history).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await expect(ledger.locator(".mds-status").first()).toHaveCSS("font-size", "13px");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`runs-ledger-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await allRuns(page);
  await expect(history).toHaveAttribute("data-density", "compact");
  // The window stays wide while the pane's own table switches to its compact layout.
  await expect(ledger.locator("time.mds-run-mobile").first()).toBeVisible();
  for (const width of [920, 720, 650, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => history.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect(ledger.locator("time.mds-run-mobile").first()).toBeVisible();
    await expect(ledger.locator(".mds-run-duration").first()).toBeHidden();
  }
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("runs-ledger-narrow.png") });
  await ledger.getByRole("button").first().click();
  await expect(page.locator(".run-detail")).toHaveCSS("font-size", "13px");
  await expect(page.locator(".run-detail.mosaic-ds")).toHaveCount(0);
});
