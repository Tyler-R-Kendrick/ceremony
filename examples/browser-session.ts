import { chromium, type Browser, type Page } from "playwright-core";
import { z } from "zod";

/**
 * Where the agent's browser runs.
 *
 * The driver does not care: it drives a page. Who hosts the browser matters
 * for one reason — a person may have to take over for a step the agent cannot
 * do (a challenge, a passkey), and they can only do that in a browser they can
 * see. A hosted session gives them a live view of the agent's own tab. A local
 * one can only give them the page's address, which opens a fresh session of
 * their own, not the agent's.
 *
 * Selection is by configuration and never by probing: Cloudflare Browser
 * Rendering when its account and token are set, Browser Use Cloud when its key
 * is, otherwise the Chromium that Playwright is pointed at. Each hands back
 * the same thing, a connected Playwright browser, so the run is the same run.
 *
 * The two hosted backends are written to their published APIs and validated
 * on the way in, so a response of another shape fails loudly rather than
 * driving nothing. Neither is exercised by this repository's tests, which
 * have no account at either.
 */

export type BrowserBackend = "local" | "cloudflare" | "browser-use";

export interface BrowserSession {
  backend: BrowserBackend;
  browser: Browser;
  /** A view a person can watch and take over, for backends that offer one. */
  liveView(page: Page): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface BrowserSessionEnv {
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  CLOUDFLARE_API_TOKEN?: string | undefined;
  BROWSER_USE_API_KEY?: string | undefined;
  /** Extra Chromium switches for the local backend, whitespace-separated. */
  CEREMONY_BROWSER_ARGS?: string | undefined;
}

export function configuredBackend(env: BrowserSessionEnv): BrowserBackend {
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
    return "cloudflare";
  if (env.BROWSER_USE_API_KEY) return "browser-use";
  return "local";
}

const browserUseSession = z.object({
  id: z.string().min(1),
  cdpUrl: z.url(),
  liveUrl: z.url().optional(),
});

const cloudflareLiveView = z.object({ devtoolsFrontendUrl: z.url() });

export async function openBrowserSession(
  env: BrowserSessionEnv = process.env,
): Promise<BrowserSession> {
  const backend = configuredBackend(env);
  if (backend === "cloudflare") {
    const accountId = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(env.CLOUDFLARE_ACCOUNT_ID);
    const browser = await chromium.connectOverCDP(
      `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/devtools/browser?keep_alive=600000`,
      {
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        timeout: 20_000,
      },
    );
    return {
      backend,
      browser,
      liveView: async (page) => {
        const cdp = await page.context().newCDPSession(page);
        // Playwright's type map does not include Cloudflare's vendor domain.
        const live = cloudflareLiveView.parse(
          await Reflect.apply(cdp.send, cdp, [
            "Cloudflare.getLiveView",
            { mode: "tab", expiresInMs: 300_000 },
          ]),
        );
        return new URL(live.devtoolsFrontendUrl).protocol === "https:"
          ? live.devtoolsFrontendUrl
          : undefined;
      },
      close: () => browser.close(),
    };
  }
  if (backend === "browser-use") {
    const headers = {
      "x-browser-use-api-key": env.BROWSER_USE_API_KEY ?? "",
      "content-type": "application/json",
    };
    const created = await fetch("https://api.browser-use.com/api/v2/browsers", {
      method: "POST",
      headers,
      body: "{}",
    });
    if (!created.ok)
      throw new Error(`Browser Use refused a session (${created.status})`);
    const session = browserUseSession.parse(await created.json());
    const browser = await chromium.connectOverCDP(session.cdpUrl, {
      timeout: 20_000,
    });
    return {
      backend,
      browser,
      liveView: async () => session.liveUrl,
      close: async () => {
        await browser.close().catch(() => {});
        await fetch(
          `https://api.browser-use.com/api/v2/browsers/${session.id}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ action: "stop" }),
          },
        ).catch(() => {});
      },
    };
  }
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      ...(env.CEREMONY_BROWSER_ARGS ?? "").split(/\s+/).filter(Boolean),
    ],
  });
  return {
    backend,
    browser,
    liveView: async () => undefined,
    close: () => browser.close(),
  };
}
