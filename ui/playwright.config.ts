import { defineConfig } from "@playwright/test";

// UI flows against the dev server with its in-memory mock vault (no Tauri, no disk). Uses the
// installed Google Chrome, so no browser download is needed here or on GitHub's macOS runners.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:1440", channel: "chrome", headless: true },
  webServer: {
    command: "pnpm exec vite --port 1440 --strictPort",
    url: "http://localhost:1440",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
