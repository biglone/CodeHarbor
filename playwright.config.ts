import fs from "node:fs";

import { defineConfig, devices } from "@playwright/test";

const SYSTEM_CHROME_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((value): value is string => Boolean(value && value.trim()));

function resolveUseSystemChrome(): boolean {
  const explicit = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME?.trim().toLowerCase();
  if (explicit === "true") {
    return true;
  }
  if (explicit === "false") {
    return false;
  }
  return SYSTEM_CHROME_CANDIDATES.some((candidate) => fs.existsSync(candidate));
}

const useSystemChrome = resolveUseSystemChrome();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: [["list"]],
  use: {
    headless: true,
    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(useSystemChrome ? { channel: "chrome" as const } : {}),
      },
    },
  ],
});
