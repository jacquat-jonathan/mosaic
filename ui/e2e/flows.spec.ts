import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

test.afterEach(async ({ page }) => {
  if (process.env.VITE_COVERAGE !== "true") return;
  const coverage = await page.evaluate(
    () => (window as unknown as { __coverage__?: Record<string, unknown> }).__coverage__ ?? null,
  );
  if (!coverage) throw new Error("E2E coverage was requested, but the app was not instrumented");
  const directory = path.resolve(import.meta.dirname, "../.nyc_output");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `e2e-${randomUUID()}.json`), JSON.stringify(coverage));
});

/** Opens the mock vault from the welcome screen and waits for its file tree. */
async function openVault(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder…" }).click();
  await expect(page.getByRole("treeitem", { name: /^Welcome/ })).toBeVisible();
  // The dev-only handle for driving the mock (see main.tsx) is installed after the first render.
  await page.waitForFunction(() => "__mosaic" in window);
}

async function readMockFile(page: Page, path: string) {
  return page.evaluate((file) => {
    const m = (
      window as unknown as {
        __mosaic: { mockInvoke: (command: string, args: object) => Promise<{ content: string }> };
      }
    ).__mosaic;
    return m.mockInvoke("read_file", { path: file }).then((value) => value.content);
  }, path);
}

async function openMockPath(page: Page, path: string) {
  await page.evaluate(async (file) => {
    const workspace = (
      window as unknown as {
        __mosaic: {
          useWorkspace: {
            getState(): { open(path: string, options: { newTab: boolean }): Promise<void> };
          };
        };
      }
    ).__mosaic.useWorkspace;
    await workspace.getState().open(file, { newTab: false });
  }, path);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __mosaic: { useWorkspace: { getState(): { activePath(): string | null } } };
          }
        ).__mosaic.useWorkspace
          .getState()
          .activePath(),
      ),
    )
    .toBe(path);
}

async function createEditingConflict(page: Page) {
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  // Hold the page's timers so the 400 ms autosave can't run: the words stay unsaved. 50 ms lets
  // the editor report the edit to the workspace.
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await page.keyboard.type(" my unsaved words");
  await page.clock.runFor(50);
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: { mockInvoke: (c: string, a: object) => Promise<unknown>; external: (p: string[]) => void };
      }
    ).__mosaic;
    await m.mockInvoke("write_file", {
      path: "Ideas.md",
      content: "# Ideas\n\nChanged by an agent.\n",
      expectedHash: null,
      root: null,
    });
    m.external(["Ideas.md"]);
  });
  await expect(page.getByText("This file changed on disk while you were editing it.")).toBeVisible();
  return editor;
}

test("open a note", async ({ page }) => {
  await openVault(page);
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Ideas");
});

test("create, edit, autosave, find and reopen a note", async ({ page }) => {
  await openVault(page);
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New note" });
  await dialog.getByLabel("Name").fill("E2E journey");
  await dialog.getByRole("combobox").nth(1).selectOption("blank");
  await expect(dialog.getByRole("button", { name: "Create" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Create" }).click();

  const editor = page.locator(".cm-content");
  await expect(editor).toBeFocused();
  await page.keyboard.type("A uniquely searchable E2E sentence.");
  await expect
    .poll(() => readMockFile(page, "E2E journey.md"), { timeout: 5_000 })
    .toContain("uniquely searchable E2E sentence");

  await page.getByRole("tab", { name: "Find" }).click();
  await page.getByRole("textbox", { name: "Search notes" }).fill("uniquely searchable");
  const result = page.locator(".result", { hasText: "E2E journey" });
  await expect(result).toBeVisible();
  await result.click();
  await expect(editor).toContainText("uniquely searchable E2E sentence");
});

test("rename a note and its links follow", async ({ page }) => {
  await openVault(page);
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke: (c: string, a: object) => Promise<unknown> } }).__mosaic;
    await m.mockInvoke("create_file", { path: "E2E/Target.md", content: "# Target", root: null });
    await m.mockInvoke("create_file", { path: "E2E/Source.md", content: "See [[Target]].", root: null });
    (window as unknown as { __mosaic: { external: (p: string[]) => void } }).__mosaic.external([
      "E2E/Target.md",
      "E2E/Source.md",
    ]);
  });
  await page.getByRole("treeitem", { name: "E2E" }).click();
  const target = page.getByRole("treeitem", { name: "Target", exact: true });
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.getByRole("textbox", { name: "New name" });
  await input.fill("Renamed");
  await input.press("Enter");
  await expect(page.getByRole("treeitem", { name: "Renamed", exact: true })).toBeVisible();
  const source = await page.evaluate(() =>
    (window as unknown as { __mosaic: { mockInvoke: (c: string, a: object) => Promise<{ content: string }> } }).__mosaic
      .mockInvoke("read_file", { path: "E2E/Source.md" })
      .then((f) => f.content),
  );
  expect(source).toBe("See [[Renamed]].");
});

