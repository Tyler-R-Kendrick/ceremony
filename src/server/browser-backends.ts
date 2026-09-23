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
    /** Cookies and origin storage to start from, when restoring a session. */
    storageState?: unknown;
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  pages(): PageLike[];
  close(): Promise<void>;
  cookies(): Promise<unknown[]>;
  /** Everything this context would need to be recreated elsewhere. */
  storageState(): Promise<unknown>;
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
 * and is not. All three were corrected to false.
 *
 * All three have since gone back to true, each by the only route a flag here
 * may take: something enforces it, and a case on a real browser of every
 * engine says so. `ManagedContext.saveState()` and
 * `openContext({ storageState })` implement `statePersistence`, and
 * LIFE-STATE asks the provider - not this process - whether the restored
 * context is recognised. `createPlaywrightCeremonyPage` resolves a declared
 * frame on every read and action for `frameBinding`, and adopts a window the
 * page opens under the rule described at `popupBinding`; TARGET-FRAME and
 * TARGET-POPUP drive each against the provider's own record.
 */
const engineCapabilities: Record<BrowserEngine, BrowserCapabilities> = {
  chromium: {
    retainedSession: true,
    backendHeldElements: true,
    documentBinding: true,
    // True by the only route this table allows: something enforces it.
    //
    // Popups needed a rule frames did not. A frame is there to be found -
    // resolve it on every read, refuse when absent - but a window is not
    // there until the page opens it, so "always act in the declared window"
    // would refuse the attempt before it pressed the button that opens one.
    // `createPlaywrightCeremonyPage` therefore acts in the page until a
    // window at an origin the plan admits exists, then in that, and in the
    // page again once it closes; only a window the page itself opened is a
    // candidate, one at an undeclared origin ends the attempt unread, and
    // two at admitted origins identify no document. Every clause is checked
    // on every read and every action, exactly as the frame rule is.
    //
    // TARGET-POPUP drives it on this engine: a page whose only control opens
    // the provider's form in a window, a credential typed there, the window
    // reporting back and closing, and the provider's own record naming the
    // window's form as the one that received it. Its second case opens the
    // window somewhere undeclared and asserts the partner's silence.
    //
    // `browser-executor.ts` still aborts a popup and closes the context. That
    // is a different subsystem - it serves authored connectors and never
    // reads this table - and its protection stays as it is.
    popupBinding: true,
    // True now, and true by the only route this table allows: something
    // enforces it. `createPlaywrightCeremonyPage` resolves the declared
    // frame on every read and every action, so the origin is rechecked at
    // both, and refuses rather than falling back to the page when no frame
    // answers or more than one does. TARGET-FRAME drives a credential form
    // served by a second origin inside an iframe, on this engine, and the
    // partner server's own record is what says the login happened.
    frameBinding: true,
    // Chromium's `Fetch` interception in this repository covers Document
    // requests. That is real navigation control, not total resource
    // containment, so the stronger claim stays false until something actually
    // enforces it at the network boundary.
    strongEgressContainment: false,
    authenticatorHandoff: true,
    // True, and true because something enforces it rather than because the
    // table says so. `ManagedContext.saveState()` exports the context's
    // storage state and `openContext({ storageState })` starts one from a
    // saved export; LIFE-STATE drives the round trip on every engine and asks
    // the *provider* whether it recognises the restored context, which is the
    // only answer that counts. LIFE-STATE-SUBJECT covers the half that makes
    // it safe to have: a saved state is a bearer credential, so another
    // subject holding the reference is refused rather than admitted.
    statePersistence: true,
    // A CDP endpoint reachable by the holder of control is debug exposure. The
    // managed backend does not hand one out, so this is false here and true
    // only for the attached/remote-debugging backends that genuinely do.
    debugExposure: false,
  },
  firefox: {
    retainedSession: true,
    backendHeldElements: true,
    documentBinding: true,
    popupBinding: true,
    frameBinding: true,
    strongEgressContainment: false,
    // Firefox surfaces a WebAuthn request to the page the same way, and the
    // driver detects the request rather than answering it.
    authenticatorHandoff: true,
    statePersistence: true,
    debugExposure: false,
  },
  webkit: {
    retainedSession: true,
    backendHeldElements: true,
    documentBinding: true,
    popupBinding: true,
    frameBinding: true,
    strongEgressContainment: false,
    authenticatorHandoff: true,
    statePersistence: true,
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
  openContext(options?: OpenContextOptions): Promise<ManagedContext>;
  /** True while the underlying process is still there. */
  alive(): boolean;
  /** Dispose everything this backend owns. Never touches a user's browser. */
  dispose(): Promise<void>;
};

export type ManagedContext = {
  contextRef: string;
  /** Issues requests inside this context, carrying its cookies. */
  request: ContextRequestLike;
  /**
   * A driver-facing page bound to this context.
   *
   * `frameOrigins` comes from the effective plan and names the origins whose
   * frame this login happens inside. It has to arrive here because the
   * adapter is built here: nothing further down knows what the plan said, and
   * a frame chosen anywhere else would be chosen without it.
   *
   * `popupOrigins` is the same statement about windows the page opens: where
   * one may be where this login continues. Absent, a window the page opens is
   * not the attempt's concern and the page stays the target.
   */
  openPage(options?: {
    frameOrigins?: readonly string[];
    popupOrigins?: readonly string[];
  }): Promise<{ targetRef: string; page: CeremonyPage; raw: PageLike }>;
  /** Whether the context still holds any cookie at all, for liveness checks. */
  alive(): Promise<boolean>;
  /**
   * Export what this context holds, so a later one can hold the same.
   *
   * The caller is expected to be `browser-state.ts` and nothing else. What
   * comes back is a live session in serialized form, not a description of
   * one, so it goes straight into the encrypted store and is never returned
   * to anybody across a tool boundary.
   */
  saveState(): Promise<unknown>;
  close(): Promise<void>;
};

export type OpenContextOptions = {
  /**
   * Restore a saved session into the new context.
   *
   * A thunk rather than a value, so the bytes materialise at the one moment
   * they are needed and have no reason to sit in a variable anywhere else.
   */
  storageState?: () => Promise<unknown>;
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
    async openContext(open: OpenContextOptions = {}): Promise<ManagedContext> {
      // Resolved here and nowhere else: the thunk is called once, its result
      // goes straight into `newContext`, and no name outside this expression
      // ever holds it.
      const restored = open.storageState
        ? await open.storageState()
        : undefined;
      const context = await browser.newContext({
        // Auth pages may register workers that outlive the attempt and keep
        // acting after control is released. Blocking them keeps the context's
        // lifetime the same as the session's.
        serviceWorkers: "block",
        ...(options.proxy ? { proxy: options.proxy } : {}),
        ...(restored !== undefined ? { storageState: restored } : {}),
      });
      contexts.add(context);
      const contextRef = mintReference("bctx");
      return {
        contextRef,
        request: context.request,
        async openPage(
          open: {
            frameOrigins?: readonly string[];
            popupOrigins?: readonly string[];
          } = {},
        ) {
          const raw = await context.newPage();
          return {
            targetRef: mintReference("btgt"),
            page: createPlaywrightCeremonyPage(
              raw as unknown as Parameters<
                typeof createPlaywrightCeremonyPage
              >[0],
              {
                ...(open.frameOrigins && open.frameOrigins.length > 0
                  ? { frameOrigins: open.frameOrigins }
                  : {}),
                ...(open.popupOrigins && open.popupOrigins.length > 0
                  ? { popupOrigins: open.popupOrigins }
                  : {}),
              },
            ),
            raw,
          };
        },
        async saveState() {
          return context.storageState();
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
