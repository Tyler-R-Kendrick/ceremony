import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  projects: [
    {
      name: "chromium",
      testIgnore: ["**/webmcp.spec.ts"],
      use: { browserName: "chromium" },
    },
    {
      name: "native-webmcp",
      testMatch: ["**/webmcp.spec.ts"],
      use: { browserName: "chromium" },
    },
    {
      name: "firefox",
      testMatch: ["**/teaching-*.spec.ts"],
      use: { browserName: "firefox" },
    },
    {
      name: "webkit",
      testMatch: ["**/teaching-*.spec.ts"],
      use: {
        browserName: "webkit",
        ...(process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH
          ? {
              launchOptions: {
                executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH,
              },
            }
          : {}),
      },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    // Auth failures must not create attachments containing collector or provider traffic.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4173/api/config",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