test("an outside change to a note being edited asks which version to keep", async ({ page }) => {
  await openVault(page);
  const editor = await createEditingConflict(page);
  await page.getByRole("button", { name: "Keep mine" }).click();
  await expect(editor).toContainText("my unsaved words");
});

test("compare a conflicting edit and load the disk version", async ({ page }) => {
  await openVault(page);
  const editor = await createEditingConflict(page);
  await page.getByRole("button", { name: "Compare" }).click();
  const comparison = page.getByText("Disk version → your version").locator("..");
  await expect(comparison).toContainText("Changed by an agent.");
  await expect(comparison).toContainText("my unsaved words");
  await comparison.getByRole("button", { name: "Load disk version" }).click();
  await expect(editor).toContainText("Changed by an agent.");
  await expect(editor).not.toContainText("my unsaved words");
});

test("accept an agent's proposal from review", async ({ page }) => {
  await openVault(page);
  await page.evaluate(() =>
    (globalThis as unknown as { mosaicMock: { propose: (p: string, c: string) => number } }).mosaicMock.propose(
      "Welcome.md",
      "# Welcome\n\nRewritten by an agent.\n",
    ),
  );
  await page.getByRole("tab", { name: "AI" }).click();
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: /Activity & review · 1/ }).click();
  await page.getByRole("region", { name: "Waiting for your review" }).getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByRole("treeitem", { name: /^Welcome/ }).click();
  await expect(page.locator(".cm-content")).toContainText("Rewritten by an agent.");
});

test("reject an agent's proposal with feedback", async ({ page }) => {
  await openVault(page);
  await page.evaluate(() =>
    (globalThis as unknown as { mosaicMock: { propose: (p: string, c: string) => number } }).mosaicMock.propose(
      "Welcome.md",
      "# Welcome\n\nA proposal that should be rejected.\n",
    ),
  );
  await page.getByRole("tab", { name: "AI" }).click();
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: /Activity & review · 1/ }).click();
  await page.getByRole("region", { name: "Waiting for your review" }).getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Reject…" }).click();
  await page.getByPlaceholder("e.g. keep the old wording").fill("Keep the original welcome copy.");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByRole("region", { name: "Waiting for your review" })).toBeHidden();
  expect(await readMockFile(page, "Welcome.md")).not.toContain("should be rejected");
});

