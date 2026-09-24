import { z } from "zod";
import { CeremonyError } from "./controller.js";
import { CeremonyDatabase } from "./storage.js";
import {
  openLiveBrowser,
  type LiveBrowser,
  type LiveViewSource,
} from "./live-view.js";

const handoffSchema = z.object({
  owner: z.string(),
  url: z.url(),
  expiresAt: z.number(),
  status: z.enum(["human", "returned", "failed"]),
});

/**
 * Where one takeover starts and where the person is handed the tab.
 *
 * This is what used to be hard-coded for GitHub: the broker's own human
 * route for the ceremony, the path the private cookie is scoped to, the
 * origin the route sends the person on to, and what they are told. A
 * connector supplies its own (`githubHumanTakeover` is GitHub's); nothing
 * here knows which provider is on the other side.
 */
export interface HumanTakeoverRoute {
  /** The broker's human route for this ceremony, a path on its origin. */
  path: string;
  /** The path the private continuation cookie is scoped to. Contains `path`. */
  cookiePath: string;
  /**
   * The provider origin the human route hands the tab on to. The takeover
   * begins once the tab is there, never before: the broker's own page is not
   * something a person is given control of.
   */
  destination: string;
  /** Shown by providers that display hand-off instructions. No secrets. */
  instructions: string;
}

export interface RemoteHumanBrowserOptions {
  /** The broker's public HTTPS origin, which the remote browser must reach. */
  origin: string;
  source: LiveViewSource;
  /** Swapped in tests; production opens the configured provider. */
  open?: (source: LiveViewSource) => Promise<LiveBrowser>;
  /** How long a person has before the takeover lapses. Five minutes. */
  windowMs?: number;
}

/**
 * Hand a person a remote browser tab for any connector's login.
 *
 * The broker automates only its own trusted navigation - it opens its human
 * route for the ceremony in a remote browser, with a private cookie scoped to
 * that route, and waits for the route to send the tab on to the provider.
 * From there the tab belongs to a person, through the provider's live view.
 * No generic evaluate, screenshot, DOM or network tool is exposed, and
 * finishing the takeover is not evidence of anything: the connector's own
 * callback and verification still decide whether access exists.
 *
 * The takeover URL controls the tab. It is stored only in the encrypted
 * database, bound to the owner who requested it, and resolved only by
 * `humanUrl` - which a host calls from its authenticated human route and
 * nowhere else.
 */
export class RemoteHumanBrowser {
  private readonly browsers = new Map<string, () => Promise<void>>();
  private readonly windowMs: number;
  constructor(
    private readonly db: CeremonyDatabase,
    private readonly options: RemoteHumanBrowserOptions,
  ) {
    const origin = new URL(options.origin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error(
        "Remote browsers require a publicly reachable HTTPS ceremony origin",
      );
    this.windowMs = options.windowMs ?? 300_000;
  }

  private checkedRoute(route: HumanTakeoverRoute) {
    const origin = new URL(this.options.origin).origin;
    const human = new URL(route.path, origin);
    const destination = new URL(route.destination);
    if (
      human.origin !== origin ||
      human.pathname !== route.path ||
      !route.cookiePath.startsWith("/") ||
      !(
        route.path === route.cookiePath ||
        route.path.startsWith(`${route.cookiePath.replace(/\/$/, "")}/`)
      ) ||
      destination.protocol !== "https:" ||
      destination.origin === origin
    )
      throw new Error("Invalid human takeover route");
    return { human: human.href, destination: destination.origin };
  }

  async request(
    owner: string,
    id: string,
    cookie: string,
    route: HumanTakeoverRoute,
  ): Promise<void> {
    const checked = this.checkedRoute(route);
    const key = `browser:${id}`;
    const existing = this.db.get(key, handoffSchema);
    if (existing && existing.owner !== owner)
      throw new CeremonyError("Browser handoff not found", 404);
    if (
      existing &&
      existing.owner === owner &&
      existing.expiresAt > Date.now() &&
      existing.status === "human"
    )
      return;
    const lease = this.db.acquire(key);
    let live: LiveBrowser | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      live = await (this.options.open ?? openLiveBrowser)(this.options.source);
      const { browser } = live;
      const context = browser.contexts()[0] ?? (await browser.newContext());
      // No tracing, HAR, recording, downloads, DOM extraction, screenshots or model page tools.
      await context.addCookies([
        {
          name: "ceremony-human",
          value: cookie,
          domain: new URL(this.options.origin).hostname,
          path: route.cookiePath,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await context.newPage();
      await page.goto(checked.human, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      // The trusted broker now submits/redirects automatically. Never click provider consent.
      await page.waitForURL((url) => url.origin === checked.destination, {
        timeout: 10_000,
      });
      const url = await live.liveView(page, { expiresInMs: this.windowMs });
      const active = live;
      let finished = false;
      const finish = async (status: "returned" | "failed") => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.db.put(key, { owner, url, expiresAt: Date.now(), status });
        this.browsers.delete(id);
        await active.close().catch(() => {});
      };
      const timer = setTimeout(() => {
        void finish("failed").catch(() => {});
      }, this.windowMs);
      timer.unref();
      cleanup = () => finish("failed");
      this.db.put(key, {
        owner,
        url,
        expiresAt: Date.now() + this.windowMs,
        status: "human",
      });
      // Where the provider has its own hand-off signal, use it. Its "done"
      // only ends the takeover; it is never read as authentication.
      await live.handoff?.(page, {
        instructions: route.instructions,
        timeoutMs: this.windowMs,
        onReturned: () => {
          void finish("returned").catch(() => {});
        },
      });
      if (!finished) this.browsers.set(id, cleanup);
    } catch {
      await cleanup?.().catch(() => {});
      await live?.close().catch(() => {});
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

export interface CloudflareOptions {
  accountId: string;
  apiToken: string;
  origin: string;
}

/**
 * `RemoteHumanBrowser` on Cloudflare Browser Run, with its account id checked
 * at construction. Kept under its old name for hosts that configured it; it
 * no longer carries any provider scenario of its own - GitHub's is
 * `githubHumanTakeover`, passed to `request` like any other connector's.
 */
export class CloudflareHumanBrowser extends RemoteHumanBrowser {
  constructor(db: CeremonyDatabase, options: CloudflareOptions) {
    z.string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(options.accountId);
    super(db, {
      origin: options.origin,
      source: {
        kind: "cloudflare",
        accountId: options.accountId,
        apiToken: options.apiToken,
      },
    });
  }
}
