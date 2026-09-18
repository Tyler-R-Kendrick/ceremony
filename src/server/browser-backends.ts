import {
  browserEngineSchema,
  mintReference,
  unmetCapabilities,
  type BackendDescriptor,
  type BrowserCapabilities,
  type BrowserEngine,
  type RequiredCapabilities,
} from "../core/browser-session-contracts.js";
import { chromium, firefox, webkit } from "./playwright.js";
import type { ContextRequestLike } from "./browser-verification.js";
import { createPlaywrightCeremonyPage } from "./browser-page.js";
import type { CeremonyPage } from "./browser-driver.js";

/**
 * Managed browser backends, one per real engine.
 *
 * "Managed" means this process launched the browser and may dispose it. That is
 * a different thing from the person's own browser, which is reached through an
 * installed companion and is never closed by Ceremony; the two are kept in
 * separate backends precisely so a caller cannot ask for one and quietly get
 * the other.
 *
 * Each engine declares what it can actually enforce. Chromium can intercept
 * document requests through CDP; Firefox and WebKit have no equivalent in this
 * driver, so they declare `strongEgressContainment: false` and a plan that
 * demands containment refuses them rather than running with a weaker guarantee
 * under the same name.
 */

/** The Playwright surface a backend needs. Structural, to keep types portable. */
interface BrowserTypeLike {
  name(): string;
  launch(options?: {
    args?: string[];
    proxy?: { server: string; bypass?: string };
  }): Promise<BrowserLike>;
}