test("create a planner task and move it through the workflow", async ({ page }) => {
  await openVault(page);
  await page.getByRole("tab", { name: "Plan" }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  const startEmpty = page.getByRole("button", { name: "Start empty" });
  if (await startEmpty.isVisible()) await startEmpty.click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const prompt = page.getByRole("heading", { name: "New task" }).locator("..");
  await prompt.getByPlaceholder("What needs doing?").fill("Verify the release journey");
  await prompt.getByRole("button", { name: "OK" }).click();

  const card = page.locator("article", { hasText: "Verify the release journey" });
  await expect(card).toBeVisible();
  await card.click();
  const editor = page.getByRole("complementary", { name: "Edit Verify the release journey" });
  await editor.getByLabel("Status").selectOption("in-progress");
  await expect(page.locator('[aria-label="Unassigned: In progress"]')).toContainText("Verify the release journey");
});

test("calendar event cards only wrap titles when they have room for another line", async ({ page }) => {
  await openVault(page);
  await page.getByRole("tab", { name: "Plan" }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("tab", { name: "Week", exact: true }).click();

  const card = page.locator(".planner-timed-item.overlay"),
    title = card.locator(".planner-card-title");
  await expect(card).toBeVisible();
  await expect(card).toHaveText("Design sync");
  await expect(title).toHaveCSS("text-align", "left");
  await expect(card).toHaveCSS("height", "30px");
  await expect(title).toHaveCSS("white-space", "nowrap");
  const bounds = await card.evaluate((element) => {
    const cardBounds = element.getBoundingClientRect(),
      titleBounds = element.querySelector(".planner-card-title")?.getBoundingClientRect();
    return titleBounds
      ? {
          cardLeft: cardBounds.left,
          cardRight: cardBounds.right,
          titleLeft: titleBounds.left,
          titleRight: titleBounds.right,
        }
      : null;
  });
  expect(bounds).not.toBeNull();
  expect(bounds!.titleLeft).toBeGreaterThanOrEqual(bounds!.cardLeft);
  expect(bounds!.titleRight).toBeLessThanOrEqual(bounds!.cardRight);

  await page.setViewportSize({ width: 1280, height: 1200 });
  await expect(card).toHaveClass(/multiline-title/);
  await expect(title).toHaveCSS("white-space", "normal");
});

test("exercise the bundled file viewers and settings surfaces", async ({ page }) => {
  test.setTimeout(60_000);
  await openVault(page);

  await openMockPath(page, "Diagram.canvas");
  await expect(page.getByText("Rectangle", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Shape" }).click();
  await page.getByTitle(/^Rectangle: click to add/).click();
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Layout" }).click();
  await page.getByRole("menuitem", { name: "Left to right" }).click();
  await page.getByTitle("Fit to view").click();

  await openMockPath(page, "Board.canvas");
  await expect(page.getByText("Humans", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");

  await openMockPath(page, "Projects/Data.csv");
  await expect(page.getByText("alpha", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Row" }).click();
  await page.getByRole("button", { name: "Column" }).click();
  await page.getByRole("tab", { name: "Source" }).click();
  await page.getByRole("tab", { name: "Table" }).click();

  await openMockPath(page, "Docs/page.html");
  await expect(page.locator('iframe[title="Docs/page.html"]')).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await page.getByRole("button", { name: /Scripts blocked|Scripts allowed/ }).click();
  await page.getByRole("tab", { name: "Source" }).click();
  await page.getByRole("tab", { name: "Preview" }).click();

  for (const [path, marker] of [
    ["Charts/Sales.vl.json", "Chart"],
    ["Graph.dot", "Graph"],
  ] as const) {
    await openMockPath(page, path);
    await page.getByRole("tab", { name: marker, exact: true }).click();
    await page.waitForTimeout(250);
    await page.getByRole("tab", { name: "Source", exact: true }).click();
  }

  await openMockPath(page, "Attachments/diagram.svg");
  await expect(page.locator(".image-viewer img")).toBeVisible();
  await openMockPath(page, "Docs/sample.pdf");
  await expect(page.getByText("2 pages")).toBeVisible();
  await openMockPath(page, "Projects/notes.txt");
  await expect(page.locator(".cm-content")).toContainText("Plain text file");
  await openMockPath(page, "config.json");
  await expect(page.locator(".cm-content")).toContainText('"mosaic"');

  await page.getByRole("button", { name: "Settings" }).click();
  for (const section of [
    "Appearance",
    "Editor & files",
    "Vault folders",
    "Templates",
    "Calendar & links",
    "Workspace",
    "Shortcuts",
    "About & updates",
    "Connections & safety",
  ]) {
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section }).click();
    await expect(
      page.getByRole("heading", { name: section === "Connections & safety" ? "Connections" : section }).last(),
    ).toBeVisible();
  }
});

test("manage workflows and inspect every AI workspace", async ({ page }) => {
  await openVault(page);
  await page.getByRole("tab", { name: "AI" }).click();

  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await page.locator(".ai-manage summary").click();
  await page.getByRole("button", { name: "Agent library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause automations" }).click();
  await expect(page.getByRole("button", { name: "Resume automations" })).toBeVisible();
  await page.getByRole("button", { name: "Resume automations" }).click();

  const firstWorkflow = page.locator(".workflow-card").first();
  await firstWorkflow.getByRole("button", { name: "Run now" }).click();
  const workspacePane = page.getByRole("region", { name: "Workspace pane" });
  await expect(workspacePane.getByRole("heading", { name: "Run log" })).toBeVisible();
  await expect(workspacePane.locator(".run-transcript strong")).toHaveText("Mock run completed.");
  await expect(workspacePane.getByRole("button", { name: "Read Ideas" })).toBeVisible();
  await workspacePane.getByRole("button", { name: "Open activity and reviews" }).click();
  await expect(page.getByRole("heading", { name: "AI activity" })).toBeVisible();

  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page.getByRole("button", { name: "Create workflow" }).click();
  await expect(page.getByRole("heading", { name: "Create workflow" })).toBeVisible();
  await page.getByLabel("Name").fill("Coverage sweep");
  await page.getByLabel("Instructions").fill("Review the vault and summarize anything that needs attention.");
  await page.getByLabel("Run on a schedule").check();
  await page.getByRole("combobox", { name: /^Schedule/ }).selectOption("every");
  await page.getByRole("spinbutton", { name: "Hours" }).fill("6");
  await page.getByRole("combobox", { name: /^Model/ }).selectOption("sonnet");
  await page.getByLabel("Can use the web").check();
  await page.getByRole("button", { name: "Create workflow" }).click();
  await expect(workspacePane.getByRole("heading", { name: "Coverage sweep" })).toBeVisible();

  await page.getByRole("button", { name: "All runs", exact: true }).click();
  await expect(workspacePane.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(workspacePane.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
});

test("chat with the assistant and manage the saved conversation", async ({ page }) => {
  await openVault(page);
  await page.getByRole("treeitem", { name: "Ideas", exact: true }).click();
  await page.getByRole("tab", { name: "AI" }).click();
  await page.getByRole("button", { name: "+ New chat" }).click();
  await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();

  await page.getByLabel("Chat model").selectOption("haiku");
  await page.getByLabel("Message to Claude").fill("Summarize this note and suggest one improvement.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Done: I added a line to")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTitle("What this chat has cost so far")).toBeVisible();
  await page.getByRole("button", { name: "Read Ideas" }).click();
  await expect(page.locator(".cm-content")).toContainText("Ideas");

  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.locator(".modal input").fill("Coverage conversation");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.getByRole("heading", { name: "Coverage conversation" })).toBeVisible();
  await page.getByRole("button", { name: "All chats", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible();
});

test("import planner tasks and manage an epic lifecycle", async ({ page }) => {
  await openVault(page);
  await page.getByRole("tab", { name: "Plan" }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Preview import" }).click();
  const wizard = page.getByRole("region", { name: "Import Markdown tasks" });
  await expect(wizard.getByRole("heading", { name: "Preview Markdown task import" })).toBeVisible();
  const importButton = wizard.getByRole("button", { name: /^Import \d+ items$/ });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New epic" }).click();
  const epicDialog = page.getByRole("dialog", { name: "New epic" });
  await epicDialog.getByLabel("Title").fill("Coverage epic");
  await epicDialog.getByLabel("Color").fill("#2255aa");
  await epicDialog.getByRole("button", { name: "Save epic" }).click();
  const lane = page.locator(".planner-lane", { hasText: "Coverage epic" });
  await expect(lane).toBeVisible();
  await lane.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("dialog", { name: "Coverage epic history" })).toBeVisible();
  await page.getByRole("button", { name: "Close epic history" }).click();

  await lane.getByRole("button", { name: "Edit" }).click();
  const editEpic = page.getByRole("dialog", { name: "Edit epic" });
  await editEpic.getByLabel("Title").fill("Coverage epic updated");
  await editEpic.getByRole("button", { name: "Save epic" }).click();
  const updatedLane = page.locator(".planner-lane", { hasText: "Coverage epic updated" });
  await updatedLane.getByRole("button", { name: "Archive" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive" }).click();
  await page.getByLabel("Planner lifecycle view").selectOption("archived");
  const archivedLane = page.locator(".planner-lane", { hasText: "Coverage epic updated" });
  await expect(archivedLane.locator("strong", { hasText: "Coverage epic updated" })).toBeVisible();
  await archivedLane.getByRole("button", { name: "Restore" }).click();
  await page.getByLabel("Planner lifecycle view").selectOption("active");
  await expect(page.locator(".planner-lane", { hasText: "Coverage epic updated" }).locator("strong")).toBeVisible();

  await page.getByLabel("Search planner tasks").fill("release");
  await page.getByLabel("Filter by status").selectOption("new");
  await page.getByLabel("Filter by epic").selectOption("__unassigned");
});

test("create calendar events, subscriptions and work sessions", async ({ page }) => {
  await openVault(page);
  await page.getByRole("tab", { name: "Plan" }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  const startEmpty = page.getByRole("button", { name: "Start empty" });
  if (await startEmpty.isVisible()) await startEmpty.click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByPlaceholder("What needs doing?").fill("Calendar coverage task");
  await page.getByRole("button", { name: "OK" }).click();

  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(page.getByText("Design sync", { exact: true })).toBeVisible();
  await page.getByText("Design sync", { exact: true }).click();
  const overlay = page.getByRole("complementary", { name: "Read-only calendar event" });
  await expect(overlay.getByText("Studio 4")).toBeVisible();
  await overlay.getByRole("button", { name: "Copy this occurrence to Mosaic" }).click();

  await page.getByText("Calendars", { exact: true }).click();
  await page.getByLabel("Local events").uncheck();
  await page.getByLabel("Local events").check();
  await page.getByRole("button", { name: "Manage subscriptions…" }).click();
  const sources = page.getByRole("dialog", { name: "Calendar subscriptions" });
  await sources.getByLabel("Name").fill("Coverage calendar");
  await sources.getByLabel("Subscription URL").fill("https://example.com/coverage.ics");
  await sources.getByLabel("Refresh").selectOption("15");
  await sources.getByRole("button", { name: "Add calendar" }).click();
  await expect(sources.getByText("Coverage calendar", { exact: true })).toBeVisible();
  await sources.getByRole("button", { name: "Refresh all" }).click();
  await sources.getByRole("button", { name: "Close calendar subscriptions" }).click();

  await page.getByRole("button", { name: "New event" }).click();
  const eventEditor = page.getByRole("complementary", { name: "New event" });
  await eventEditor.getByLabel("Title").fill("Coverage planning session");
  await eventEditor.getByLabel("Description").fill("Exercise the calendar editor controls.");
  await eventEditor.getByLabel("Repeat").selectOption("daily");
  await eventEditor.getByLabel("Every").fill("2");
  await eventEditor.getByLabel("Location").fill("Studio 5");
  await eventEditor.getByLabel("Participants").fill("qa@example.com, dev@example.com");
  await eventEditor.getByRole("button", { name: "Save" }).click();

  await page.getByRole("tab", { name: "Month", exact: true }).click();
  await expect(page.getByRole("grid")).toBeVisible();
  await page.getByRole("tab", { name: "Day", exact: true }).click();
  await expect(page.locator(".planner-calendar-content.mode-day")).toBeVisible();
  await page.getByRole("tab", { name: "Week", exact: true }).click();

  const showTasks = page.getByRole("button", { name: "Show open tasks" });
  if (await showTasks.isVisible()) await showTasks.click();
  const taskButton = page.getByRole("button", { name: /Calendar coverage task/ });
  await expect(taskButton).toBeVisible();
  await taskButton.click();
  const sessionCard = page.locator(".planner-timed-item.session", { hasText: "Calendar coverage task" }).first();
  await expect(sessionCard).toBeVisible();
  await sessionCard.click();
  const sessionEditor = page.getByRole("complementary", { name: "Edit work session for Calendar coverage task" });
  await sessionEditor.getByLabel("All day").check();
  await sessionEditor.getByRole("button", { name: "Save" }).click();
});

test("release notes wrap inside a narrow settings pane", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openVault(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "About & updates" })
    .click();
  await page.getByRole("button", { name: "Check for updates" }).click();
  const note = page.locator(".release li").first();
  await expect(note).toContainText("release notes");
  await expect(note).toHaveCSS("white-space", "normal");
  const bounds = await note.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    height: el.clientHeight,
    line: Number.parseFloat(getComputedStyle(el).lineHeight),
    pane: el.closest(".settings-scroll")!.getBoundingClientRect().right,
    right: el.getBoundingClientRect().right,
  }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.height).toBeGreaterThan(bounds.line * 1.5);
  expect(bounds.right).toBeLessThanOrEqual(bounds.pane);
  for (const note of await page.locator(".release li").all()) {
    const overflow = await note.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});

test("edit a table with visible row, column and alignment controls", async ({ page }) => {
  await openVault(page);
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke(c: string, a: object): Promise<unknown> } }).__mosaic;
    await m.mockInvoke("create_file", {
      path: "Table editing.md",
      content: "# Table editing\n\n| Name | Qty |\n| --- | --- |\n| Apple | 3 |\n\nAfter table.\n",
      root: null,
    });
  });
  await openMockPath(page, "Table editing.md");
  const table = page.locator(".cm-table-wrap");
  await expect(table.getByRole("group", { name: "Table editing" })).toBeVisible();
  await table.getByRole("button", { name: "Header row options" }).click();
  await page.keyboard.press("Escape");
  await expect(table).toBeVisible();
  const cell = table.locator("td").first();
  await cell.fill("Pear");
  await cell.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await table.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(table.locator("td strong,td b")).toHaveText("Pear");
  await table.getByRole("button", { name: "Row 1 options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insert row below", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").last().locator("td").first()).toBeFocused();
  await expect(table.locator("td strong,td b")).toHaveText("Pear");
  await table.getByRole("button", { name: "Column 1 options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insert column right", exact: true }).click();
  await expect(table.locator("th")).toHaveCount(3);
  await table.getByRole("combobox", { name: "Column alignment" }).selectOption("right");
  await expect(table.locator("tbody tr").last().locator("td").nth(1)).toHaveCSS("text-align", "right");
  await table.locator("tbody tr").last().locator("td").nth(1).fill("pasted");
  await table.getByRole("button", { name: "Column 2 options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete column", exact: true }).click();
  await expect(table.locator("th")).toHaveCount(2);
  await page.locator(".cm-line").last().click();
  await expect.poll(() => readMockFile(page, "Table editing.md")).toContain("**Pear**");
  expect(await readMockFile(page, "Table editing.md")).not.toContain("pasted");
});

test("Focused separates chat history from automation navigation and compacts run metadata", async ({ page }) => {
  await openVault(page);
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  const sidebar = page.getByRole("navigation", { name: "AI views" });
  await expect(sidebar.getByRole("button", { name: "+ New chat" })).toBeVisible();
  await sidebar.getByRole("button", { name: "Automations", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "+ New chat" })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Workflows", exact: true }).click();
  await page.locator(".workflow-card").first().getByRole("button", { name: "Run now" }).click();
  await expect(page.locator(".run-heading .run-status")).toHaveText("Completed");
  await expect(page.locator(".run-meta")).toContainText("Default model");
  const details = page.locator(".run-details").first();
  await expect(details.locator("dl")).not.toBeVisible();
  await details.locator("summary").click();
  await expect(details.locator("dl")).toContainText("Trigger");
  await expect(page.locator(".right-wrap")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "+ New chat" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "All runs" })).toHaveCount(0);
});

test("tables keep rich cells, save while typing, reorder with handles, and offer explicit source mode", async ({
  page,
}) => {
  await openVault(page);
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke(c: string, a: object): Promise<unknown> } }).__mosaic;
    await m.mockInvoke("create_file", {
      path: "Visual table.md",
      content: "# Visual table\n\n| Name | Qty |\n| --- | ---: |\n| **Apple** | 3 |\n| Banana | 7 |\n\nAfter table.\n",
      root: null,
    });
  });
  await openMockPath(page, "Visual table.md");
  const table = page.locator(".cm-table-wrap");
  const first = table.locator("td").first();
  await first.click();
  await expect(first.locator("strong")).toHaveText("Apple");
  await first.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await first.pressSequentially(" pear tree");
  await expect(first).toContainText("Apple pear tree");
  await expect.poll(() => readMockFile(page, "Visual table.md")).toContain("pear tree");
  await expect(first).toBeFocused();
  await table.getByRole("button", { name: "Row 1 options", exact: true }).press("Alt+ArrowDown");
  await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("Banana");
  await table.getByRole("button", { name: "Column 1 options", exact: true }).press("Alt+ArrowRight");
  await expect(table.locator("th").first()).toHaveText("Qty");
  await table.getByRole("button", { name: "Insert row 2", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await page.keyboard.press("Meta+z");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.keyboard.press("Meta+Shift+z");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await table.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".cm-table-wrap")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("| Qty");
  await page.getByRole("button", { name: "Back to table", exact: true }).click();
  await expect(table).toBeVisible();
  await expect(table.locator("td strong,td b")).toContainText("Apple");
});

