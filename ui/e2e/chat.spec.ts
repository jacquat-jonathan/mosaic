import { expect, test, type Page } from "@playwright/test";

async function openChat(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Chat", exact: true }).getByLabel("Message to Claude", { exact: true }),
  ).toBeVisible();
}
async function chatTab(page: Page) {
  await page.getByRole("tab", { name: "New chat Close tab", exact: true }).click();
}

test("chat composer keeps attachment focus, keyboard sending, tools and saved-note actions", async ({ page }) => {
  await openChat(page);
  const chat = page.getByRole("group", { name: "Chat", exact: true });
  const message = chat.getByLabel("Message to Claude", { exact: true });
  const attach = chat.getByRole("button", { name: "Attach a note", exact: true });
  await attach.click();
  await page.keyboard.press("Escape");
  await expect(attach).toBeFocused();
  await chat.getByRole("button", { name: "Detach Ideas", exact: true }).click();
  await expect(message).toBeFocused();
  await expect(chat.getByRole("button", { name: "Detach Ideas", exact: true })).toHaveCount(0);
  await chat.getByLabel("Chat model", { exact: true }).selectOption("haiku");
  await message.fill("Summarize this note");
  await message.press("Shift+Enter");
  await expect(message).toHaveValue("Summarize this note\n");
  await expect(chat.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await message.press("Enter");
  await expect(chat.getByText("Done: I added a line to", { exact: false })).toBeVisible();
  await expect(chat.getByTitle("What this chat has cost so far")).toBeVisible();
  const tool = chat.locator(".mds-tool").first();
  await tool.locator("summary").press("Enter");
  await expect(tool.getByRole("button", { name: /^Open / })).toBeVisible();
  await chat.getByRole("button", { name: "Save as note", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: /Summarize this note Close tab/ }).and(page.locator('[aria-selected="true"]')),
  ).toHaveAttribute("title", /Agents\/Chats\//);
});

test("chat and context follow themes and fit narrow panes at maximum scale", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openChat(page);
  const chat = page.getByRole("group", { name: "Chat", exact: true });
  const context = page.getByRole("group", { name: "Chat context", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await chatTab(page);
    await expect(chat).toHaveCSS("font-size", "14px");
    await expect(context).toHaveCSS("font-size", "14px");
    await expect(context.getByRole("heading", { name: "Attachments", exact: true })).toHaveCSS(
      "text-transform",
      "none",
    );
    await expect(context.locator("dt").first()).toHaveCSS("font-size", "13px");
    await expect(chat).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await expect(chat.getByText("Preview", { exact: true })).toHaveCount(0);
    if (theme !== "System") await page.screenshot({ path: testInfo.outputPath(`chat-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await chatTab(page);
  await chat.getByLabel("Message to Claude", { exact: true }).fill("Draft stays while resizing");
  await expect(chat).toHaveAttribute("data-density", "compact");
  await expect
    .poll(() => context.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  for (const width of [920, 720, 650, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => chat.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await expect(chat.getByLabel("Message to Claude", { exact: true })).toHaveValue("Draft stays while resizing");
  }
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("chat-narrow.png") });
});
