import type { Browser, Page } from "playwright-core";
import { z } from "zod";
import { chromium } from "./playwright.js";

/**
 * A remote browser a person can be handed, whichever provider runs it.
 *
 * Human takeover used to be one fixed scenario: Cloudflare Browser Run, for a
 * GitHub registration. Nothing in it was specific to GitHub except the paths
 * it navigated and the words it showed; nothing in it was specific to
 * Cloudflare except how a takeover URL is minted. This module is the second
 * half made general: every provider that can show a person a live view of a
 * tab answers the same question - "give me a takeover URL for this page" - and
 * the ceremony around it (who may resolve the URL, how long it lives, what
 * finishing it proves) no longer changes with the provider.
 *
 * Three providers answer it:
 *
 * - **Cloudflare Browser Run** - its vendor CDP method `Cloudflare.getLiveView`,
 *   plus `Cloudflare.handoff` for its own "hand to a person" banner.
 * - **Browserbase** - its session debug endpoint, which returns a live-view
 *   URL per page.
 * - **Any CDP endpoint** whose operator also runs a live view (Steel,
 *   browserless, a self-hosted viewer) - from an operator-supplied template
 *   such as `https://viewer.example/live/{targetId}`, filled with the tab's
 *   CDP target id.
 *
 * A takeover URL is a bearer credential for the whole tab, so the rules are
 * the same for all three and are enforced here, once: it must be `https:`
 * with no userinfo, it is minted only by host code for a page this process
 * opened, and it never becomes part of a result, an event or a model-visible
 * value - callers keep it encrypted and hand it out only from an
 * authenticated human route.
 */
export type LiveViewSource =
  | { kind: "cloudflare"; accountId: string; apiToken: string }
  | { kind: "browserbase"; apiKey: string; projectId: string }
  | {
      kind: "cdp";
      endpoint: string;
      headers?: Record<string, string>;
      /**
       * Where a person watches and drives a tab, with `{targetId}` standing
       * for the tab's CDP target id. Operator configuration only.
       */
      liveViewUrlTemplate: string;
    };

/** A remote browser opened for a person to take over. */
export interface LiveBrowser {
  browser: Browser;
  /** A takeover URL for one tab. Always `https:`. */
  liveView(page: Page, options?: { expiresInMs?: number }): Promise<string>;
  /**
   * The provider's own "a person has this now" signal, where it has one.
   * `onReturned` fires when the provider says the person handed it back,
   * which is not evidence that anything was authorized.
   */
  handoff?(
    page: Page,
    input: { instructions: string; timeoutMs: number; onReturned(): void },
  ): Promise<void>;
  close(): Promise<void>;
}

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Whether a CDP endpoint may be dialled at all.
 *
 * Encrypted anywhere; plaintext only on this machine. A `ws://` endpoint on a
 * network would send the browser's control channel — and any header that
 * authenticates it — in the clear. Credentials belong in `headers` rather than
 * in the URL's userinfo, where they end up in every log line that prints it.
 */
export function remoteCdpEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "wss:" || url.protocol === "https:") return true;
  return (
    (url.protocol === "ws:" || url.protocol === "http:") &&
    loopbackHosts.has(url.hostname)
  );
}

/**
 * The one check every takeover URL passes, wherever it came from: encrypted
 * transport, no credentials in the URL, and nothing that is not a URL.
 */
export function safeLiveViewUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Unsafe live view URL");
  return url.href;
}

/**
 * Whether an operator's live-view template is usable: an `https:` URL once
 * filled, with no userinfo. `{targetId}` is optional - a viewer that shows the
 * whole browser needs no tab - but when present it is the only placeholder.
 */
export function liveViewTemplateAllowed(template: string): boolean {
  if (/\{(?!targetId\})[^}]*\}/.test(template)) return false;
  try {
    safeLiveViewUrl(template.replaceAll("{targetId}", "target"));
    return true;
  } catch {
    return false;
  }
}

