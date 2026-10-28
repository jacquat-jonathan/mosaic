import { expect, test, type Page } from "@playwright/test";
import type { TemplateConfig, TemplatePreview } from "../src/ipc/types";

async function mock<T>(page: Page, command: string, args: object = {}) {
  return page.evaluate(
    async ({ command, args }) =>
      (
        window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } }
      ).__mosaic.mockInvoke(command, args),
    { command, args },
  ) as Promise<T>;
}
async function openVault(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
}
async function refresh(page: Page) {
  await page.evaluate(async () => {
    await (
      window as unknown as { __mosaic: { useVault: { getState(): { refresh(): Promise<void> } } } }
    ).__mosaic.useVault
      .getState()
      .refresh();
  });
}
async function seed(page: Page, path: string, content: string) {
  const { root } = await mock<{ root: string }>(page, "current_vault");
  await mock(page, "create_file", { path, content, root });
  await refresh(page);
}
async function openTemplates(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Templates", exact: true })
    .click();
  await expect(page.getByLabel("Templates folder", { exact: true })).toHaveValue("Templates");
}
const settings = (page: Page) => page.getByRole("group", { name: "Template preferences", exact: true });
const config = (page: Page) => mock<TemplateConfig>(page, "template_config");
const render = (page: Page, path: string) =>
  mock<TemplatePreview>(page, "render_template", {
    request: { path, blank: false, template: null, timestamp: "2026-10-28T10:30:00Z", expected_template_hash: null },
  });
async function save(page: Page) {
  const button = settings(page).getByRole("button", { name: "Save template settings", exact: true });
  await button.focus();
  await page.keyboard.press("Space");
  await expect(button).toBeDisabled();
  await expect(settings(page).getByText("Template settings saved for this vault.", { exact: true })).toBeVisible();
}

test("folder defaults stay staged until saved and preserve inheritance and Blank", async ({ page }) => {
  await openVault(page);
  const source = "# {{title}}\n\nMeeting template\nDate: {{date}}";
  await seed(page, "Templates/Meeting.md", source);
  await openTemplates(page);
  const templates = settings(page);
  await expect(templates.getByText("No folder defaults yet.", { exact: true })).toBeVisible();
  await templates.getByRole("button", { name: "Add folder default", exact: true }).click();
  await templates.getByLabel("Default template", { exact: true }).selectOption("Templates/Meeting.md");
  expect((await config(page)).rules).toEqual([]);
  await expect(templates.getByRole("button", { name: "Preview starter templates", exact: true })).toBeDisabled();
  await save(page);
  expect((await render(page, "Result.md")).content).toContain("Meeting template");
  await templates.getByRole("button", { name: "Add folder default", exact: true }).click();
  const rule = templates.getByRole("group", { name: "Default 2", exact: true });
  await rule.getByLabel("Destination folder", { exact: true }).selectOption("Projects");
  await save(page);
  expect((await render(page, "Projects/Sub/Result.md")).content).toBe("");
  expect((await render(page, "Elsewhere/Result.md")).content).toContain("Meeting template");
  await templates.getByRole("button", { name: "Remove default for Projects", exact: true }).click();
  expect((await config(page)).rules).toHaveLength(2);
  await save(page);
  expect((await render(page, "Projects/Sub/Result.md")).content).toContain("Meeting template");
  expect((await mock<{ content: string }>(page, "read_file", { path: "Templates/Meeting.md" })).content).toBe(source);
});

test("folder creation and starter installation are explicit and existing templates are kept", async ({ page }) => {
  await openVault(page);
  await openTemplates(page);
  const templates = settings(page);
  const entries = () => mock<Array<{ path: string; is_dir: boolean }>>(page, "list_dir", { dir: "", recursive: true });
  expect((await entries()).some((entry) => entry.path === "Templates")).toBe(false);
  await expect(templates.getByText("No saved Markdown templates in this folder yet.", { exact: true })).toBeVisible();
  await templates.getByRole("button", { name: "Create templates folder", exact: true }).click();
  await expect
    .poll(async () => (await entries()).some((entry) => entry.path === "Templates" && entry.is_dir))
    .toBe(true);
  await expect(templates.getByRole("button", { name: "Create templates folder", exact: true })).toHaveCount(0);
  await seed(page, "Templates/Meeting.md", "# My existing meeting template");
  const preview = templates.getByRole("button", { name: "Preview starter templates", exact: true });
  await preview.click();
  const panel = templates.getByRole("region", { name: "Starter template previews", exact: true });
  await panel.locator("summary").filter({ hasText: "Meeting.md" }).click();
  await expect(panel.locator("pre").first()).toContainText("{{date}}");
  expect((await entries()).some((entry) => entry.path === "Templates/Project.md")).toBe(false);
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(preview).toBeFocused();
  expect((await entries()).some((entry) => entry.path === "Templates/Project.md")).toBe(false);
  await preview.click();
  await panel.getByRole("button", { name: "Add starter templates", exact: true }).click();
  await expect(templates.getByRole("status")).toContainText("Kept existing Meeting.md");
  await expect(preview).toBeFocused();
  expect((await mock<{ content: string }>(page, "read_file", { path: "Templates/Meeting.md" })).content).toBe(
    "# My existing meeting template",
  );
  await expect(templates.getByRole("button", { name: "Templates/Project.md", exact: true })).toBeVisible();
});

test("template controls and expanded previews match themes and fit narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openVault(page);
  await seed(page, "Templates/Meeting.md", "# {{title}}\n\nMeeting template\nDate: {{date}}");
  await mock(page, "set_template_config", {
    config: {
      version: 1,
      folder: "Templates",
      rules: [
        { folder: "", template: "Templates/Meeting.md" },
        { folder: "Projects", template: null },
      ],
    },
  });
  await openTemplates(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const templates = settings(page);
  await expect(templates).toHaveCSS("font-size", "14px");
  for (const theme of ["Light", "Dark", "System"] as const) {
    await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await navigation.getByRole("button", { name: "Templates", exact: true }).click();
    await expect(templates).toHaveCSS("background-color", theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)");
    await templates.getByRole("button", { name: "Preview starter templates", exact: true }).click();
    await templates.locator("summary").first().click();
    await page.locator(".settings-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`templates-${theme.toLowerCase()}.png`) });
  }
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await navigation.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(templates).toHaveAttribute("data-density", "compact");
  await templates.getByRole("button", { name: "Preview starter templates", exact: true }).click();
  await templates.locator("summary").first().click();
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.locator(".settings-scroll").evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await page.locator(".settings-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await navigation.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: testInfo.outputPath("templates-narrow.png") });
  await navigation.getByRole("button", { name: "Connections & safety", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(page.locator(".connect-ai .mosaic-ds")).toHaveCount(0);
});
