import { expect, test, type Page } from "@playwright/test";
async function conflict(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await page.keyboard.type(" my unsaved words");
  await page.clock.runFor(50);
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: { mockInvoke(command: string, args: object): Promise<unknown>; external(paths: string[]): void };
      }
    ).__mosaic;
    await m.mockInvoke("write_file", {
      path: "Ideas.md",
      content: "# Ideas\n\nChanged by an agent.\n",
      expectedHash: null,
    });
    m.external(["Ideas.md"]);
  });
  await expect(page.getByText("This file changed on disk while you were editing it.", { exact: true })).toBeVisible();
  await page.clock.resume();
}
async function openIdeas(page: Page) {
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: { useWorkspace: { getState(): { open(path: string, options: { newTab: boolean }): Promise<void> } } };
      }
    ).__mosaic;
    await m.useWorkspace.getState().open("Ideas.md", { newTab: true });
  });
}
test("conflict dialog preserves review, cancellation focus and explicit resolution", async ({ page }) => {
  await conflict(page);
  const compare = page.getByRole("button", { name: "Compare", exact: true });
  await compare.click();
  const dialog = page.getByRole("dialog", { name: "Disk version → your version", exact: true });
  await expect(dialog).toContainText("Changed by an agent.");
  await expect(dialog).toContainText("my unsaved words");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(compare).toBeFocused();
  await compare.click();
  await dialog.getByRole("button", { name: "Keep mine", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toContainText("my unsaved words");
});
test("conflict notices and comparison share themes and fit scaled narrow windows", async ({ page }, info) => {
  await conflict(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openIdeas(page);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Disk version → your version", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await expect(dialog).toContainText("my unsaved words");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`conflict-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await openIdeas(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const notice = page.getByText("This file changed on disk while you were editing it.", { exact: true }).locator("..");
  await expect.poll(() => notice.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Disk version → your version", exact: true });
  await expect(dialog.getByRole("button", { name: "Keep mine", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("conflict-narrow.png") });
});

async function banners(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/state/vault.ts";
    const { useVault } = await import(path);
    useVault.setState({
      offline: true,
      vault: {
        ...useVault.getState().vault,
        history_warning: "History is temporarily unavailable. Your files are still available.",
      },
      unfinishedRenames: [{ id: 99, from: "A long folder/Original note.md", to: "Another folder/Renamed note.md" }],
    });
  });
}
test("workspace reconnect preserves the unsaved note and its open tab", async ({ page }) => {
  await conflict(page);
  await banners(page);
  const notices = page.getByRole("region", { name: "Workspace notices", exact: true });
  await notices.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(notices).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("my unsaved words");
  await expect(page.getByRole("tab", { name: "Ideas Close tab", exact: true })).toBeVisible();
  await expect(page.getByText("This file changed on disk while you were editing it.", { exact: true })).toBeVisible();
});
test("workspace notices share themes and fit scaled narrow windows", async ({ page }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await banners(page);
    const notices = page.getByRole("region", { name: "Workspace notices", exact: true });
    await expect(notices).toHaveCSS("font-size", "14px");
    await expect(notices.getByRole("alert").first()).toHaveCSS(
      "background-color",
      theme === "Light" ? "rgb(255, 244, 214)" : "rgb(61, 52, 32)",
    );
    if (theme !== "System")
      await page.screenshot({ path: info.outputPath(`workspace-notices-${theme.toLowerCase()}.png`) });
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  const notices = page.getByRole("region", { name: "Workspace notices", exact: true });
  await expect.poll(() => notices.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await notices.getByRole("button", { name: "Fix links", exact: true }).focus();
  await expect(notices.getByRole("button", { name: "Fix links", exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath("workspace-notices-narrow.png") });
});

async function unsupported(page: Page) {
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: {
          mockInvoke(command: string, args: object): Promise<unknown>;
          useWorkspace: { getState(): { open(path: string, options: { newTab: boolean }): Promise<void> } };
        };
      }
    ).__mosaic;
    await m.mockInvoke("write_file", { path: "Docs/unknown.bin", content: "Unsupported file", expectedHash: null });
    await m.useWorkspace.getState().open("Docs/unknown.bin", { newTab: true });
  });
}
test("unsupported file controls share themes and fit scaled narrow panes", async ({ page }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await unsupported(page);
    const region = page.getByRole("region", { name: "File preview unavailable", exact: true });
    await expect(region).toHaveCSS("font-size", "14px");
    await expect(region).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await region.getByRole("button", { name: "Open in default app", exact: true }).click();
    await expect(region.getByRole("button", { name: "Open in default app", exact: true })).toBeEnabled();
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`unsupported-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await unsupported(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const region = page.getByRole("region", { name: "File preview unavailable", exact: true });
  await expect(region.getByRole("button", { name: "Open in default app", exact: true })).toBeInViewport();
  await expect.poll(() => region.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("unsupported-narrow.png") });
});

async function queryNote(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: {
          mockInvoke(command: string, args: object): Promise<unknown>;
          useWorkspace: {
            getState(): {
              open(path: string, options: { newTab: boolean }): Promise<void>;
              buffers: Record<string, { content: string }>;
            };
          };
        };
      }
    ).__mosaic;
    await m.mockInvoke("write_file", {
      path: "Query UI.md",
      content: "# Query UI\n\n```query\ntask:open\n```\n\nEnd.\n",
      expectedHash: null,
    });
    await m.useWorkspace.getState().open("Query UI.md", { newTab: true });
  });
  await expect(page.locator(".editor-query input").first()).toBeVisible();
}
test("embedded query keyboard sorting and task updates preserve their source", async ({ page }) => {
  await queryNote(page);
  const query = page.locator(".editor-query");
  const sort = query.getByRole("button", { name: "Sort by Task, ascending", exact: true });
  await sort.focus();
  await sort.press("Enter");
  await expect(query.getByRole("button", { name: "Sort by Task, descending", exact: true })).toBeFocused();
  const box = query.getByRole("checkbox").first();
  const label = await box.getAttribute("aria-label");
  await box.click();
  await expect(query.getByRole("checkbox", { name: label!, exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __mosaic: {
                mockInvoke(command: string, args: object): Promise<unknown>;
                useWorkspace: {
                  getState(): {
                    open(path: string, options: { newTab: boolean }): Promise<void>;
                    buffers: Record<string, { content: string }>;
                  };
                };
              };
            }
          ).__mosaic.useWorkspace.getState().buffers["Query UI.md"].content,
      ),
    )
    .toContain("task:open sort:text");
});
test("embedded queries follow app themes and keep narrow results local", async ({ page }, info) => {
  await queryNote(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const open = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          __mosaic: {
            mockInvoke(command: string, args: object): Promise<unknown>;
            useWorkspace: {
              getState(): {
                open(path: string, options: { newTab: boolean }): Promise<void>;
                buffers: Record<string, { content: string }>;
              };
            };
          };
        }
      ).__mosaic.useWorkspace
        .getState()
        .open("Query UI.md", { newTab: true }),
    );
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await open();
    const query = page.locator(".editor-query");
    await expect(query).toHaveCSS("font-size", "14px");
    await expect(query).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`query-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await open();
  await page.setViewportSize({ width: 320, height: 900 });
  const query = page.locator(".editor-query");
  await expect.poll(() => query.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator(".cm-content")).toHaveCSS("font-size", "16px");
  await page.screenshot({ path: info.outputPath("query-narrow.png") });
});

async function editorNote(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: {
          mockInvoke(command: string, args: object): Promise<unknown>;
          useWorkspace: { getState(): { open(path: string, options: { newTab: boolean }): Promise<void> } };
        };
      }
    ).__mosaic;
    await m.mockInvoke("write_file", {
      path: "Editor UI.md",
      content: "# Editor UI\n\n| Name | Qty |\n| --- | --- |\n| Apple | 3 |\n\nAfter table.\n",
      expectedHash: null,
    });
    await m.useWorkspace.getState().open("Editor UI.md", { newTab: true });
  });
  await expect(page.getByRole("group", { name: "Table editing", exact: true })).toBeVisible();
}
test("note table and search controls keep note fonts and keyboard behavior", async ({ page }) => {
  await editorNote(page);
  const toolbar = page.getByRole("group", { name: "Table editing", exact: true });
  await expect(toolbar).toHaveCSS("font-size", "14px");
  await expect(page.locator(".cm-table-wrap td").first()).toHaveCSS("font-size", "14.5px");
  await toolbar.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.getByRole("button", { name: "Back to table", exact: true }).click();
  await expect(toolbar).toBeVisible();
  await page.locator(".cm-content .cm-line").last().click();
  await page.keyboard.press("Meta+f");
  const search = page.locator(".cm-search");
  await expect(search).toHaveCSS("font-size", "14px");
  await search.getByRole("textbox", { name: "Find", exact: true }).fill("After");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content")).toBeFocused();
});
test("note editor controls follow themes and fit compact scaled panes", async ({ page }, info) => {
  await editorNote(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const open = () =>
    page.evaluate(async () => {
      const path = "/src/state/workspace.ts";
      const { useWorkspace } = await import(path);
      await useWorkspace.getState().open("Editor UI.md", { newTab: true });
    });
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await open();
    const toolbar = page.getByRole("group", { name: "Table editing", exact: true });
    await expect(toolbar).toHaveCSS("color", theme === "Light" ? "rgb(29, 31, 38)" : "rgb(228, 229, 234)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`editor-${theme.toLowerCase()}.png`) });
    await page.getByRole("tab", { name: "Settings Close tab", exact: true }).click();
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await open();
  await page.setViewportSize({ width: 320, height: 900 });
  const toolbar = page.getByRole("group", { name: "Table editing", exact: true });
  await expect.poll(() => toolbar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+f");
  const search = page.locator(".cm-search");
  await expect.poll(() => search.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("editor-narrow.png") });
});
test("note completion remains keyboard operated and fits scaled narrow windows", async ({ page }, info) => {
  await editorNote(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.evaluate(async () => {
    const path = "/src/state/workspace.ts";
    const { useWorkspace } = await import(path);
    await useWorkspace.getState().open("Editor UI.md", { newTab: true });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator(".cm-content .cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(list).toHaveCSS("font-size", "14px");
  await expect.poll(() => list.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath("editor-completion-narrow.png") });
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-table-wrap")).toHaveCount(2);
});
