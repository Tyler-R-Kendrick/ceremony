import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { BrowserContext, Locator, Page } from "@playwright/test";

export const test = base.extend<{ privateFailureContext: void }>({
  privateFailureContext: [
    async ({}, use, testInfo) => {
      await use();
      // Matcher snapshots bypass PLAYWRIGHT_NO_COPY_PROMPT. Remove only this
      // diagnostic metadata before Playwright writes error-context attachments;
      // assertions, status, source locations and failure messages stay intact.
      for (const error of testInfo.errors) delete error.errorContext;
    },
    { auto: true },
  ],
});
