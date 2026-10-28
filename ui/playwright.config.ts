import { defineConfig, devices } from "@playwright/test";

// UI flows against the dev server with its in-memory mock vault (no Tauri, no disk). Chrome uses
// the runner's installed browser; CI installs Playwright WebKit to approximate Mosaic's WKWebView.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:1440",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    // Mosaic uses WKWebView on macOS. Playwright WebKit is not identical, but catches the same
    // class of Safari/WebKit compatibility and layout mistakes much earlier than Chrome alone.
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "pnpm exec vite --port 1440 --strictPort",
    url: "http://localhost:1440",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