interface BrowserLike {
  version(): string;
  newContext(options?: {
    serviceWorkers?: "allow" | "block";
    proxy?: { server: string; bypass?: string };
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  pages(): PageLike[];
  close(): Promise<void>;
  cookies(): Promise<unknown[]>;
  /**
   * Requests issued with this context's own cookies. This is what a session
   * verifier uses: a request from the server process would only prove the
   * server can reach the provider, which is a different question from whether
   * *this browser* holds a session.
   */
  request: ContextRequestLike;
}

interface PageLike {
  url(): string;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" },
  ): Promise<unknown>;
  evaluateHandle(source: string): Promise<never>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

const engineTypes: Record<BrowserEngine, () => BrowserTypeLike> = {
  chromium: () => chromium as unknown as BrowserTypeLike,
  firefox: () => firefox as unknown as BrowserTypeLike,
  webkit: () => webkit as unknown as BrowserTypeLike,
};

/**
 * What each engine can do *in this driver*.
 *
 * These are not aspirations and not upstream feature lists. `documentBinding`
 * and `backendHeldElements` are true on all three because the page adapter
 * holds element and document references itself, which works identically
 * everywhere. `strongEgressContainment` and `debugExposure` are false because
 * the mechanisms behind them are not here; declaring them true would be the
 * exact false claim this table exists to prevent.
 *
 * That standard is the one this table failed. `popupBinding`, `frameBinding`
 * and `statePersistence` were each declared true on all three engines with no
 * implementation behind any of them, which is the same defect as a wizard
 * showing settings the server never compiled — a value that reads as effective
 * and is not. A flag here turns true when something enforces it and a test on
 * a real browser says so, and not before.
 */
const engineCapabilities: Record<BrowserEngine, BrowserCapabilities> = {
  chromium: {
    retainedSession: true,
    backendHeldElements: true,
    documentBinding: true,
    // False on every engine, and this is a correction rather than a
    // limitation newly discovered. Nothing in this driver binds a popup to
    // its opener or acts inside a frame: `createBoundTargets` observes through
    // `page.evaluateHandle`, which is the main frame and nothing else, and the
    // word "popup" appeared nowhere in `src/` except in these declarations.
    // They were read as intentions. `unmetCapabilities` believes this table, so
    // a plan that asked for either was admitted and then run without it — which
    // is worse than refusing, because the caller was told yes.
    popupBinding: false,
    frameBinding: false,
    // Chromium's `Fetch` interception in this repository covers Document
    // requests. That is real navigation control, not total resource
    // containment, so the stronger claim stays false until something actually
    // enforces it at the network boundary.
    strongEgressContainment: false,
    authenticatorHandoff: true,
    // Same correction. `ManagedContext` has no `storageState`, and no path in
    // `src/` serializes or restores one. The evidence matrix called this
    // "declared, not exercised"; it was not implemented at all.
    statePersistence: false,
    // A CDP endpoint reachable by the holder of control is debug exposure. The
    // managed backend does not hand one out, so this is false here and true
    // only for the attached/remote-debugging backends that genuinely do.
    debugExposure: false,
  },
  firefox: {
    retainedSession: true,
    backendHeldElements: true,
    documentBinding: true,
    popupBinding: false,
    frameBinding: false,
    strongEgressContainment: false,
    // Firefox surfaces a WebAuthn request to the page the same way, and the
    // driver detects the request rather than answering it.
    authenticatorHandoff: true,
    statePersistence: false,
    debugExposure: false,
  },
  webkit: {
    retainedSession: true,
    backendHeldElements: true,
    documentBinding: true,
    popupBinding: false,
    frameBinding: false,
    strongEgressContainment: false,
    authenticatorHandoff: true,
    statePersistence: false,
    debugExposure: false,
  },
};

export class UnsupportedBackend extends Error {
  constructor(
    readonly backendId: string,
    readonly unmet: readonly (keyof BrowserCapabilities)[],
  ) {
    super(`Backend ${backendId} cannot provide: ${unmet.join(", ")}`);
    this.name = "UnsupportedBackend";
  }
}

/**
 * A launched managed browser, plus the identity a retained session is fenced
 * against.
 *
 * `browserGeneration` is minted per launch. A reconnect that finds a different
 * generation is looking at a different browser, whatever the database says, and
 * the session is reported lost rather than silently re-adopted.
 */
export type ManagedBrowser = {
  descriptor: BackendDescriptor;
  browserGeneration: string;
  /** Open an isolated context. Cookies are shared inside one, never across. */
  openContext(): Promise<ManagedContext>;
  /** True while the underlying process is still there. */
  alive(): boolean;
  /** Dispose everything this backend owns. Never touches a user's browser. */
  dispose(): Promise<void>;
};

export type ManagedContext = {
  contextRef: string;
  /** Issues requests inside this context, carrying its cookies. */
  request: ContextRequestLike;
  /** A driver-facing page bound to this context. */
  openPage(): Promise<{ targetRef: string; page: CeremonyPage; raw: PageLike }>;
  /** Whether the context still holds any cookie at all, for liveness checks. */
  alive(): Promise<boolean>;
  close(): Promise<void>;
};

export type BackendOptions = {
  /** An egress proxy, when the host configured one. */
  proxy?: { server: string; bypass?: string } | undefined;
  /** Extra launch arguments. Chromium-only; ignored elsewhere. */
  args?: readonly string[] | undefined;
};

/** Describe a managed backend without launching it. */
export function describeManagedBackend(
  engine: BrowserEngine,
  engineVersion = "unknown",
): BackendDescriptor {
  return {
    backendId: `managed-${engine}`,
    engine,
    ownership: "managed",
    engineVersion,
    capabilities: engineCapabilities[engine],
  };
}

/** Every managed backend this build can offer, for capability negotiation. */
export function managedBackends(): readonly BackendDescriptor[] {
  return browserEngineSchema.options.map((engine) =>
    describeManagedBackend(engine),
  );
}

/**
 * Launch a managed browser on a real engine.
 *
 * Required capabilities are checked *before* anything launches and long before
 * a credential could be released, so an impossible plan fails as a plan rather
 * than halfway through a login.
 */
export async function launchManagedBrowser(
  engine: BrowserEngine,
  required: RequiredCapabilities = {},
  options: BackendOptions = {},
): Promise<ManagedBrowser> {
  const descriptor = describeManagedBackend(engine);
  const unmet = unmetCapabilities(descriptor, required);
  if (unmet.length > 0)
    throw new UnsupportedBackend(descriptor.backendId, unmet);

  const type = engineTypes[engine]();
  const browser = await type.launch({
    ...(options.args && engine === "chromium"
      ? { args: [...options.args] }
      : {}),
    ...(options.proxy ? { proxy: options.proxy } : {}),
  });
  const browserGeneration = mintReference("bgen");
  const launched: BackendDescriptor = {
    ...descriptor,
    engineVersion: browser.version(),
  };
  const contexts = new Set<BrowserContextLike>();

  return {
    descriptor: launched,
    browserGeneration,
    alive: () => browser.isConnected(),
    async openContext(): Promise<ManagedContext> {
      const context = await browser.newContext({
        // Auth pages may register workers that outlive the attempt and keep
        // acting after control is released. Blocking them keeps the context's
        // lifetime the same as the session's.
        serviceWorkers: "block",
        ...(options.proxy ? { proxy: options.proxy } : {}),
      });
      contexts.add(context);
      const contextRef = mintReference("bctx");
      return {
        contextRef,
        request: context.request,
        async openPage() {
          const raw = await context.newPage();
          return {
            targetRef: mintReference("btgt"),
            page: createPlaywrightCeremonyPage(
              raw as unknown as Parameters<
                typeof createPlaywrightCeremonyPage
              >[0],
            ),
            raw,
          };
        },
        async alive() {
          try {
            await context.cookies();
            return true;
          } catch {
            return false;
          }
        },
        async close() {
          contexts.delete(context);
          await context.close().catch(() => {});
        },
      };
    },
    async dispose() {
      // Only what this backend created. Disposing a managed browser must never
      // reach a context another owner is still using, and can never reach a
      // browser the person started themselves — there isn't one here.
      for (const context of contexts) await context.close().catch(() => {});
      contexts.clear();
      await browser.close().catch(() => {});
    },
  };
}
