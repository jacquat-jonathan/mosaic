import { expect, test } from "@playwright/test";

test("standalone gallery follows explicit and system themes without starting the app", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/design-system.html?theme=system");
  const root = page.locator(".mosaic-ds");
  await expect(root).toHaveCSS("background-color", "rgb(30, 31, 36)");
  await page
    .getByRole("radiogroup", { name: "Preview theme", exact: true })
    .getByLabel("Light", { exact: true })
    .check();
  await expect(root).toHaveCSS("background-color", "rgb(255, 255, 255)");
  expect(requests.some((url) => /\/src\/(App|ipc|state)\b/.test(url))).toBe(false);

  await page.getByRole("switch", { name: "Show hidden files", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Settings hidden files" })).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("dialogs contain focus, validate input, and return focus on Escape", async ({ page }) => {
  await page.goto("/design-system.html");
  const trigger = page.getByRole("button", { name: "Open dialog", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create a new note" });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox", { name: "New note title" });
  await expect(field).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Create note", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(field).toBeFocused();
  await field.fill("");
  await dialog.getByRole("button", { name: "Create note", exact: true }).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription("Enter a title for your note.");
  await field.fill("Review notes");
  await dialog.getByRole("button", { name: "Create note", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.locator(".ds-preview-status")).toContainText("Review notes");
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("menu navigation skips disabled actions and tooltips dismiss with Escape", async ({ page }) => {
  await page.goto("/design-system.html");
  const trigger = page.getByRole("button", { name: "Note actions", exact: true });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Note actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Open note" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Delete note…" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem", { name: "Open note" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Delete note…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Copy link" }).click();
  await expect(page.locator(".ds-preview-status")).toContainText("Copy link selected");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("heading", { name: "Overlays", exact: true }).click();
  await expect(menu).not.toBeVisible();
  const tooltip = page.getByRole("tooltip");
  const tooltipButton = page.locator(".mds-tooltip-anchor button");
  await tooltipButton.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltipButton).toHaveAccessibleDescription("Create a note in the current folder");
  await page.keyboard.press("Escape");
  await expect(tooltip).not.toBeVisible();
});

test("fields use a single focus boundary and pointer menus have one active row", async ({ page }) => {
  await page.goto("/design-system.html?theme=dark");
  await expect(page.locator(".mosaic-ds")).toHaveCSS("font-size", "14px");
  for (const field of [
    page.getByRole("textbox", { name: "Note title", exact: true }),
    page.getByLabel("Default folder", { exact: true }),
  ]) {
    await field.focus();
    await expect(field).toHaveCSS("outline-offset", "-1px");
    await expect(field).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await expect(field).toHaveCSS("box-shadow", "none");
  }
  await page.getByRole("button", { name: "Note actions", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Note actions", exact: true });
  const first = menu.getByRole("menuitem", { name: "Open note" });
  const second = menu.getByRole("menuitem", { name: "Copy link" });
  await expect(first).not.toBeFocused();
  await first.hover();
  await expect(first).toBeFocused();
  await second.hover();
  await expect(second).toBeFocused();
  await expect(first).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(second).toHaveCSS("background-color", "rgb(109, 155, 255)");
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();
  await expect(second).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("the Lucide catalog searches every name and shows the selected import", async ({ page }) => {
  await page.goto("/design-system.html#icons");
  const search = page.getByRole("textbox", { name: "Find a Lucide icon" });
  await page.getByRole("button", { name: "Next icons", exact: true }).click();
  await expect(page.locator(".ds-icon-pagination")).toContainText("Page 2 of");
  await search.fill("calendar-days");
  const tile = page.locator(".ds-icon-grid").getByRole("button", { name: "CalendarDays", exact: true });
  await tile.click();
  await expect(page.locator(".ds-icon-selection")).toContainText('import { CalendarDays } from "lucide-react";');
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radiogroup", { name: "Icon preview size" }).getByLabel("24px").check();
  await expect(tile.locator("svg")).toHaveAttribute("width", "24");
  await search.fill("no-such-icon-name");
  await expect(page.getByText("No icons match", { exact: false })).toBeVisible();
});

test("workflow, run, chat, and review examples operate only on sample data", async ({ page }) => {
  await page.goto("/design-system.html#workflows");
  const workflow = page.getByRole("article", { name: "Daily summary", exact: true });
  await expect(workflow).toContainText("Today's daily note and its linked notes");
  await expect(workflow).toContainText("A summary in Drafts/Daily-summary.md");
  await expect(workflow.getByText("daily-summary", { exact: true })).not.toBeVisible();
  await workflow.getByText("Workflow settings", { exact: true }).click();
  await expect(workflow.getByText("daily-summary", { exact: true })).toBeVisible();
  await workflow.getByRole("button", { name: "Run now" }).click();
  await expect(workflow.getByRole("button", { name: "Run now" })).toBeDisabled();
  await page.locator("#workflows").getByRole("button", { name: "Finish preview run" }).click();
  await expect(workflow).toContainText("Needs review");
  await page.locator("#runs").getByRole("button", { name: "Project digest", exact: true }).click();
  await expect(page.getByRole("article", { name: "Run detail: Project digest" })).toContainText(
    "no files were changed",
  );

  const chat = page.locator("#chat");
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Suggest a next action");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Finish preview response" }).click();
  await expect(chat).toContainText("Sample response: the summary is ready for your review.");

  const activity = page.locator("#activity");
  await activity.getByRole("button", { name: "Review", exact: true }).first().click();
  let dialog = page.getByRole("dialog", { name: "Review changes to Daily summary" });
  await expect(dialog.getByLabel("Proposed changes")).toContainText("Validate the design system");
  await dialog.getByRole("button", { name: "Reject…", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Reason for rejection" }).fill("Please keep the original heading.");
  await dialog.getByRole("button", { name: "Confirm rejection" }).click();
  await expect(page.locator(".ds-preview-status")).toContainText("Please keep the original heading.");
  await activity.getByRole("button", { name: "Review", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Review changes to Project roadmap" });
  await expect(dialog.getByRole("button", { name: "Accept change" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Accept change" }).click();
  await expect(activity.getByText("You're all caught up.", { exact: false })).toBeVisible();
  await activity
    .getByRole("region", { name: "Applied changes preview" })
    .getByRole("button", { name: "Undo", exact: true })
    .first()
    .click();
  await expect(activity.getByRole("button", { name: "Review", exact: true })).toBeVisible();
});