/** The CDP target id of a tab, which every provider's live view is keyed by. */
async function targetIdOf(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

/**
 * The live-view half of a provider, for a browser something else opened.
 * The executor opens its own remote browsers (behind its egress proxy); this
 * is how it asks the same question of them.
 */
export type LiveViewMinter = (
  page: Page,
  options?: { expiresInMs?: number },
) => Promise<string>;

export function cloudflareLiveView(): LiveViewMinter {
  return async (page, options) => {
    const cdp = await page.context().newCDPSession(page);
    // Playwright's upstream type map does not include Cloudflare's vendor domain.
    const live = z
      .object({ devtoolsFrontendUrl: z.url() })
      .parse(
        await Reflect.apply(cdp.send, cdp, [
          "Cloudflare.getLiveView",
          { mode: "tab", expiresInMs: options?.expiresInMs ?? 300_000 },
        ]),
      );
    return safeLiveViewUrl(live.devtoolsFrontendUrl);
  };
}

export function browserbaseLiveView(input: {
  apiKey: string;
  sessionId: string;
  fetch?: typeof fetch;
}): LiveViewMinter {
  return async (page) => {
    const response = await (input.fetch ?? fetch)(
      `https://api.browserbase.com/v1/sessions/${encodeURIComponent(input.sessionId)}/debug`,
      {
        headers: { "x-bb-api-key": input.apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error("Live view unavailable");
    const debug = z
      .object({
        debuggerFullscreenUrl: z.url(),
        pages: z
          .array(z.object({ id: z.string(), debuggerFullscreenUrl: z.url() }))
          .optional(),
      })
      .parse(await response.json());
    // Browserbase names each page by its CDP target id; the tab the person
    // is meant to act in is preferred over the whole-browser view.
    const targetId = await targetIdOf(page).catch(() => undefined);
    const tab = debug.pages?.find((entry) => entry.id === targetId);
    return safeLiveViewUrl(
      tab?.debuggerFullscreenUrl ?? debug.debuggerFullscreenUrl,
    );
  };
}

export function templateLiveView(template: string): LiveViewMinter {
  if (!liveViewTemplateAllowed(template))
    throw new Error("Invalid live view URL template");
  return async (page) =>
    safeLiveViewUrl(
      template.replaceAll(
        "{targetId}",
        encodeURIComponent(await targetIdOf(page)),
      ),
    );
}

/**
 * Open a remote browser a person can take over. Used where the human
 * takeover itself is the point (`RemoteHumanBrowser`); the authorization
 * executor opens its remote browsers itself and attaches a minter instead.
 */
export async function openLiveBrowser(
  source: LiveViewSource,
  options: { fetch?: typeof fetch } = {},
): Promise<LiveBrowser> {
  if (source.kind === "cloudflare") {
    const browser = await chromium.connectOverCDP(
      `wss://api.cloudflare.com/client/v4/accounts/${source.accountId}/browser-run/devtools/browser?keep_alive=600000`,
      {
        headers: { Authorization: `Bearer ${source.apiToken}` },
        timeout: 20_000,
      },
    );
    return {
      browser,
      liveView: cloudflareLiveView(),
      async handoff(page, input) {
        const cdp = await page.context().newCDPSession(page);
        // Vendor event is deliberately not interpreted as successful authentication.
        Reflect.apply(cdp.once, cdp, [
          "Cloudflare.handoffComplete",
          () => input.onReturned(),
        ]);
        await Reflect.apply(cdp.send, cdp, [
          "Cloudflare.handoff",
          { instructions: input.instructions, timeout: input.timeoutMs },
        ]);
      },
      close: () => browser.close(),
    };
  }
  if (source.kind === "browserbase") {
    const response = await (options.fetch ?? fetch)(
      "https://api.browserbase.com/v1/sessions",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "content-type": "application/json",
          "x-bb-api-key": source.apiKey,
        },
        body: JSON.stringify({
          projectId: source.projectId,
          browserSettings: {
            recordSession: false,
            logSession: false,
            solveCaptchas: false,
          },
        }),
      },
    );
    if (!response.ok) throw new Error("Remote browser unavailable");
    const session = z
      .object({ id: z.string().min(1), connectUrl: z.url() })
      .parse(await response.json());
    const browser = await chromium.connectOverCDP(session.connectUrl, {
      timeout: 20_000,
    });
    return {
      browser,
      liveView: browserbaseLiveView({
        apiKey: source.apiKey,
        sessionId: session.id,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      close: () => browser.close(),
    };
  }
  const liveView = templateLiveView(source.liveViewUrlTemplate);
  if (!remoteCdpEndpointAllowed(source.endpoint))
    throw new Error("Invalid remote CDP endpoint");
  const browser = await chromium.connectOverCDP(source.endpoint, {
    ...(source.headers ? { headers: { ...source.headers } } : {}),
    timeout: 20_000,
  });
  return { browser, liveView, close: () => browser.close() };
}
