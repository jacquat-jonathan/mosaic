import { expect, test, type Page } from "@playwright/test";
import type { AgentRule } from "../src/ipc/types";

async function openConnections(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Connections & safety", exact: true })
    .click();
}
async function mock<T>(page: Page, command: string) {
  return page.evaluate(
    async (command) =>
      (
        window as unknown as { __mosaic: { mockInvoke(command: string, args: object): Promise<unknown> } }
      ).__mosaic.mockInvoke(command, {}),
    command,
  ) as Promise<T>;
}
async function addRule(page: Page) {
  await page.getByRole("button", { name: "Add a folder…", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Which folder should agents treat differently?", exact: true })
    .getByRole("option", { name: "Projects", exact: true })
    .click();
  await expect(page.getByLabel("Access for Projects", { exact: true })).toBeEnabled();
}

test("connection setup and safety choices persist with explicit folder selection", async ({ page }) => {
  await openConnections(page);
  const connections = page.getByRole("group", { name: "Connections and safety", exact: true });
  await connections.getByRole("button", { name: "Install", exact: true }).click();
  await expect(connections.getByText("Installed", { exact: true })).toBeVisible();
  await expect(connections.locator(".connection-cli-status")).toBeFocused();
  await expect(connections.locator("pre").first()).toContainText("claude mcp add --scope user mosaic --");
  await expect(connections.locator("pre").first()).not.toContainText("--vault");
  const add = connections.getByRole("button", { name: "Add a folder…", exact: true });
  await add.click();
  await page
    .getByRole("dialog", { name: "Which folder should agents treat differently?", exact: true })
    .getByRole("combobox")
    .press("Escape");
  await expect(add).toBeFocused();
  expect(await mock<AgentRule[]>(page, "get_agent_rules")).toEqual([]);
  await addRule(page);
  await expect(add).toBeFocused();
  expect(await mock<AgentRule[]>(page, "get_agent_rules")).toEqual([{ path: "Projects", access: "review" }]);
  const access = connections.getByLabel("Access for Projects", { exact: true });
  for (const value of ["hidden", "read-only", "review"]) {
    await access.selectOption(value);
    await expect(access).toBeEnabled();
    expect(await mock<AgentRule[]>(page, "get_agent_rules")).toEqual([{ path: "Projects", access: value }]);
  }
  const depth = connections.getByLabel("Maximum workflow chain depth", { exact: true });
  await depth.selectOption("0");
  await expect(depth).toBeEnabled();
  expect(await mock(page, "tessera_status")).toMatchObject({ max_chain_depth: 0 });
  await connections.getByRole("button", { name: "Remove the rule for Projects", exact: true }).click();
  await expect(add).toBeFocused();
  expect(await mock<AgentRule[]>(page, "get_agent_rules")).toEqual([]);
});

test("connection setup and rules follow themes and fit narrow panes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openConnections(page);
  await addRule(page);
  const connections = page.getByRole("group", { name: "Connections and safety", exact: true });
  for (const theme of ["Light", "Dark", "System"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Theme", exact: true })
      .getByRole("radio", { name: theme, exact: true })
      .check();
    await page
      .getByRole("navigation", { name: "Settings sections", exact: true })
      .getByRole("button", { name: "Connections & safety", exact: true })
      .click();
    await expect(connections).toHaveCSS("font-size", "14px");
    await expect(connections).toHaveCSS(
      "background-color",
      theme === "Light" ? "rgb(255, 255, 255)" : "rgb(30, 31, 36)",
    );
    await expect(connections.getByLabel("Access for Projects", { exact: true })).toBeEnabled();
    if (theme !== "System")
      await page.screenshot({ path: testInfo.outputPath(`connections-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface density", { exact: true }).selectOption("compact");
  await page.getByRole("slider", { name: "Interface scale", exact: true }).press("End");
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Connections & safety", exact: true })
    .click();
  await expect(connections).toHaveAttribute("data-density", "compact");
  for (const width of [920, 720, 650]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => connections.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
  await connections.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.screenshot({ path: testInfo.outputPath("connections-narrow.png") });
  await connections.getByLabel("Maximum workflow chain depth", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("connections-narrow-rules.png") });
});
