import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openMockVault } from "../e2e/mock-vault";

test("report browser mock edit, burst and vault activation latency", async ({ page, browser }) => {
  const sourceIdentity = () =>
    JSON.parse(execFileSync(process.execPath, ["../scripts/performance/report.mjs", "source"], { encoding: "utf8" }));
  const source = sourceIdentity();
  const samples: { name: string; unit: string; value: number }[] = [];
  await page.clock.setFixedTime(new Date("2026-11-04T12:00:00Z"));
  await page.goto("/");
  await openMockVault(page);
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: { mockInvoke(c: string, a: object): Promise<unknown>; external(paths: string[]): void };
      }
    ).__mosaic;
    for (let i = 0; i < 1000; i++) {
      await m.mockInvoke("create_file", { path: `Perf/Note ${i}.md`, content: `# Note ${i}\n\nFixture text ${i}.` });
    }
    m.external(["Perf"]);
  });
  await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __mosaic: { useWorkspace: { getState(): { open(p: string): Promise<void> } } };
      }
    ).__mosaic;
    await m.useWorkspace.getState().open("Perf/Note 0.md");
  });
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("Fixture text 0");
  for (let repetition = 0; repetition < 5; repetition++) {
    let start = performance.now();
    await page.evaluate(async (repetition) => {
      const m = (
        window as unknown as {
          __mosaic: { mockInvoke(c: string, a: object): Promise<unknown>; external(paths: string[]): void };
        }
      ).__mosaic;
      await m.mockInvoke("write_file", {
        path: "Perf/Note 0.md",
        content: `# Note 0\n\nExternal sample ${repetition}`,
        expectedHash: null,
        root: null,
      });
      m.external(["Perf/Note 0.md"]);
    }, repetition);
    await expect(editor).toContainText(`External sample ${repetition}`);
    samples.push({ name: "browser.mock_external_edit_to_screen_1000", unit: "ms", value: performance.now() - start });
    start = performance.now();
    await page.evaluate(async (repetition) => {
      const m = (
        window as unknown as {
          __mosaic: { mockInvoke(c: string, a: object): Promise<unknown>; external(paths: string[]): void };
        }
      ).__mosaic;
      const paths = [];
      for (let i = 0; i < 50; i++) {
        const file = `Perf/Note ${i}.md`;
        await m.mockInvoke("write_file", {
          path: file,
          content: `# Note ${i}\n\nBurst sample ${repetition}`,
          expectedHash: null,
          root: null,
        });
        paths.push(file);
      }
      m.external(paths);
    }, repetition);
    await expect(editor).toContainText(`Burst sample ${repetition}`);
    samples.push({ name: "browser.mock_burst_50_to_screen_1000", unit: "ms", value: performance.now() - start });
    start = performance.now();
    await page.evaluate(async (repetition) => {
      const m = (
        window as unknown as {
          __mosaic: {
            useVault: {
              getState(): {
                openVault(p: string): Promise<void>;
                vault: { root: string } | null;
                entries: { path: string; is_dir: boolean }[];
              };
            };
          };
        }
      ).__mosaic;
      const root = `/mock/perf-${repetition}`;
      await m.useVault.getState().openVault(root);
      if (m.useVault.getState().vault?.root !== root) throw new Error("Vault switch did not commit");
      if (m.useVault.getState().entries.filter((e) => e.path.startsWith("Perf/") && !e.is_dir).length !== 1000)
        throw new Error("Fixture lost notes during switch");
    }, repetition);
    await expect(page.getByRole("treeitem", { name: /^Welcome/ })).toBeVisible();
    samples.push({ name: "browser.mock_vault_switch_1000", unit: "ms", value: performance.now() - start });
    await page.evaluate(async () => {
      const m = (
        window as unknown as {
          __mosaic: { useWorkspace: { getState(): { open(p: string): Promise<void> } } };
        }
      ).__mosaic;
      await m.useWorkspace.getState().open("Perf/Note 0.md");
    });
    await expect(editor).toContainText(`Burst sample ${repetition}`);
  }
  const output = path.resolve(process.env.MOSAIC_PERF_OUTPUT || "../target/performance");
  fs.mkdirSync(output, { recursive: true });
  expect(sourceIdentity()).toEqual(source);
  fs.writeFileSync(
    path.join(output, "browser.json"),
    JSON.stringify({ source, version: browser.version(), samples }, null, 2),
  );
});
