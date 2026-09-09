import { chromium, type Browser } from "playwright-core";
import { z } from "zod";
import { CeremonyError } from "./controller.js";
import { CeremonyDatabase } from "./storage.js";

const handoffSchema = z.object({
  owner: z.string(),
  url: z.url(),
  expiresAt: z.number(),
  status: z.enum(["human", "returned", "failed"]),
});
export interface CloudflareOptions {
  accountId: string;
  apiToken: string;
  origin: string;
}
/** Trusted, fixed GitHub scenario. No generic evaluate/screenshot/network tools are exposed. */
export class CloudflareHumanBrowser {
  private readonly browsers = new Map<string, () => Promise<void>>();
  constructor(
    private readonly db: CeremonyDatabase,
    private readonly options: CloudflareOptions,
  ) {
    z.string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(options.accountId);
    if (new URL(options.origin).protocol !== "https:")
      throw new Error(
        "Remote browsers require a publicly reachable HTTPS ceremony origin",
      );
  }
  async request(owner: string, id: string, cookie: string): Promise<void> {
    const key = `browser:${id}`;
    const existing = this.db.get(key, handoffSchema);
    if (
      existing &&
      existing.owner === owner &&
      existing.expiresAt > Date.now() &&
      existing.status === "human"
    )
      return;
    const lease = this.db.acquire(key);
    let browser: Browser | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      browser = await chromium.connectOverCDP(
        `wss://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/browser-run/devtools/browser?keep_alive=600000`,
        {
          headers: { Authorization: `Bearer ${this.options.apiToken}` },
          timeout: 20_000,
        },
      );
      const context = browser.contexts()[0] ?? (await browser.newContext());
      // No tracing, HAR, recording, downloads, DOM extraction, screenshots or model page tools.
      await context.addCookies([
        {
          name: "ceremony-human",
          value: cookie,
          domain: new URL(this.options.origin).hostname,
          path: `/api/live/github/${id}`,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await context.newPage();
      await page.goto(`${this.options.origin}/api/live/github/${id}/human`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (page.url() !== `${this.options.origin}/api/live/github/${id}/human`)
        throw new Error("Unexpected scenario destination");
      // Only the fixed broker page is automated. Provider credentials and consent belong to the human.
      await page.locator("main form button, main a").click({ timeout: 10_000 });
      const cdp = await context.newCDPSession(page);
      const send = async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<unknown> => {
        // Playwright's upstream type map does not include Cloudflare's vendor CDP domain.
        return Reflect.apply(cdp.send, cdp, [method, params]);
      };
      const live = z.object({ devtoolsFrontendUrl: z.url() }).parse(
        await send("Cloudflare.getLiveView", {
          mode: "tab",
          expiresInMs: 300_000,
        }),
      );
      if (new URL(live.devtoolsFrontendUrl).protocol !== "https:")
        throw new Error("Unsafe live view URL");
      const activeBrowser = browser;
      let finished = false;
      const finish = async (status: "returned" | "failed") => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.db.put(key, {
          owner,
          url: live.devtoolsFrontendUrl,
          expiresAt: Date.now(),
          status,
        });
        this.browsers.delete(id);
        await activeBrowser.close().catch(() => {});
      };
      const timer = setTimeout(() => {
        void finish("failed").catch(() => {});
      }, 300_000);
      timer.unref();
      cleanup = () => finish("failed");
      // Vendor event is deliberately not interpreted as successful authentication.
      Reflect.apply(cdp.once, cdp, [
        "Cloudflare.handoffComplete",
        () => {
          void finish("returned").catch(() => {});
        },
      ]);
      this.db.put(key, {
        owner,
        url: live.devtoolsFrontendUrl,
        expiresAt: Date.now() + 300_000,
        status: "human",
      });
      await send("Cloudflare.handoff", {
        instructions:
          "Review the GitHub App, sign in if needed, and approve the intended account and repositories. Never enter secrets in chat. Wait for the ceremony's verification result before selecting Done.",
        timeout: 300_000,
      });
      if (!finished) this.browsers.set(id, cleanup);
    } catch {
      await cleanup?.().catch(() => {});
      await browser?.close().catch(() => {});
      throw new CeremonyError(
        "Remote browser unavailable. Continue in your own browser; completed setup is preserved.",
        503,
      );
    } finally {
      this.db.release(key, lease);
    }
  }
  /** Only an authenticated human HTTP route may resolve this control URL. */
  humanUrl(owner: string, id: string): string {
    const state = this.db.get(`browser:${id}`, handoffSchema);
    if (
      !state ||
      state.owner !== owner ||
      state.status !== "human" ||
      state.expiresAt <= Date.now()
    )
      throw new CeremonyError(
        "Browser handoff expired. Continue in your own browser.",
        409,
      );
    return state.url;
  }
  async close(): Promise<void> {
    for (const close of this.browsers.values()) await close().catch(() => {});
    this.browsers.clear();
  }
  cancel(id: string): void {
    void this.browsers
      .get(id)?.()
      .catch(() => {});
  }
}
