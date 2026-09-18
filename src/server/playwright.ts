import { createRequire } from "node:module";

// Playwright needs its package layout and runtime assets, not a flattened bundle.
const playwright: typeof import("playwright-core") = createRequire(
  import.meta.url,
)("playwright-core");

/**
 * All three engines, not only Chromium.
 *
 * Exporting Firefox and WebKit here is what lets a backend be built on a real
 * engine rather than on Chromium wearing a different label. It is not a claim
 * that the three are interchangeable: Chromium-only mechanisms (CDP sessions,
 * `Fetch` interception, native target inspection) have no equivalent in the
 * other two, so a backend that depends on one of those declares the dependency
 * as a capability instead of silently losing the protection.
 *
 * `webkit` is Playwright's WebKit build. It is not the person's installed
 * Safari, has no access to iCloud Keychain, and never claims otherwise.
 */
export const { chromium, firefox, webkit } = playwright;

export type PlaywrightBrowserType = typeof chromium;