test("table drag handles move rows and columns, rectangle selection clears cells, and paste stays plain", async ({
  page,
}) => {
  await openVault(page);
  await page.evaluate(async () => {
    const m = (window as unknown as { __mosaic: { mockInvoke(c: string, a: object): Promise<unknown> } }).__mosaic;
    await m.mockInvoke("create_file", {
      path: "Table moves.md",
      content: "# Table moves\n\n| Name | Qty |\n| --- | --- |\n| Apple | 3 |\n| Banana | 7 |\n\nAfter.\n",
      root: null,
    });
  });
  await openMockPath(page, "Table moves.md");
  const table = page.locator(".cm-table-wrap");
  const last = table.locator("tbody tr").last().locator("td").first();
  const rowBounds = await last.boundingBox();
  await table
    .getByRole("button", { name: "Row 1 options", exact: true })
    .dragTo(last, { targetPosition: { x: 12, y: rowBounds!.height - 3 } });
  await expect(table.locator("td").first()).toHaveText("Banana");
  const header = table.locator("th").last();
  const headerBounds = await header.boundingBox();
  await table
    .getByRole("button", { name: "Column 1 options", exact: true })
    .dragTo(header, { targetPosition: { x: headerBounds!.width * 0.75, y: 10 } });
  await expect(table.locator("th").first()).toHaveText("Qty");
  await table.locator("td").first().click();
  await table
    .locator("td")
    .last()
    .click({ modifiers: ["Shift"] });
  await expect(table.locator(".table-selected")).toHaveCount(4);
  await table.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(table.locator("td b,td strong")).toHaveCount(4);
  await page.keyboard.press("Backspace");
  await expect(table.locator("td")).toHaveText(["", "", "", ""]);
  await table.locator("td").first().click();
  await table
    .locator("td")
    .first()
    .evaluate((el) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "x|y\tnew\nnext\tlast");
      clipboard.setData("text/html", '<img src="x" onerror="alert(1)">');
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    });
  await expect(table.locator("td")).toHaveText(["x|y", "new", "next", "last"]);
  await expect(table.locator("img")).toHaveCount(0);
  await expect.poll(() => readMockFile(page, "Table moves.md")).toContain("x\\|y");
});
