import { expect, test } from "@playwright/test";
import { openMockVault } from "./mock-vault";

test("a finished workflow raises a notification that can be read and dismissed", async ({ page }) => {
  await openMockVault(page);
  const bell = page.getByRole("button", { name: /^Notifications/ });
  await expect(bell).toBeVisible();

  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("radio", { name: "Automations", exact: true }).click();
  await page
    .getByRole("navigation", { name: "AI views", exact: true })
    .getByRole("button", { name: "Workflows", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Workflow catalog", exact: true })
    .getByRole("article", { name: "Weekly review", exact: true })
    .getByRole("button", { name: "Run now", exact: true })
    .click();

  await expect(page.getByRole("button", { name: /Notifications \(\d+ unread\)/ })).toBeVisible();
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const list = page.getByRole("region", { name: "Notifications" });
  await expect(list.getByText(/Weekly review.* (finished|failed)/).first()).toBeVisible();

  await list.getByRole("button", { name: "Dismiss" }).first().click();
  await expect(list.getByText(/all caught up/)).toBeVisible();
});
