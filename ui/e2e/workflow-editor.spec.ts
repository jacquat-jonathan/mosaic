import { expect, test, type Page } from "@playwright/test";

async function openEditor(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await page.getByRole("button", { name: "Create workflow", exact: true }).click();
}
async function mock<T>(page: Page, command: string, args: object = {}) {
  return page.evaluate(
    async ({ command, args }) =>
      (
        window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } }
      ).__mosaic.mockInvoke(command, args),
    { command, args },
  ) as Promise<T>;
}
test("workflow form preserves drafts and saves trigger and safety options without running", async ({ page }) => {
  await openEditor(page);
  const editor = page.getByRole("group", { name: "Workflow editor", exact: true });
  await editor.getByRole("switch", { name: "Run on a schedule", exact: true }).click();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor.getByRole("switch", { name: "Run on a schedule", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard changes", exact: true }).click();
  await page.getByRole("button", { name: "Create workflow", exact: true }).click();
  await editor.getByRole("button", { name: "Create workflow", exact: true }).click();
  await expect(editor.getByLabel("Instructions", { exact: true })).toBeFocused();
  await expect(editor.getByLabel("Instructions", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await editor.getByLabel("Name", { exact: true }).fill("Migration workflow");
  await editor.getByLabel("Instructions", { exact: true }).fill("Summarize project notes.");
  await editor.getByRole("switch", { name: "Run on a schedule", exact: true }).click();
  await editor.getByLabel("Schedule", { exact: true }).selectOption("every");
  await editor.getByLabel("Hours", { exact: true }).fill("4");
  await editor.getByRole("switch", { name: "Run when a Markdown note is created", exact: true }).click();
  const events = editor.getByRole("group", { name: "Event folders", exact: true });
  await events.getByLabel("Search event folders", { exact: true }).fill("Daily");
  await events.getByRole("button", { name: "+ Daily", exact: true }).click();
  await editor.getByLabel("Review behavior", { exact: true }).selectOption("folders");
  const allowed = editor.getByRole("group", { name: "May change without review", exact: true });
  await allowed.getByLabel("Search may change without review", { exact: true }).fill("Projects");
  await allowed.getByRole("button", { name: "+ Projects", exact: true }).click();
  await editor.getByRole("switch", { name: "Can use the web (search and fetch pages)", exact: true }).click();
  await editor.getByRole("button", { name: "Create workflow", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Migration workflow", level: 1, exact: true })).toBeVisible();
  const source = await mock<{ content: string }>(page, "read_file", { path: "Agents/Migration workflow.md" });
  expect(source.content).toContain("schedule: every 4h");
  expect(source.content).toContain("created in Daily/");
  expect(source.content).toContain("Projects");
  expect(source.content).toContain("web: true");
  await page.getByRole("button", { name: "Edit workflow", exact: true }).click();
  await editor.getByLabel("Instructions", { exact: true }).fill("Updated workflow instructions.");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Migration workflow", level: 1, exact: true })).toBeVisible();
  expect(
    (await mock<{ content: string }>(page, "read_file", { path: "Agents/Migration workflow.md" })).content,
  ).toContain("Updated workflow instructions.");
  expect(await mock(page, "tessera_status")).toMatchObject({ runs: [] });
});

test("workflow editor follows themes and keeps expanded fields inside narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openEditor(page);
  const editor = page.getByRole("group", { name: "Workflow editor", exact: true });
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
    await page.getByRole("button", { name: "Create workflow", exact: true }).click();
    await editor.getByLabel("Agent", { exact: true }).selectOption("weekly-review");
    await expect(editor.getByRole("button", { name: "Create workflow", exact: true })).toBeEnabled();
    await expect(editor).toHaveCSS("font-size", "14px");
    await expect(editor).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await editor.locator("summary").click();
    await editor.evaluate((element) => {
      element.scrollTop = 0;
    });
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`workflow-editor-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await page.getByRole("button", { name: "Create workflow", exact: true }).click();
  await editor.getByLabel("Agent", { exact: true }).selectOption("weekly-review");
  await expect(editor).toHaveAttribute("data-density", "compact");
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => editor.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await editor.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("workflow-editor-narrow.png") });
  await editor
    .getByRole("switch", { name: "Can use the web (search and fetch pages)", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("workflow-editor-narrow-safety.png") });
});
