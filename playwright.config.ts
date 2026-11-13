import { defineConfig } from "@playwright/test";

const ci = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  workers: 1,
  forbidOnly: ci,
  reporter: ci ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    headless: true,
    launchOptions: {
      // CI installs the browser matching the locked Playwright version.
      // Local runs retain the system Chromium default and explicit override.
      executablePath:
        process.env.CHROMIUM_PATH || (ci ? undefined : "/usr/bin/chromium"),
      args: ["--no-sandbox"],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:3000/health",
    reuseExistingServer: !ci,
  },
});
