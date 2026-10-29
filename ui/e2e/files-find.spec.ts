import { expect, test } from "@playwright/test";

test("search preserves results, bookmarks, empty queries and maximum-scale layout", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  const panel = page.getByRole("group", { name: "Note search", exact: true });
  const input = panel.getByRole("textbox", { name: "Search notes", exact: true });
  await input.fill("Welcome");
  await expect(panel.getByRole("listitem").first()).toContainText("Welcome");
  await panel.getByRole("button", { name: "Bookmark this search", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Remove this search from Bookmarks", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await input.fill("no-such-note-91845");
  await expect(panel.getByText("No notes match this search.")).toBeVisible();
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await input.fill("Welcome");
  await expect(panel.getByRole("listitem").first()).toContainText("Welcome");
  await input.press("Enter");
  await expect(page.locator(".cm-content")).toContainText("Welcome");
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(panel).toHaveCSS("font-size", "14px");
    await expect(panel).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System") await page.screenshot({ path: testInfo.outputPath(`search-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  await expect(input).toBeInViewport();
  await expect(panel.getByRole("listitem").first()).toBeVisible();
  await expect
    .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("search-narrow.png") });
});

test("tags retain keyboard search and wrap within themed narrow panels", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Find views", exact: true });
  await nav.getByRole("button", { name: "Tags", exact: true }).click();
  const panel = page.getByRole("group", { name: "Tags", exact: true });
  const tag = panel.getByRole("listitem").first().getByRole("button");
  await expect(tag).toBeVisible();
  const label = await tag.locator(".tag-name").textContent();
  await tag.press("Enter");
  await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toHaveValue(`tag:${label?.slice(1)}`);
  await nav.getByRole("button", { name: "Tags", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(panel).toHaveCSS("font-size", "14px");
    await expect(panel).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System") await page.screenshot({ path: testInfo.outputPath(`tags-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  await expect(tag).toBeInViewport();
  await expect
    .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("tags-narrow.png") });
});

test("bookmarks support keyboard opening, saved queries, reordering and menu focus return", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Find views", exact: true })
    .getByRole("button", { name: "Bookmarks", exact: true })
    .click();
  const panel = page.getByRole("group", { name: "Bookmarks", exact: true });
  const save = panel.getByRole("button", { name: "Save query…", exact: true });
  await save.click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(save).toBeFocused();
  await save.click();
  await page.getByRole("dialog").getByRole("textbox").fill("task:open");
  await page.getByRole("dialog").getByRole("button", { name: "OK", exact: true }).click();
  const query = panel.getByTitle("Query: task:open", { exact: true });
  await expect(query).toBeVisible();
  await query.press("Alt+ArrowUp");
  await expect(panel.getByRole("listitem").first()).toContainText("task:open");
  await expect(query).toBeFocused();
  const actions = panel.getByRole("button", { name: "Actions for bookmark task:open", exact: true });
  await actions.click();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await panel.getByTitle("Welcome.md", { exact: true }).press("Enter");
  await expect(page.locator(".cm-content")).toContainText("Welcome");
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Find views", exact: true })
    .getByRole("button", { name: "Bookmarks", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await expect(panel).toHaveCSS("font-size", "14px");
    await expect(panel).toHaveCSS("background-color", theme === "Light" ? "rgb(246, 246, 248)" : "rgb(24, 25, 29)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`bookmarks-${theme.toLowerCase()}.png`) });
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("tab", { name: "Find", exact: true }).click();
  await expect(actions).toBeInViewport();
  await expect
    .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("bookmarks-narrow.png") });
  await actions.click();
  await page.getByRole("menuitem", { name: "Remove bookmark", exact: true }).click();
  await expect(query).toHaveCount(0);
  await expect(save).toBeFocused();
});

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
  await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toHaveCSS("font-size", "14px");
});
