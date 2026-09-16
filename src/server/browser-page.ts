import {
  snapshotPageSource,
  type PageSnapshot,
  type SnapshotElement,
} from "../core/browser-contracts.js";
import type { CeremonyPage } from "./browser-driver.js";

/**
 * The part of a Playwright page this adapter uses. Declaring it structurally
 * keeps `playwright-core` out of the driver's type surface and lets unit tests
 * substitute a recording page while the browser suite passes a real one.
 */
export interface PlaywrightPageLike {
  url(): string;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" },
  ): Promise<unknown>;
  evaluate(source: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<unknown>;
  check(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
}

const indexAttribute = "data-ceremony-index";

function selectorFor(element: SnapshotElement): string {
  return `[${indexAttribute}="${element.index}"]`;
}

/**
 * Bind a live Playwright page to the driver. The adapter exposes navigation,
 * form entry and clicks only: no scripting, downloads, network interception or
 * markup extraction is reachable through it.
 */
export function createPlaywrightCeremonyPage(
  page: PlaywrightPageLike,
  options: { settleTimeoutMs?: number } = {},
): CeremonyPage {
  const settleTimeout = options.settleTimeoutMs ?? 5_000;
  return {
    url: async () => page.url(),
    goto: async (target) => {
      await page.goto(target, { waitUntil: "domcontentloaded" });
    },
    snapshot: async () =>
      (await page.evaluate(snapshotPageSource(indexAttribute))) as PageSnapshot,
    fill: async (element, value) => {
      if (element.kind === "select")
        await page.selectOption(selectorFor(element), value);
      else await page.fill(selectorFor(element), value);
    },
    check: async (element) => page.check(selectorFor(element)),
    click: async (element) => page.click(selectorFor(element)),
    settle: async () => {
      try {
        await page.waitForLoadState("networkidle", { timeout: settleTimeout });
      } catch {
        // A page that keeps a connection open is not a failed step; the
        // driver's own stall detection decides whether progress stopped.
      }
    },
  };
}
