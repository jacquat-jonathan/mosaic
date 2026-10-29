import { expect, test, type Page } from "@playwright/test";

async function openChats(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "All chats", exact: true }).click();
}
async function namedChat(page: Page, title: string) {
  await page
    .getByRole("group", { name: "Chats list", exact: true })
    .getByRole("button", { name: "New chat", exact: true })
    .click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill(title);
  await page.getByRole("dialog").getByRole("button", { name: "OK", exact: true }).click();
  await page.getByRole("button", { name: "All chats", exact: true }).click();
}

test("chats list preserves new chat, selection, cancelled actions and deletion focus", async ({ page }) => {
  await openChats(page);
  const history = page.getByRole("group", { name: "Chats list", exact: true });
  await expect(history.getByText("Your saved conversations appear here.", { exact: true })).toBeVisible();
  await namedChat(page, "List migration");
  const actions = history.getByRole("button", { name: "Actions for List migration", exact: true });
  await actions.click();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await actions.click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(actions).toBeFocused();
  await actions.click();
  await page.getByRole("menuitem", { name: "Delete chat", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(actions).toBeFocused();
  await history.getByRole("button", { name: "List migration", exact: true }).click();
  const sidebar = page.getByRole("group", { name: "Saved chats", exact: true });
  await expect(sidebar.getByRole("button", { name: "List migration", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "All chats", exact: true }).click();
  await actions.click();
  await page.getByRole("menuitem", { name: "Delete chat", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(history.getByRole("button", { name: "New chat", exact: true })).toBeFocused();
  await expect(history.getByText("Your saved conversations appear here.", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "List migration Close tab", exact: true })).toHaveCount(0);
});

test("chats list follows themes and wraps long titles in narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openChats(page);
  await namedChat(page, "Planning the next release and reviewing the remaining work");
  const history = page.getByRole("group", { name: "Chats list", exact: true });
  const sidebar = page.getByRole("group", { name: "Saved chats", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page.getByRole("button", { name: "All chats", exact: true }).click();
    await expect(history).toHaveCSS("font-size", "14px");
    await expect(sidebar).toHaveCSS("font-size", "14px");
    await expect(history).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`chats-list-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page.getByRole("button", { name: "All chats", exact: true }).click();
  await expect(history).toHaveAttribute("data-density", "compact");
  await expect
    .poll(() => sidebar.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  for (const width of [920, 720, 650, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => history.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("chats-list-narrow.png") });
  await history
    .getByRole("button", { name: "Planning the next release and reviewing the remaining work", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Show right panel", exact: true }).click();
  await expect(page.locator(".context-head")).toHaveCSS("font-size", "14px");
  await expect(page.locator(".context-head.mosaic-ds")).toHaveCount(1);
});
