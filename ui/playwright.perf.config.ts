import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "perf",
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    baseURL: "http://localhost:1442",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --port 1442 --strictPort",
    url: "http://localhost:1442",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
