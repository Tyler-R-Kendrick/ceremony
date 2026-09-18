import {
  type ElementDestination,
  type PageSnapshot,
  type SnapshotElement,
} from "../core/browser-contracts.js";
import {
  createBoundTargets,
  StaleTargetError,
  type BoundPageLike,
  type JsHandleLike,
} from "./browser-targets.js";
import type { CeremonyPage } from "./browser-driver.js";

export { StaleTargetError } from "./browser-targets.js";

/**
 * The part of a Playwright page this adapter uses. Declaring it structurally
 * keeps `playwright-core` out of the driver's type surface and lets unit tests
 * substitute a recording page while the browser suite passes a real one.
 *
 * `evaluateHandle` is the important addition: it is what lets the adapter hold
 * references to the controls it observed instead of addressing them later
 * through the page's own DOM, which the page is free to rewrite in between.
 */
export interface PlaywrightPageLike extends BoundPageLike {
  url(): string;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" },
  ): Promise<unknown>;
  evaluateHandle(source: string): Promise<JsHandleLike>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
}

/**
 * Bind a live Playwright page to the driver. The adapter exposes navigation,
 * form entry and clicks only: no scripting, downloads, network interception or
 * markup extraction is reachable through it.
 *
 * Every action is revalidated against the observation that authorized it. A
 * navigation, a re-render, a moved control, a disabled control or a changed
 * form destination between the snapshot and the action ends the step with a
 * named refusal rather than filling whatever is in the page now — which is the
 * whole difference between approving an element and approving a position.
 */
export function createPlaywrightCeremonyPage(
  page: PlaywrightPageLike,
  options: { settleTimeoutMs?: number } = {},
): CeremonyPage {
  const settleTimeout = options.settleTimeoutMs ?? 5_000;
  const targets = createBoundTargets(page);
  return {
    url: async () => page.url(),
    goto: async (target) => {
      await targets.release();
      await page.goto(target, { waitUntil: "domcontentloaded" });
    },
    snapshot: async (): Promise<PageSnapshot> => targets.observe(),
    fill: async (element, value) => {
      await targets.act(element, async (handle) => {
        if (element.kind === "select") await handle.selectOption(value);
        else await handle.fill(value);
      });
    },
    check: async (element) => {
      await targets.act(element, (handle) => handle.check());
    },
    click: async (element) => {
      await targets.act(element, (handle) => handle.click());
    },
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

/**
 * Where a control's form would deliver, as approved at observation time.
 *
 * Exposed so a caller with its own origin policy — the driver's rule that a
 * secret may only reach an allowed origin — can consult the destination the
 * adapter actually validated rather than re-deriving it from a snapshot field.
 */
export function approvedDestination(
  bound: ReturnType<typeof createBoundTargets>,
  element: SnapshotElement,
): ElementDestination | undefined {
  return bound.destinationFor(element);
}

/** Whether a thrown value is this adapter refusing, rather than a real fault. */
export function isStaleTarget(error: unknown): error is StaleTargetError {
  return error instanceof StaleTargetError;
}
