import { expect, test, type Page } from "@playwright/test";

async function readIdeas(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<{ content: string }> } }
    ).__mosaic
      .mockInvoke("read_file", { path: "Ideas.md" })
      .then((result) => result.content),
  );
}

async function readWelcome(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<{ content: string }> } }
    ).__mosaic
      .mockInvoke("read_file", { path: "Welcome.md" })
      .then((result) => result.content),
  );
}

test("note properties retain YAML edits, duplicate validation and focus after additions and removals", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: /^Welcome/ }).click();
  const context = page.getByRole("complementary", { name: "Workspace context", exact: true });
  const form = context.getByRole("group", { name: "Note properties", exact: true });
  await form.getByRole("textbox", { name: "status", exact: true }).fill("ready");
  await form.getByRole("textbox", { name: "status", exact: true }).press("Tab");
  await expect.poll(() => readWelcome(page)).toContain("status: ready");
  const add = form.getByRole("button", { name: "Add property", exact: true });
  await add.click();
  await form.getByRole("textbox", { name: "New property name", exact: true }).fill("status");
  await expect(form.getByRole("button", { name: "Name taken", exact: true })).toBeDisabled();
  await expect(form.getByRole("textbox", { name: "New property name", exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await form.getByRole("textbox", { name: "New property name", exact: true }).press("Escape");
  await expect(add).toBeFocused();
  await add.click();
  await form.getByRole("textbox", { name: "New property name", exact: true }).fill("published");
  await form.getByLabel("Type", { exact: true }).selectOption("checkbox");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  const published = form.getByRole("switch", { name: "published", exact: true });
  await expect(published).toBeFocused();
  await published.click();
  await expect.poll(() => readWelcome(page)).toContain("published: true");
  await form.getByRole("button", { name: "Remove intro from tags", exact: true }).click();
  await expect(form.getByRole("textbox", { name: "Add to tags", exact: true })).toBeFocused();
  await form.getByRole("textbox", { name: "Add to tags", exact: true }).fill("design");
  await form.getByRole("textbox", { name: "Add to tags", exact: true }).press("Enter");
  await expect.poll(() => readWelcome(page)).toContain("design");
  await form.getByRole("button", { name: "Remove published", exact: true }).click();
  await expect(add).toBeFocused();
  await expect.poll(() => readWelcome(page)).not.toContain("published:");
  await form.getByRole("button", { name: "Edit as YAML", exact: true }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toContainText("status: ready");
});

test("note properties share themes and stack while keeping note typography separate", async ({ page }, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("mosaic:settings", JSON.stringify({ noteFont: "Georgia", noteSize: 20 })),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: /^Welcome/ }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  const properties = page
    .getByRole("complementary", { name: "Workspace context", exact: true })
    .getByRole("group", { name: "Note properties", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page.getByRole("tab", { name: "Welcome Close tab", exact: true }).click();
    await expect(properties).toBeVisible();
    for (const form of await page.getByRole("group", { name: "Note properties", exact: true }).all()) {
      await expect(form).toHaveCSS("font-size", "14px");
      await expect(form).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    }
    await expect(page.locator(".cm-content")).toHaveCSS("font-size", "20px");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`note-properties-${theme.toLowerCase()}.png`) });
    if (theme !== "System") await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Show right panel", exact: true }).click();
  await expect(properties.getByRole("button", { name: "Add property", exact: true })).toBeInViewport();
  await expect
    .poll(() => properties.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("note-properties-narrow.png") });
});

test("note formatting preserves selection, undo, toolbar keys and cancelled-link focus", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await editor.press("Meta+a");
  await page.keyboard.insertText("Format this text");
  await editor.press("Meta+a");
  const toolbar = page.getByRole("toolbar", { name: "Format selected text", exact: true });
  await toolbar.getByRole("button", { name: "Bold (⌘B)", exact: true }).click();
  await expect.poll(() => readIdeas(page)).toBe("**Format this text**");
  await toolbar.getByRole("button", { name: "Bold (⌘B)", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(toolbar.getByRole("button", { name: "Italic (⌘I)", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(toolbar.getByRole("button", { name: "Link to a Mosaic note", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await toolbar.getByRole("button", { name: "Add web link (⌘K)", exact: true }).click();
  await page.locator(".modal").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toBeFocused();
  await editor.press("Meta+z");
  await expect.poll(() => readIdeas(page)).toBe("Format this text");
});

test("note formatting follows themes without changing note typography at maximum scale", async ({ page }, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("mosaic:settings", JSON.stringify({ noteFont: "Georgia", noteSize: 20 })),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  const toolbar = page.getByRole("toolbar", { name: "Format selected text", exact: true });
  const editor = page.locator(".cm-content");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page.getByRole("tab", { name: "Ideas Close tab", exact: true }).click();
    await editor.click();
    await editor.press("Meta+a");
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toBeInViewport();
    await expect(toolbar).toHaveCSS("font-size", "14px");
    await expect(toolbar).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    await expect(editor).toHaveCSS("font-size", "20px");
    await expect(editor).toHaveCSS("font-family", /Georgia/);
    await page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
    );
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`note-formatting-${theme.toLowerCase()}.png`) });
    if (theme !== "System") await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.setViewportSize({ width: 320, height: 900 });
  for (const button of await toolbar.getByRole("button").all()) await expect(button).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("note-formatting-narrow.png") });
});

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
