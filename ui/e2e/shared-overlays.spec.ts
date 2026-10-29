import { expect, test, type Page } from "@playwright/test";
async function setup(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.waitForFunction(() => "__mosaic" in window);
}
async function prompt(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/state/ui.ts";
    const { useUi } = await import(path);
    void useUi.getState().askText({ title: "Rename file", value: "Original.md" });
  });
}
test("prompt contains keyboard focus, selects text and returns focus", async ({ page }) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "New note", exact: true });
  await opener.focus();
  await prompt(page);
  const dialog = page.getByRole("dialog", { name: "Rename file", exact: true });
  const input = dialog.getByRole("textbox", { name: "Rename file", exact: true });
  await expect(input).toBeFocused();
  expect(await input.evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!)).toBe(11);
  await dialog.getByRole("button", { name: "OK", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await input.fill("Updated.md");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await prompt(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
test("prompt shares themes and fits scaled narrow windows", async ({ page }, info) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await prompt(page);
    const dialog = page.getByRole("dialog", { name: "Rename file", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`prompt-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await prompt(page);
  const dialog = page.getByRole("dialog", { name: "Rename file", exact: true });
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("prompt-narrow.png") });
});

async function confirm(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/state/ui.ts";
    const { useUi } = await import(path);
    void useUi.getState().ask({
      title: "Delete file?",
      body: "Move this file to trash. You can restore it from history.",
      confirmLabel: "Delete",
      danger: true,
    });
  });
}
test("confirmation traps focus and cancels with focus return", async ({ page }) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "New note", exact: true });
  await opener.focus();
  await confirm(page);
  const dialog = page.getByRole("dialog", { name: "Delete file?", exact: true });
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await confirm(page);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test("confirmation shares themes and fits scaled narrow windows", async ({ page }, info) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await confirm(page);
    const dialog = page.getByRole("dialog", { name: "Delete file?", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`confirmation-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await confirm(page);
  const dialog = page.getByRole("dialog", { name: "Delete file?", exact: true });
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("confirmation-narrow.png") });
});

test("new note shares themes and fits scaled narrow windows", async ({ page }, info) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await openNewNote(page);
    const dialog = page.getByRole("dialog", { name: "New note", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`new-note-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await openNewNote(page);
  const dialog = page.getByRole("dialog", { name: "New note", exact: true });
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("new-note-narrow.png") });
});

async function openNewNote(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/actions.ts";
    const { newNote } = await import(path);
    await newNote("", "Draft", true);
  });
}

async function picker(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/state/ui.ts";
    const { useUi } = await import(path);
    useUi.getState().openPicker({
      placeholder: "Choose a note",
      hint: "Arrow keys to select · Enter to choose",
      items: [
        { id: "alpha", label: "Alpha", detail: "A long folder/with a readable path/Alpha.md", shortcut: "⌘1" },
        { id: "beta", label: "Beta", detail: "Beta.md" },
      ],
      onPick() {},
    });
  });
}
test("picker retains fuzzy filtering, keyboard choices, empty state and focus return", async ({ page }) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "New note", exact: true });
  await opener.focus();
  await picker(page);
  const dialog = page.getByRole("dialog", { name: "Choose a note", exact: true });
  const search = dialog.getByRole("combobox", { name: "Choose a note", exact: true });
  await expect(search).toBeFocused();
  await search.fill("zzzz");
  await expect(dialog.getByText("No matches", { exact: true })).toBeVisible();
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(dialog).toBeVisible();
  await search.fill("a");
  await search.press("ArrowDown");
  await expect(dialog.getByRole("option", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
test("picker shares themes and fits scaled narrow windows", async ({ page }, info) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await picker(page);
    const dialog = page.getByRole("dialog", { name: "Choose a note", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`picker-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await picker(page);
  const dialog = page.getByRole("dialog", { name: "Choose a note", exact: true });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("picker-narrow.png") });
});

async function switcher(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/state/ui.ts";
    const { useUi } = await import(path);
    useUi.getState().setSwitcher(true);
  });
}
test("quick switcher retains search, keyboard opening, creation and focus return", async ({ page }) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "New note", exact: true });
  await opener.focus();
  await switcher(page);
  const dialog = page.getByRole("dialog", { name: "Quick switcher", exact: true });
  const search = dialog.getByRole("combobox", { name: "Find or create a note", exact: true });
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(opener).toBeFocused();
  await switcher(page);
  await search.fill("Welcome");
  await search.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("Welcome");
  await switcher(page);
  await search.fill("New switcher note");
  await expect(dialog.getByRole("option", { name: "Create “New switcher note”", exact: true })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByRole("dialog", { name: "New note", exact: true }).getByLabel("Name")).toHaveValue(
    "New switcher note",
  );
});
test("quick switcher shares themes and fits scaled narrow windows", async ({ page }, info) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await switcher(page);
    const dialog = page.getByRole("dialog", { name: "Quick switcher", exact: true });
    await expect(dialog).toHaveCSS("font-size", "14px");
    await expect(dialog).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: info.outputPath(`quick-switcher-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await switcher(page);
  const dialog = page.getByRole("dialog", { name: "Quick switcher", exact: true });
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("quick-switcher-narrow.png") });
});

async function contextMenu(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/state/ui.ts";
    const { useUi } = await import(path);
    useUi.getState().showMenu(window.innerWidth - 20, window.innerHeight - 20, [
      { label: "Open note", detail: "Folder/Readable note.md", shortcut: "⌘O", action() {} },
      { label: "Unavailable", disabled: true },
      {
        label: "More actions",
        children: [
          { label: "Copy link", action() {} },
          { label: "Delete note", danger: true, action() {} },
        ],
      },
      { label: "Show details", checked: true, action() {} },
    ]);
  });
  await expect
    .poll(() => page.getByRole("menu").evaluate((el) => el.getBoundingClientRect().right))
    .toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}
test("context menu preserves nested keyboard navigation, edge flipping and focus return", async ({ page }) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "New note", exact: true });
  await opener.focus();
  await contextMenu(page);
  const first = page.getByRole("menuitem", { name: /Open note/ });
  await expect(first).toBeFocused();
  await first.press("ArrowDown");
  const more = page.getByRole("menuitem", { name: "More actions", exact: true });
  await expect(more).toBeFocused();
  await more.press("ArrowRight");
  const copy = page.getByRole("menuitem", { name: "Copy link", exact: true });
  await expect(copy).toBeFocused();
  await copy.press("ArrowLeft");
  await expect(more).toBeFocused();
  await more.press("ArrowRight");
  await expect(copy).toBeFocused();
  for (const menu of await page.getByRole("menu").all()) {
    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  }
  await copy.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(opener).toBeFocused();
  await contextMenu(page);
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});
test("context menu shares themes and fits scaled narrow windows", async ({ page }, info) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const theme of ["Light", "Dark", "System"]) {
    await page.getByRole("radio", { name: theme, exact: true }).check();
    await contextMenu(page);
    const menu = page.getByRole("menu");
    await expect(menu).toHaveCSS("font-size", "14px");
    await expect(menu).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System") await page.screenshot({ path: info.outputPath(`context-menu-${theme.toLowerCase()}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.setViewportSize({ width: 320, height: 900 });
  await contextMenu(page);
  await page.getByRole("menuitem", { name: "More actions", exact: true }).press("ArrowRight");
  for (const menu of await page.getByRole("menu").all()) {
    await expect.poll(() => menu.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(321);
    await expect.poll(() => menu.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(901);
    expect((await menu.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await expect.poll(() => menu.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: info.outputPath("context-menu-narrow.png") });
});
