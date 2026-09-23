import { createHash, randomBytes } from "node:crypto";
import type { Browser, CDPSession, Locator, Page } from "playwright-core";
import { z } from "zod";
import { chromium } from "./playwright.js";
import { createWindowTracker, type WindowOpener } from "./browser-windows.js";
import {
  browserbaseLiveView,
  cloudflareLiveView,
  liveViewTemplateAllowed,
  remoteCdpEndpointAllowed,
  templateLiveView,
  type LiveViewMinter,
} from "./live-view.js";

export { remoteCdpEndpointAllowed } from "./live-view.js";
import { createBrowserEgressProxy } from "./browser-egress.js";
import { accountIdentifierSchema } from "../core/teaching-contracts.js";

import {
  verificationFromMessage,
  type ProgrammableInbox,
} from "./authored-inbox.js";
import type {
  CeremonyInterpreter,
  InterpreterAction,
  PageSnapshot,
  SnapshotElement,
} from "./isolated-account-interpreter.js";

export type IsolatedAccount = {
  username: string;
  password: string;
  email?: string;
};

export type IsolatedAccountVault = {
  get(): Promise<IsolatedAccount | undefined>;
  /** Persist generated credentials as unverified before provider submission. */
  stage?(account: IsolatedAccount): Promise<void>;
  put(account: IsolatedAccount): Promise<void>;
};

export type AuthorizationBrowserInput = {
  /** Host-bound session key; never supplied by browser or model input. */
  sessionKey?: string;
  resumeSession?: boolean;
  accountOnly?: boolean;
  startUrl: string;
  startUrls?: string[];
  redirectUri: string;
  allowedOrigins: string[];
  /**
   * Origins at which a window the provider page opens is where this
   * authorization continues - a "Sign in with ..." button that opens one.
   * A window's first request may only load it (a bare GET or HEAD): a form
   * submitted into a new window is refused, because nothing can see that
   * request's redirects. Each must already be one of
   * `allowedOrigins` (or the redirect origin): declaring a window is a
   * statement about *where* the login continues, never a widening of where
   * it may go, and a declaration outside them is refused before a browser
   * opens.
   *
   * Absent or empty - the ordinary case - every window the page opens is
   * refused before its first request, as it always was. The rule for
   * adopting one is the login driver's, shared through `browser-windows.ts`.
   */
  popupOrigins?: string[];
  credentials?: { username?: string; password?: string; email?: string };
  preferredUsername?: string;
  generateAccount?: boolean;
  vault?: IsolatedAccountVault;
  /** Agent inbox for registration: fresh address plus verification email access. */
  inbox?: ProgrammableInbox;
  timeoutMs?: number;
  onEvent?: (text: string) => void;
};

type DriveInput = AuthorizationBrowserInput & {
  privateValues: Set<string>;
  /**
   * Whether a window has taken over from the page being driven. Checked
   * before every step; when it answers true the drive hands back
   * `windowTakeover` so the caller can continue in the right document.
   */
  yieldTo?: () => boolean;
  /** After a click that may open a window: wait, bounded, for its report. */
  afterClick?: () => Promise<void>;
  resume?: boolean;
  provisionedEmail?: string;
  provisionedAt?: number;
  interpreter?: CeremonyInterpreter;
  progress?: {
    registrationSubmitted: boolean;
    emailRejected: boolean;
    verificationDone: boolean;
    rejected: boolean;
    submittedAccount: boolean;
  };
};

/**
 * What a drive returns when a window took over. Internal: `complete` switches
 * documents on it and never returns it.
 */
const windowTakeover = "window-takeover";

export type AuthorizationBrowserResult = {
  accountStored?: boolean;
  sessionPending?: boolean;
} & (
  | { status: "callback"; url: string }
  | { status: "credentials" }
  | { status: "blocked"; reason: string }
);

export const browserHumanActionSchema = z.union([
  z.strictObject({ code: z.string().trim().min(1).max(128) }),
  z.strictObject({ text: z.string().min(1).max(1024) }),
  z.strictObject({ key: z.enum(["Enter", "Tab", "Space"]) }),
  z.strictObject({
    x: z.coerce.number().int().min(0).max(1279),
    y: z.coerce.number().int().min(0).max(719),
  }),
  z.strictObject({}),
]);

export type AuthorizationBrowser = {
  complete(
    input: AuthorizationBrowserInput,
  ): Promise<AuthorizationBrowserResult>;
  screenshot?(sessionKey: string): Promise<Uint8Array | undefined>;
  interact?(
    sessionKey: string,
    action: z.infer<typeof browserHumanActionSchema>,
  ): Promise<boolean>;
  close?(sessionKey: string): Promise<void>;
  /**
   * A takeover URL for a session waiting on a person, when the browser runs
   * at a provider that offers a live view (Cloudflare Browser Run,
   * Browserbase, or a CDP endpoint configured with a live-view template).
   * `undefined` when there is no such session here or no live view.
   *
   * The URL controls the whole tab. Only a host's authenticated human route
   * may ask for it, and it is never part of a result or an event.
   */
  liveView?(sessionKey: string): Promise<string | undefined>;
};

type Opened = {
  browser: Browser;
  close: () => Promise<void>;
  /** How this browser's provider mints a takeover URL, if it can. */
  liveView?: LiveViewMinter;
};

/**
 * Any browser that speaks the Chrome DevTools Protocol over a websocket.
 *
 * Browserbase and Cloudflare each needed a code path of their own because
 * each mints its endpoint differently. Most hosted and self-hosted browsers
 * (Steel, browserless, a Chromium the operator runs with a debugging port)
 * simply hand out a `wss://` address and, sometimes, a header to present with
 * it — so one configuration covers all of them.
 *
 * It is host configuration and nothing else. Whoever holds this endpoint holds
 * the whole browser, cookies and all, so it is never accepted from a request,
 * a recipe or a model, and it is subject to the same egress rule as every
 * other remote browser: without a vetted `remoteProxy` nothing is opened.
 */
export type RemoteCdpBrowser = {
  endpoint: string;
  /** Presented on the websocket upgrade, e.g. an `Authorization` header. */
  headers?: Record<string, string>;
  /**
   * The operator's live view for this endpoint, with `{targetId}` for the
   * tab's CDP target id - how a person takes over a login this browser is
   * waiting on. Absent, the endpoint offers no takeover link.
   */
  liveViewUrlTemplate?: string;
};

type BrowserOptions = {
  open?: () => Promise<Opened>;
  cloudflare?: { accountId: string; apiToken: string };
  browserbase?: { apiKey: string; projectId: string };
  cdp?: RemoteCdpBrowser;
  interpreter?: CeremonyInterpreter;
  /** Server-vetted remote proxy; never supplied by model or request input. */
  remoteProxy?: { server: string; username?: string; password?: string };
};

export type RemoteBrowserOptions = Pick<
  BrowserOptions,
  "browserbase" | "cdp" | "remoteProxy"
>;

/**
 * Read a host's remote-browser configuration from its environment.
 *
 * Every value is validated here, at startup, so a typo is a refusal to boot
 * rather than a login that quietly ends `browser-unavailable` later. The
 * variables are read only from the host's environment; nothing a request or a
 * model says reaches them.
 *
 * - `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`: Browserbase sessions.
 * - `CEREMONY_BROWSER_CDP_URL`: any CDP websocket endpoint.
 * - `CEREMONY_BROWSER_CDP_HEADERS`: a JSON object of headers for it.
 * - `CEREMONY_BROWSER_CDP_LIVE_VIEW_URL`: the operator's live view for that
 *   endpoint, an `https:` template with `{targetId}` for the tab.
 * - `CEREMONY_BROWSER_REMOTE_PROXY`: the egress proxy every remote browser is
 *   required to use, with `CEREMONY_BROWSER_REMOTE_PROXY_USERNAME` and
 *   `CEREMONY_BROWSER_REMOTE_PROXY_PASSWORD` when it authenticates.
 */
export function remoteBrowserOptionsFromEnv(
  env: Record<string, string | undefined>,
): RemoteBrowserOptions {
  const options: RemoteBrowserOptions = {};
  if (env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID)
    options.browserbase = {
      apiKey: env.BROWSERBASE_API_KEY,
      projectId: env.BROWSERBASE_PROJECT_ID,
    };
  if (env.CEREMONY_BROWSER_CDP_URL) {
    if (!remoteCdpEndpointAllowed(env.CEREMONY_BROWSER_CDP_URL))
      throw new Error(
        "CEREMONY_BROWSER_CDP_URL must be wss:// (or ws:// on loopback) with no userinfo",
      );
    const headers = env.CEREMONY_BROWSER_CDP_HEADERS
      ? z.record(z.string().min(1).max(128), z.string().max(4096)).safeParse(
          (() => {
            try {
              return JSON.parse(env.CEREMONY_BROWSER_CDP_HEADERS);
            } catch {
              return undefined;
            }
          })(),
        )
      : undefined;
    // The message names the variable and never its content: these headers
    // are usually the endpoint's credential.
    if (headers && !headers.success)
      throw new Error("CEREMONY_BROWSER_CDP_HEADERS must be a JSON object");
    const liveView = env.CEREMONY_BROWSER_CDP_LIVE_VIEW_URL;
    if (liveView !== undefined && !liveViewTemplateAllowed(liveView))
      throw new Error(
        "CEREMONY_BROWSER_CDP_LIVE_VIEW_URL must be an https:// URL with no userinfo, using only {targetId}",
      );
    options.cdp = {
      endpoint: env.CEREMONY_BROWSER_CDP_URL,
      ...(headers?.success ? { headers: headers.data } : {}),
      ...(liveView ? { liveViewUrlTemplate: liveView } : {}),
    };
  }
  if (env.CEREMONY_BROWSER_REMOTE_PROXY) {
    let proxy: URL;
    try {
      proxy = new URL(env.CEREMONY_BROWSER_REMOTE_PROXY);
    } catch {
      throw new Error("CEREMONY_BROWSER_REMOTE_PROXY must be a URL");
    }
    // Same rule `openBrowser` applies, applied at boot: credentials go in
    // their own variables, never in a URL that gets printed.
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      proxy.username ||
      proxy.password
    )
      throw new Error(
        "CEREMONY_BROWSER_REMOTE_PROXY must be http(s):// with no userinfo",
      );
    options.remoteProxy = {
      server: env.CEREMONY_BROWSER_REMOTE_PROXY,
      ...(env.CEREMONY_BROWSER_REMOTE_PROXY_USERNAME
        ? { username: env.CEREMONY_BROWSER_REMOTE_PROXY_USERNAME }
        : {}),
      ...(env.CEREMONY_BROWSER_REMOTE_PROXY_PASSWORD
        ? { password: env.CEREMONY_BROWSER_REMOTE_PROXY_PASSWORD }
        : {}),
    };
  }
  return options;
}

/**
 * End every navigation that a window other than the opener has in flight,
 * while this process's interception is still attached to it.
 *
 * This exists because of how a context is torn down. Chromium *continues* a
 * request that is paused for interception when the DevTools client holding it
 * detaches, and closing a context detaches every client in it. A popup's first
 * request is reported before Playwright has created the popup's page, and the
 * route handler that would abort it can still be queued behind other work -
 * so a close meant to contain a popup would itself send the popup's
 * credential POST. That was the intermittent failure of "popup form delegates
 * before its first credential POST": the provider saw the POST moments after
 * the executor had already decided to refuse it.
 *
 * Stopping the window's load ends the navigation inside the browser, and a
 * paused request belonging to a navigation that no longer exists is dropped
 * instead of continued. A popup with no Playwright page yet is reachable only
 * as a CDP target, so it is attached through the opener's own session.
 * Best-effort and bounded: a target that has already gone needs nothing.
 */
export async function stopWindows(
  session: CDPSession,
  targetIds: Iterable<string>,
) {
  await Promise.all(
    [...targetIds].map(async (targetId) => {
      const { sessionId } = await session.send("Target.attachToTarget", {
        targetId,
        flatten: false,
      });
      // Wait for the reply rather than only the dispatch: the close that
      // follows must not overtake the stop it depends on.
      const replied = new Promise<void>((resolve) => {
        const timer = setTimeout(done, 2_000);
        timer.unref();
        function done() {
          clearTimeout(timer);
          session.off("Target.receivedMessageFromTarget", listener);
          resolve();
        }
        function listener(event: { sessionId: string }) {
          if (event.sessionId === sessionId) done();
        }
        session.on("Target.receivedMessageFromTarget", listener);
      });
      await session.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: 1, method: "Page.stopLoading" }),
      });
      await replied;
    }),
  );
}

/**
 * The windows in `own`'s browser context other than `own` itself, kept from
 * the browser's own target notifications so that stopping them at close needs
 * no enumeration of its own - the final inspection before a result is
 * published stays the one read of the target list it is.
 *
 * A window the opener has just announced (`Page.windowOpen`) can be reported
 * by the opener before the browser reports its target, and a close that raced
 * ahead of that report would not know the window was there to stop. `expect`
 * records the announcement, and `stop` waits - bounded - for the browser to
 * name every window it was told about.
 */
export async function watchForeignWindows(
  session: CDPSession,
  own: { targetId: string; browserContextId?: string | undefined },
) {
  const windows = new Set<string>();
  let discovered = 0;
  let announced = 0;
  let arrivals: (() => void)[] = [];
  session.on("Target.targetCreated", ({ targetInfo }) => {
    if (
      targetInfo.type !== "page" ||
      targetInfo.browserContextId !== own.browserContextId ||
      targetInfo.targetId === own.targetId
    )
      return;
    windows.add(targetInfo.targetId);
    discovered++;
    for (const arrived of arrivals.splice(0)) arrived();
  });
  session.on("Target.targetDestroyed", ({ targetId }) => {
    windows.delete(targetId);
  });
  await session.send("Target.setDiscoverTargets", { discover: true });
  return {
    expect() {
      announced++;
    },
    /** Whether there is anything for `stop` to do. */
    get idle() {
      return windows.size === 0 && discovered >= announced;
    },
    async stop() {
      // A timer rather than the clock: this runs at teardown, and a caller
      // that has frozen `Date.now` must still get its browser closed.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), 2_000);
        timer.unref();
      });
      while (discovered < announced) {
        const arrived = new Promise<false>((resolve) =>
          arrivals.push(() => resolve(false)),
        );
        if (await Promise.race([arrived, deadline])) break;
      }
      clearTimeout(timer);
      arrivals = [];
      await stopWindows(session, windows);
    },
  };
}

async function requiresAuthenticator(page: Page) {
  if (
    await page.evaluate(
      () => Reflect.get(window, "__ceremonyAuthenticatorRequested") === true,
    )
  )
    return true;
  // A prompt is a handoff signal, never evidence that authentication succeeded.
  const prompt = page.locator("h1, h2, [role=dialog], [role=alert]").filter({
    hasText:
      /(?:use|verify|authenticate|sign in|insert|touch).{0,60}(?:passkey|security key)|(?:passkey|security key).{0,60}(?:required|verification|authentication)/i,
  });
  for (const element of await prompt.all())
    if (await element.isVisible()) return true;
  return false;
}

function originOf(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function hostnameOf(origin: string) {
  try {
    return new URL(origin).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function generateIsolatedAccount(
  preferredUsername?: string,
): IsolatedAccount {
  const token = randomBytes(6).toString("hex");
  const selected = accountIdentifierSchema.safeParse(preferredUsername);
  const email =
    selected.success && selected.data.includes("@") ? selected.data : undefined;
  return {
    username: selected.success && !email ? selected.data : `cmy${token}`,
    password: `Cm9!${randomBytes(16).toString("base64url")}`,
    ...(email ? { email } : {}),
  };
}

function accountEmail(username: string) {
  return username.includes("@") ? username : `${username}@invalid`;
}

function accountHandle(username: string) {
  return username.includes("@")
    ? username.slice(0, username.indexOf("@"))
    : username;
}

function accountCollision(text: string) {
  return /email|address/i.test(text) ? "email-in-use" : "username-in-use";
}

function rememberPrivateLink(values: Set<string>, href: string) {
  const url = new URL(href);
  for (const value of [
    href,
    url.username,
    url.password,
    ...url.pathname.split("/"),
    ...url.searchParams.values(),
    url.hash.slice(1),
    ...new URLSearchParams(url.hash.slice(1)).values(),
  ]) {
    values.add(value);
    try {
      values.add(decodeURIComponent(value));
    } catch {
      // Malformed percent escapes still retain their original private form.
    }
  }
}

async function authenticatedPage(page: Page) {
  return (
    (await page
      .locator(
        "a[href*='logout'], form[action*='logout'], a[href*='signout'], [data-authenticated=true], meta[name=user-login][content]:not([content=''])",
      )
      .count()) > 0
  );
}

function suppliedAccount(
  credentials: AuthorizationBrowserInput["credentials"],
): IsolatedAccount | undefined {
  return credentials?.password
    ? {
        username: credentials.username ?? "",
        password: credentials.password,
        ...(credentials.email ? { email: credentials.email } : {}),
      }
    : undefined;
}

async function fillIsolatedAccount(
  page: Page,
  account: IsolatedAccount,
  email?: string,
  registration = false,
) {
  const address = email ?? accountEmail(account.username);
  const handle = accountHandle(account.username);
  const emailField = page
    .locator("input[type=email], input[name=email], input[autocomplete=email]")
    .first();
  // Priority order, not DOM order: a generic text input (e.g. a "Name" field)
  // must not shadow the actual username/handle field.
  let userField;
  for (const selector of [
    "input[name=handle]",
    "input[name=username]",
    "input[name=identifier]",
    "input[autocomplete=username]",
    "input[name*=user i]",
    ...(registration ? [] : ["input[type=text]"]),
  ]) {
    const candidate = page.locator(selector).first();
    if ((await candidate.count()) > 0) {
      userField = candidate;
      break;
    }
  }
  const hasEmail = (await emailField.count()) > 0;
  if (hasEmail) await emailField.fill(address);
  if (handle && userField) {
    // Identifier-first flows use the email field itself as the identifier.
    const same = hasEmail
      ? await (async () => {
          const left = await emailField.elementHandle();
          const right = await userField.elementHandle();
          return left && right
            ? await page
                .evaluate(([a, b]) => a === b, [left, right])
                .catch(() => false)
            : false;
        })()
      : false;
    if (!same) await userField.fill(registration ? handle : account.username);
  }
  const named = page
    .locator("input[name*=display i], input[id*=display i]")
    .first();
  if ((await named.count()) > 0 && !(await named.inputValue()))
    await named.fill(handle).catch(() => {});
  const passwords = page.locator("input[type=password]");
  const count = await passwords.count();
  for (let index = 0; index < Math.min(count, 2); index += 1)
    await passwords.nth(index).fill(account.password);
}

/** Provider-declared constraints, not model guesses, identify missing input. */
async function focusRequiredInput(page: Page) {
  return page.evaluate(() => {
    const field = [
      ...document.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >(
        "input:required:invalid, select:required:invalid, textarea:required:invalid",
      ),
    ].find(
      (element) => !element.disabled && element.getClientRects().length > 0,
    );
    field?.focus();
    return Boolean(field);
  });
}

export function allowedAuthorizationOrigin(
  href: string,
  allowedOrigins: string[],
  redirectUri: string,
) {
  const origin = originOf(href);
  if (!origin) return false;
  if (origin === originOf(redirectUri)) return true;
  // Authority includes scheme and port; a shared suffix is not discovered trust.
  return allowedOrigins.some((item) => origin === originOf(item));
}

async function openRemote(options: {
  cloudflare?: { accountId: string; apiToken: string };
  browserbase?: { apiKey: string; projectId: string };
  cdp?: RemoteCdpBrowser;
}): Promise<Opened | undefined> {
  if (options.browserbase) {
    const response = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "content-type": "application/json",
        "x-bb-api-key": options.browserbase.apiKey,
      },
      body: JSON.stringify({
        projectId: options.browserbase.projectId,
        browserSettings: {
          recordSession: false,
          logSession: false,
          solveCaptchas: false,
        },
      }),
    });
    if (response.ok) {
      const session = z
        .object({
          connectUrl: z.string().url(),
          // Needed only for the live view; a session without one still runs.
          id: z.string().min(1).optional(),
        })
        .parse(await response.json());
      const browser = await chromium.connectOverCDP(session.connectUrl, {
        timeout: 20_000,
      });
      return {
        browser,
        close: () => browser.close(),
        ...(session.id
          ? {
              liveView: browserbaseLiveView({
                apiKey: options.browserbase.apiKey,
                sessionId: session.id,
              }),
            }
          : {}),
      };
    }
  }
  if (options.cloudflare) {
    const browser = await chromium.connectOverCDP(
      `wss://api.cloudflare.com/client/v4/accounts/${options.cloudflare.accountId}/browser-run/devtools/browser?keep_alive=600000`,
      {
        headers: { Authorization: `Bearer ${options.cloudflare.apiToken}` },
        timeout: 20_000,
      },
    );
    return {
      browser,
      close: () => browser.close(),
      liveView: cloudflareLiveView(),
    };
  }
  if (options.cdp) {
    // Checked again here and not only at boot: a host that builds these
    // options in code never passes through the environment reader.
    if (!remoteCdpEndpointAllowed(options.cdp.endpoint))
      throw new Error("Invalid remote CDP endpoint");
    // Checked before dialling, so a bad template never opens a browser.
    const liveView = options.cdp.liveViewUrlTemplate
      ? templateLiveView(options.cdp.liveViewUrlTemplate)
      : undefined;
    const browser = await chromium.connectOverCDP(options.cdp.endpoint, {
      ...(options.cdp.headers ? { headers: { ...options.cdp.headers } } : {}),
      timeout: 20_000,
    });
    return {
      browser,
      close: () => browser.close(),
      ...(liveView ? { liveView } : {}),
    };
  }
}

async function openBrowser(
  options: BrowserOptions,
): Promise<Opened & Pick<BrowserOptions, "remoteProxy">> {
  const supplied = await options.open?.();
  if (supplied) return supplied;
  // A remote browser's traffic leaves from somebody else's network, where the
  // local egress proxy cannot reach it. The vetted remote proxy is the only
  // containment such a browser has, so without one nothing remote is opened -
  // whichever provider the endpoint came from.
  if (options.browserbase || options.cloudflare || options.cdp) {
    if (!options.remoteProxy)
      throw new Error("Remote egress is not configured");
    const proxy = new URL(options.remoteProxy.server);
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      proxy.username ||
      proxy.password
    )
      throw new Error("Invalid remote egress proxy");
    const opened = await openRemote(options);
    if (!opened) throw new Error("Remote browser is unavailable");
    return { ...opened, remoteProxy: options.remoteProxy };
  }
  const proxy = await createBrowserEgressProxy();
  try {
    const launched = await chromium.launch({
      headless: true,
      proxy: { server: proxy.server, bypass: "<-loopback>" },
      args: [
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    return {
      browser: launched,
      close: async () => {
        try {
          await launched.close();
        } finally {
          await proxy.close();
        }
      },
    };
  } catch (error) {
    await proxy.close();
    throw error;
  }
}

async function loadProviderPage(
  page: Page,
  input: DriveInput,
  timeoutMs: number,
): Promise<AuthorizationBrowserResult | undefined> {
  const event = (text: string) => input.onEvent?.(text);
  const response = input.resume
    ? undefined
    : await page
        .goto(input.startUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(20_000, timeoutMs),
        })
        .catch(() => undefined);
  if (!input.resume && !response) {
    event("Could not load the provider page");
    return { status: "blocked", reason: "unreachable" };
  }
  if (response && response.status() >= 400) {
    event(`Provider page unavailable (${response.status()})`);
    return {
      status: "blocked",
      reason:
        response.status() === 429 || response.status() >= 500
          ? "unreachable"
          : "missing",
    };
  }
}

async function drive(
  page: Page,
  input: DriveInput,
): Promise<AuthorizationBrowserResult> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  const event = (text: string) => input.onEvent?.(text);
  const failure = await loadProviderPage(page, input, timeoutMs);
  if (failure) return failure;
  const identifier = () =>
    page
      .locator(
        "input[type=email], input[name=handle], input[name=username], input[name=identifier], input[autocomplete=username], input[type=text]",
      )
      .first();
  const password = () => page.locator("input[type=password]").first();
  const submit = () =>
    page
      .locator(
        "button[type=submit], input[type=submit], button:has-text('Sign in'), button:has-text('Log in'), button:has-text('Sign up'), button:has-text('Create account'), button:has-text('Register'), button:has-text('Next'), button:has-text('Continue')",
      )
      .first();
  const challenge = () =>
    page
      .locator(
        "iframe[src*='challenges.cloudflare.com'], iframe[src*='hcaptcha.com'], iframe[src*='recaptcha'], iframe[src*='turnstile'], div.cf-turnstile, div.h-captcha",
      )
      .first();
  const verification = () =>
    page
      .locator(
        "input[autocomplete=one-time-code], input[name*=verification i], input[id*=verification i], input[name*=otp i], input[id*=otp i]",
      )
      .first();
  const inUseComplaint = () =>
    page
      .getByText(
        /already (?:in use|registered|taken)|(?:email|handle|username).{0,48}(?:in use|taken|registered)/i,
      )
      .first();
  const account = suppliedAccount(input.credentials);
  const waitForEmail = async (): Promise<"code" | "link" | undefined> => {
    if (!input.inbox || !input.provisionedEmail) return undefined;
    event("Waiting for the provider's verification email");
    const email = input.provisionedEmail;
    const since = input.provisionedAt ?? Date.now() - 120_000;
    const host = hostnameOf(page.url());
    const waitDeadline = Math.min(deadline, Date.now() + 240_000);
    const began = Date.now();
    let resendClicked = false;
    while (Date.now() < waitDeadline) {
      const message = await input.inbox
        .latest(email, since)
        .catch(() => undefined);
      const found = message
        ? verificationFromMessage(message, host)
        : undefined;
      if (found?.code && (await verification().count()) > 0) {
        input.privateValues.add(found.code);
        event("Filling the verification code from the agent inbox");
        try {
          await verification().fill(found.code);
          if ((await submit().count()) > 0) await submit().click();
          else await verification().press("Enter");
        } catch {
          /* Page transitioned mid-fill; re-evaluate on the next pass. */
        }
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return "code";
      }
      if (found?.link) {
        rememberPrivateLink(input.privateValues, found.link);
        event("Opening the verification link from the agent inbox");
        await page
          .goto(found.link, { waitUntil: "domcontentloaded", timeout: 15_000 })
          .catch(() => {});
        return "link";
      }
      if (!resendClicked && Date.now() - began > 45_000) {
        const resend = page
          .locator(
            "a:has-text('Send Confirmation Email'), button:has-text('Send Confirmation Email'), a:has-text('Resend'), button:has-text('Resend'), a:has-text('resend the'), button:has-text('resend the')",
          )
          .first();
        if ((await resend.count()) > 0) {
          event("Asking the provider to resend the verification email");
          await resend.click().catch(() => {});
          resendClicked = true;
        }
      }
      await page.waitForTimeout(3_000);
    }
    return undefined;
  };
  let idle = 0;
  let rejections = 0;
  let submittedAccount = input.progress?.submittedAccount ?? false;
  const inspect = async (
    href: string,
  ): Promise<AuthorizationBrowserResult | "continue" | undefined> => {
    if (
      !allowedAuthorizationOrigin(href, input.allowedOrigins, input.redirectUri)
    )
      return { status: "blocked", reason: "origin" };
    const url = new URL(href);
    if (
      originOf(href) === originOf(input.redirectUri) &&
      url.searchParams.has("code")
    ) {
      event("Captured the authorization callback");
      return { status: "callback", url: href };
    }
    if ((await challenge().count()) > 0) {
      event("The provider requires a human challenge (CAPTCHA)");
      return { status: "blocked", reason: "challenge" };
    }
    if (await requiresAuthenticator(page)) {
      event("The provider requires an authenticator in the user's browser");
      return { status: "blocked", reason: "passkey" };
    }
    if (
      input.accountOnly &&
      submittedAccount &&
      (await authenticatedPage(page))
    )
      return { status: "credentials" };
    if ((await verification().count()) > 0) {
      if (input.inbox && input.provisionedEmail) {
        const resumed = await waitForEmail();
        if (!resumed) {
          event("No verification email arrived in time");
          return { status: "blocked", reason: "verification" };
        }
        if (input.progress) input.progress.verificationDone = true;
        idle = 0;
        return "continue";
      }
      event(
        "Provider requires a verification code the isolated browser cannot receive",
      );
      return { status: "blocked", reason: "verification" };
    }
  };
  const waitWithoutForm = async (): Promise<
    AuthorizationBrowserResult | undefined
  > => {
    if ((await inUseComplaint().count()) > 0) {
      const reason = accountCollision(await inUseComplaint().innerText());
      event(
        "Provider rejected the requested account identifier as already in use",
      );
      if (input.progress) input.progress.emailRejected = true;
      return { status: "blocked", reason };
    }
    if ((await challenge().count()) > 0) {
      event("The provider requires a human challenge (CAPTCHA)");
      return { status: "blocked", reason: "challenge" };
    }
    if (
      input.inbox &&
      input.provisionedEmail &&
      input.progress?.registrationSubmitted &&
      !input.progress.verificationDone
    ) {
      const resumed = await waitForEmail();
      if (resumed) {
        input.progress.verificationDone = true;
        idle = 0;
        return;
      }
      event("No verification email arrived in time");
      return { status: "blocked", reason: "verification" };
    }
    if (
      input.accountOnly &&
      submittedAccount &&
      (await authenticatedPage(page))
    ) {
      event("Provider accepted the account credentials");
      return { status: "credentials" };
    }
    idle += 1;
    const anubis =
      (await page.locator("script#anubis_version").count()) > 0 ||
      /not a bot/i.test(await page.title().catch(() => ""));
    if (idle >= (anubis ? 120 : 24)) {
      event("No sign-in or registration form on the provider page");
      return { status: "blocked", reason: "no-form" };
    }
    await page.waitForTimeout(250);
  };
  const submitAccount = async (
    account: IsolatedAccount,
    hasPassword: boolean,
    href: string,
  ): Promise<AuthorizationBrowserResult | undefined> => {
    if ((await inUseComplaint().count()) > 0) {
      const reason = accountCollision(await inUseComplaint().innerText());
      event(
        "Provider rejected the requested account identifier as already in use",
      );
      if (input.progress) input.progress.emailRejected = true;
      return { status: "blocked", reason };
    }
    event("Filling account credentials on the provider page");
    try {
      await fillIsolatedAccount(
        page,
        account,
        input.provisionedEmail ?? account.email,
        Boolean(input.generateAccount),
      );
      if (await focusRequiredInput(page))
        return { status: "blocked", reason: "required-input" };
      if ((await submit().count()) > 0) await submit().click();
      else if (hasPassword) await password().press("Enter");
      else await identifier().press("Enter");
      await input.afterClick?.();
      submittedAccount = true;
      if (input.progress) input.progress.submittedAccount = true;
      if (
        input.generateAccount &&
        /sign.?up|register|join|create/i.test(href) &&
        input.progress
      )
        input.progress.registrationSubmitted = true;
    } catch {
      /* Page transitioned mid-fill; re-evaluate on the next pass. */
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const alerts = (
      await page
        .locator(
          "div[role=alert], .alert-danger, .invalid-feedback, .form-error, .error-message",
        )
        .allInnerTexts()
        .catch(() => [] as string[])
    )
      .map((text) => text.trim())
      .filter(Boolean);
    if (alerts.length) {
      rejections += 1;
      event(
        "Provider rejected the submission; review it in the private browser",
      );
      if (rejections >= 1) {
        if (input.progress) input.progress.rejected = true;
        return { status: "blocked", reason: "rejected" };
      }
    } else rejections = 0;
  };
  while (Date.now() < deadline) {
    if (input.yieldTo?.()) return { status: "blocked", reason: windowTakeover };
    const href = page.url();
    const inspected = await inspect(href);
    if (inspected === "continue") continue;
    if (inspected) return inspected;
    const hasPassword = (await password().count()) > 0;
    const hasIdentifier = (await identifier().count()) > 0;
    const consent = page
      .locator(
        "button:has-text('Authorize'), button:has-text('Allow'), button:has-text('Approve')",
      )
      .first();
    const hasConsent = (await consent.count()) > 0;
    const signupTexts = ["Sign up", "Create account", "Register"];
    const signupSelector = signupTexts
      .flatMap((text) => [
        `a:has-text('${text}')`,
        `button:has-text('${text}')`,
      ])
      .join(", ");
    const signup = page.locator(signupSelector).first();
    const hasSignup = (await signup.count()) > 0;
    const clickSignup = async () => {
      const dialogSignup = page
        .locator(
          signupTexts
            .flatMap((text) => [
              `[role=dialog] a:has-text('${text}')`,
              `[role=dialog] button:has-text('${text}')`,
            ])
            .join(", "),
        )
        .first();
      if ((await dialogSignup.count()) > 0)
        await dialogSignup.click().catch(() => {});
      else await signup.click().catch(() => {});
    };
    if (!hasPassword && !hasIdentifier && !hasConsent && !hasSignup) {
      const result = await waitWithoutForm();
      if (result) return result;
      continue;
    }
    idle = 0;
    if ((hasPassword || hasIdentifier) && !account) {
      if (hasSignup && input.generateAccount) {
        event("No stored account; following the registration link");
        await clickSignup();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }
      return { status: "blocked", reason: "session" };
    }
    if (account && (hasPassword || hasIdentifier)) {
      const result = await submitAccount(account, hasPassword, href);
      if (result) return result;
      continue;
    }
    if (!account && hasSignup && input.generateAccount) {
      event("No stored account; following the registration link");
      await clickSignup();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      continue;
    }
    if (hasConsent) {
      event("Approving the provider consent prompt");
      await consent.click().catch(() => {});
      await input.afterClick?.();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      continue;
    }
    await page.waitForTimeout(250);
  }
  event("Timed out waiting for the provider page");
  return { status: "blocked", reason: "timeout" };
}

/** Sanitized page snapshot: roles, labels and types only. Values are never read. */
export async function snapshotPage(
  page: Pick<Page, "evaluate" | "url">,
  privateValues: Set<string>,
): Promise<PageSnapshot> {
  const raw = await page.evaluate(
    (privateValues) => {
      const seen = new Set<Element>();
      const elements: Array<Record<string, unknown>> = [];
      // Object methods survive browser serialization without TSX's outer __name helper.
      const collector = {
        text(value: string, limit: number) {
          for (const secret of privateValues)
            if (secret) value = value.replaceAll(secret, "[private]");
          return value.slice(0, limit);
        },
        push(el: Element, kind: string) {
          if (seen.has(el) || elements.length >= 40) return;
          seen.add(el);
          const index = elements.length;
          (el as HTMLElement).setAttribute("data-cmy-idx", String(index));
          const input = el as HTMLInputElement;
          const label =
            el.getAttribute("aria-label") ??
            input.labels?.[0]?.textContent?.trim() ??
            "";
          elements.push({
            index,
            kind,
            ...(input.type && input.type !== "text"
              ? { type: input.type }
              : {}),
            ...(input.name ? { name: collector.text(input.name, 60) } : {}),
            ...(label ? { label: collector.text(label, 80) } : {}),
            ...(input.placeholder
              ? { placeholder: collector.text(input.placeholder, 80) }
              : {}),
            ...(kind !== "input" && el.textContent?.trim()
              ? { text: collector.text(el.textContent.trim(), 80) }
              : {}),
            ...(input.required ? { required: true } : {}),
          });
        },
      };
      for (const el of document.querySelectorAll(
        "input:not([type=hidden]):not([type=submit]), textarea",
      ))
        collector.push(
          el,
          (el as HTMLInputElement).type === "checkbox" ? "checkbox" : "input",
        );
      for (const el of document.querySelectorAll("select"))
        collector.push(el, "select");
      for (const el of document.querySelectorAll(
        "button, input[type=submit], a[href]",
      )) {
        const text = (
          el.textContent ||
          (el as HTMLInputElement).value ||
          ""
        ).trim();
        if (text) collector.push(el, el.tagName === "A" ? "link" : "button");
      }
      const alerts = [
        ...document.querySelectorAll(
          "[role=alert], .alert-danger, .invalid-feedback, .form-error, .error-message",
        ),
      ]
        .map((el) => collector.text((el.textContent || "").trim(), 200))
        .filter(Boolean)
        .slice(0, 4);
      const challenge = Boolean(
        document.querySelector(
          "iframe[src*='challenges.cloudflare.com'], iframe[src*='hcaptcha.com'], iframe[src*='recaptcha'], iframe[src*='turnstile'], div.cf-turnstile, div.h-captcha",
        ),
      );
      return {
        title: collector.text(document.title, 120),
        alerts,
        challenge,
        elements,
      };
    },
    [...privateValues]
      .flatMap((value) => [value, encodeURIComponent(value)])
      .sort((left, right) => right.length - left.length),
  );
  const url = new URL(page.url());
  return {
    path: url.origin,
    ...(raw as {
      title: string;
      alerts: string[];
      challenge: boolean;
      elements: SnapshotElement[];
    }),
  };
}

/**
 * Inference-driven ceremony. The interpreter chooses actions from a sanitized
 * snapshot; code substitutes secret values by role and keeps every guardrail.
 * Returns undefined so the caller can fall back to deterministic driving when
 * the interpreter is absent or cannot continue.
 */
async function driveInferred(
  page: Page,
  input: DriveInput,
): Promise<AuthorizationBrowserResult | undefined> {
  const interpret = input.interpreter;
  if (!interpret) return undefined;
  const timeoutMs = input.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  const event = (text: string) => input.onEvent?.(text);
  const failure = await loadProviderPage(page, input, timeoutMs);
  if (failure) return failure;
  const account = suppliedAccount(input.credentials);
  const goal = input.generateAccount ? "registration" : "sign-in";
  const history: Array<{ action: string; note?: string | undefined }> = [];
  const waitForCode = async (): Promise<string | undefined> => {
    if (!input.inbox || !input.provisionedEmail) return undefined;
    event("Waiting for the provider's verification email");
    const email = input.provisionedEmail;
    const since = input.provisionedAt ?? Date.now() - 120_000;
    const host = hostnameOf(page.url());
    const waitDeadline = Math.min(deadline, Date.now() + 240_000);
    const began = Date.now();
    let resent = false;
    while (Date.now() < waitDeadline) {
      const message = await input.inbox
        .latest(email, since)
        .catch(() => undefined);
      const found = message
        ? verificationFromMessage(message, host)
        : undefined;
      if (found?.code) {
        input.privateValues.add(found.code);
        return found.code;
      }
      if (found?.link) {
        rememberPrivateLink(input.privateValues, found.link);
        event("Opening the verification link from the agent inbox");
        await page
          .goto(found.link, {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          })
          .catch(() => {});
        if (input.progress) input.progress.verificationDone = true;
        return undefined;
      }
      if (!resent && Date.now() - began > 45_000) {
        const resend = page
          .locator(
            "a:has-text('Send Confirmation Email'), button:has-text('Send Confirmation Email'), a:has-text('Resend'), button:has-text('Resend'), a:has-text('resend the'), button:has-text('resend the')",
          )
          .first();
        if ((await resend.count()) > 0) {
          event("Asking the provider to resend the verification email");
          await resend.click().catch(() => {});
          resent = true;
        }
      }
      await page.waitForTimeout(3_000);
    }
    return undefined;
  };
  const roleValue = async (role: string): Promise<string | undefined> => {
    if (role === "email")
      return (
        input.provisionedEmail ??
        account?.email ??
        (account ? accountEmail(account.username) : undefined)
      );
    if (role === "username" && !input.generateAccount) return account?.username;
    if (role === "username" || role === "display-name")
      return account ? accountHandle(account.username) : undefined;
    if (role === "password" || role === "password-confirm")
      return account?.password;
    if (role === "verification-code") return waitForCode();
    return undefined;
  };
  const inspectPage = async (
    snapshot: PageSnapshot,
  ): Promise<AuthorizationBrowserResult | undefined> => {
    if (await requiresAuthenticator(page)) {
      event("The provider requires an authenticator in the user's browser");
      return { status: "blocked", reason: "passkey" };
    }
    if (
      snapshot.alerts.some((text) =>
        /already (?:in use|registered|taken)|(?:email|handle|username).{0,48}(?:in use|taken|registered)/i.test(
          text,
        ),
      )
    ) {
      event("Provider rejected the generated address as already in use");
      if (input.progress) input.progress.emailRejected = true;
      return {
        status: "blocked",
        reason: accountCollision(snapshot.alerts.join(" ")),
      };
    }
    if (snapshot.challenge) {
      event("The provider requires a human challenge (CAPTCHA)");
      return { status: "blocked", reason: "challenge" };
    }
    if (
      input.accountOnly &&
      input.progress?.submittedAccount &&
      (await authenticatedPage(page))
    )
      return { status: "credentials" };
  };
  const completedAccount = async (
    snapshot: PageSnapshot,
  ): Promise<AuthorizationBrowserResult | undefined> => {
    if (
      input.accountOnly &&
      account &&
      history.some((item) => /fill password/.test(item.action)) &&
      (await authenticatedPage(page)) &&
      !snapshot.elements.some(
        (element) =>
          element.kind === "input" ||
          (element.kind === "button" &&
            /authorize|allow|approve/i.test(element.text ?? "")),
      )
    ) {
      event("Provider accepted the account credentials");
      return { status: "credentials" };
    }
  };
  const fillTarget = async (
    target: Locator,
    role: NonNullable<InterpreterAction["role"]>,
  ): Promise<AuthorizationBrowserResult | undefined> => {
    if (role === "birth-date") {
      if (await target.inputValue()) return;
      await target.focus();
      return { status: "blocked", reason: "required-input" };
    }
    const value = await roleValue(role);
    if (value === undefined) {
      if (role === "verification-code") {
        if (input.progress?.verificationDone) return;
        event("No verification email arrived in time");
        return { status: "blocked", reason: "verification" };
      }
      if (role === "email" || role === "password" || role === "username")
        return { status: "blocked", reason: "session" };
      return;
    }
    input.privateValues.add(value);
    await target.fill(value);
    if (role === "verification-code" && input.progress)
      input.progress.verificationDone = true;
  };
  const applyAction = async (
    action: InterpreterAction,
    href: string,
  ): Promise<AuthorizationBrowserResult | undefined> => {
    if (action.action === "done")
      return { status: "blocked", reason: "no-form" };
    if (action.action === "blocked") {
      const reason = /captcha|challenge/i.test(action.note ?? "")
        ? "challenge"
        : (action.reason ?? "session");
      if (reason === "required-input") await focusRequiredInput(page);
      return { status: "blocked", reason };
    }
    if (action.action === "wait") {
      await page.waitForTimeout(2_000);
      return;
    }
    if (action.element === undefined) return;
    const target = page.locator(`[data-cmy-idx="${action.element}"]`).first();
    if ((await target.count()) === 0) return;
    try {
      if (action.action === "fill" && action.role) {
        return await fillTarget(target, action.role);
      } else if (action.action === "click") {
        if (
          (await target.evaluate((element) =>
            element.matches(
              "button[type=submit], button:not([type]), input[type=submit], input[type=image]",
            ),
          )) &&
          (await focusRequiredInput(page))
        )
          return { status: "blocked", reason: "required-input" };
        await target.click();
        await input.afterClick?.();
        if (
          input.progress &&
          history.some((item) => /fill password/.test(item.action))
        )
          input.progress.submittedAccount = true;
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        if (
          input.generateAccount &&
          /sign.?up|register|join|create/i.test(href) &&
          input.progress
        )
          input.progress.registrationSubmitted = true;
        const after = await snapshotPage(page, input.privateValues).catch(
          () => undefined,
        );
        if (after?.alerts.length)
          event("Provider reported an issue; review it in the private browser");
      } else if (action.action === "check") {
        if (!(await target.isChecked())) {
          await target.focus();
          return { status: "blocked", reason: "required-input" };
        }
      }
    } catch {
      /* Page transitioned mid-action; re-snapshot on the next step. */
    }
  };
  for (let step = 0; step < 24 && Date.now() < deadline; step += 1) {
    if (input.yieldTo?.()) return { status: "blocked", reason: windowTakeover };
    const href = page.url();
    if (
      !allowedAuthorizationOrigin(href, input.allowedOrigins, input.redirectUri)
    )
      return { status: "blocked", reason: "origin" };
    const url = new URL(href);
    if (
      originOf(href) === originOf(input.redirectUri) &&
      url.searchParams.has("code")
    ) {
      event("Captured the authorization callback");
      return { status: "callback", url: href };
    }
    const inspected = await snapshotPage(page, input.privateValues)
      .then(async (snapshot) => ({
        snapshot,
        outcome: await inspectPage(snapshot),
      }))
      .catch(() => undefined);
    if (!inspected) {
      await page
        .waitForLoadState("domcontentloaded", {
          timeout: Math.max(1, deadline - Date.now()),
        })
        .catch(() => {});
      continue;
    }
    const { snapshot, outcome } = inspected;
    if (outcome) return outcome;
    if (
      input.inbox &&
      input.provisionedEmail &&
      input.progress?.registrationSubmitted &&
      !input.progress.verificationDone &&
      !snapshot.elements.some((element) => element.kind === "input")
    ) {
      const placed = await roleValue("verification-code");
      if (!placed && !input.progress.verificationDone) {
        event("No verification email arrived in time");
        return { status: "blocked", reason: "verification" };
      }
      continue;
    }
    const completed = await completedAccount(snapshot);
    if (completed) return completed;
    const action = await interpret({ goal, snapshot, history });
    if (!action) {
      event("Interpreter unavailable; falling back to deterministic driving");
      return undefined;
    }
    history.push({
      action: action.role ? `${action.action} ${action.role}` : action.action,
      ...(action.note ? { note: action.note } : {}),
    });
    if (action.note) event(action.note);
    const result = await applyAction(action, href);
    if (result) return result;
  }
  event("Timed out waiting for the provider page");
  return { status: "blocked", reason: "timeout" };
}

export function createAuthorizationBrowser(
  options: BrowserOptions = {},
): AuthorizationBrowser {
  // Sessions are process-local: a page cannot outlive the process holding
  // its CDP connection. What survives a restart is the host's durable record
  // that a browser was pending, and a resume against a session this process
  // does not hold ends as `session-expired` rather than as a fresh attempt.
  const sessions = new Map<
    string,
    {
      page: Page;
      liveView?: LiveViewMinter | undefined;
      busy: boolean;
      allowed: () => boolean;
      resume: (
        input: AuthorizationBrowserInput,
      ) => Promise<AuthorizationBrowserResult>;
      close: () => Promise<void>;
      verified: () => void;
      privateValues: Set<string>;
    }
  >();
  return {
    async liveView(key) {
      const held = sessions.get(key);
      if (!held?.liveView || held.busy || !held.allowed()) return undefined;
      return held.liveView(held.page).catch(() => undefined);
    },
    async screenshot(key) {
      const held = sessions.get(key);
      if (!held || held.busy || !held.allowed()) return undefined;
      return held.page.screenshot({ type: "png" });
    },
    async interact(key, action) {
      const held = sessions.get(key);
      if (!held || held.busy || !held.allowed()) return false;
      held.busy = true;
      try {
        if ("code" in action) {
          held.privateValues.add(action.code);
          await held.page
            .locator(
              "input[autocomplete=one-time-code], input[name*=verification i], input[name*=otp i], input[name=code]",
            )
            .first()
            .fill(action.code);
          await held.page
            .locator("button[type=submit], input[type=submit]")
            .first()
            .click();
          held.verified();
        } else if ("x" in action) {
          await held.page.mouse.click(action.x, action.y);
        } else if ("text" in action) {
          held.privateValues.add(action.text);
          // Native date/tel inputs need fill; keyboard insertion loses date parts.
          const field = held.page.locator(
            "input:focus, textarea:focus, select:focus",
          );
          if (await field.count()) {
            if (
              await field.evaluate((element) => element.tagName === "SELECT")
            ) {
              const selected = await field.selectOption(
                { label: action.text },
                { timeout: 1000 },
              );
              for (const value of selected) held.privateValues.add(value);
            } else await field.fill(action.text);
          } else await held.page.keyboard.insertText(action.text);
        } else if ("key" in action) {
          await held.page.keyboard.press(action.key);
        }
        return true;
      } finally {
        held.busy = false;
      }
    },
    async close(key) {
      await sessions.get(key)?.close();
    },
    async complete(input) {
      if (input.sessionKey && sessions.has(input.sessionKey))
        return sessions.get(input.sessionKey)!.resume(input);
      if (input.resumeSession)
        return { status: "blocked", reason: "session-expired" };
      const popupOrigins = [
        ...new Set((input.popupOrigins ?? []).map(originOf)),
      ];
      if (
        popupOrigins.some(
          (origin) =>
            !origin ||
            !allowedAuthorizationOrigin(
              origin,
              input.allowedOrigins,
              input.redirectUri,
            ),
        )
      )
        return { status: "blocked", reason: "popup-undeclared" };
      let opened: Opened & Pick<BrowserOptions, "remoteProxy">;
      try {
        opened = await openBrowser(options);
      } catch {
        return { status: "blocked", reason: "browser-unavailable" };
      }
      let credentials: IsolatedAccount | undefined;
      let accountStored = false;
      let provisionedEmail: string | undefined;
      let provisionedAt = 0;
      let generatedUsername = false;
      const prepareAccount = async (): Promise<
        AuthorizationBrowserResult | undefined
      > => {
        try {
          credentials =
            suppliedAccount(input.credentials) ?? (await input.vault?.get());
        } catch {
          await opened.close().catch(() => {});
          return { status: "blocked", reason: "browser-unavailable" };
        }
        accountStored = Boolean(credentials?.password);
        if (input.generateAccount && !credentials?.password) {
          credentials = generateIsolatedAccount(input.preferredUsername);
          generatedUsername = credentials.username !== input.preferredUsername;
          if (input.inbox && !credentials.email) {
            try {
              provisionedEmail = await input.inbox.provision();
              provisionedAt = Date.now();
              credentials = { ...credentials, email: provisionedEmail };
              input.onEvent?.(
                "Provisioned a fresh email address from the agent inbox",
              );
            } catch {
              input.onEvent?.(
                "The agent inbox could not provision a fresh address",
              );
              await opened.close().catch(() => {});
              return { status: "blocked", reason: "inbox" };
            }
          }
        }
      };
      const preparationFailure = await prepareAccount();
      if (preparationFailure) return preparationFailure;
      // Auth pages may reveal codes and personal data. Never record them.
      const context = await opened.browser
        .newContext({
          serviceWorkers: "block",
          ...(opened.remoteProxy
            ? { proxy: { ...opened.remoteProxy, bypass: "<-loopback>" } }
            : {}),
        })
        .catch(() => undefined);
      if (!context) {
        await opened.close().catch(() => {});
        return { status: "blocked", reason: "browser-unavailable" };
      }
      // Every close below goes through here, so none of them can release a
      // popup request that is still paused. See `stopWindows`.
      let windows: { idle: boolean; stop(): Promise<void> } | undefined;
      const closeContext = async () => {
        // Nothing to stop is the ordinary case, and it closes at once.
        if (!windows || windows.idle) return context.close();
        const stopping = windows;
        let bound: ReturnType<typeof setTimeout> | undefined;
        // Bounded: a browser that stopped answering must still be closed.
        await Promise.race([
          stopping.stop().catch(() => {}),
          new Promise<void>((resolve) => {
            bound = setTimeout(resolve, 5_000);
            bound.unref();
          }),
        ]);
        clearTimeout(bound);
        await context.close();
      };
      const privateValues = new Set<string>();
      let originBlocked = false;
      let popupBlocked = false;
      let submissionUncertain = false;
      const submittedRequests = new Set<string>();
      let stagedAccount: IsolatedAccount | undefined;
      let page: Page;
      let hasUnexpectedPage: () => Promise<boolean>;
      /**
       * Windows the page opened, when this authorization declared any. The
       * rule for adopting one is the login driver's own tracker; what is
       * added here is what the executor enforces around it - the document
       * origin guard on each window's redirect hops, the replay guard on its
       * submissions, and the final target inspection.
       */
      let tracker: ReturnType<typeof createWindowTracker<Page>> | undefined;
      /** A window was announced, requested or reported and is not settled. */
      let windowPending = false;
      /** CDP targets of windows whose documents are guarded here. */
      const admitted = new Set<string>();
      /** Each reported window's guard, awaited before it is ever driven. */
      const guards = new Map<Page, Promise<boolean>>();
      /** Windows whose document guard is in place. */
      const guarded = new Set<Page>();
      let guardWindow: (window: Page) => Promise<boolean> = async () => false;
      try {
        // Observe an explicit WebAuthn request without reading credentials or replacing its result.
        // Conditional/autofill availability checks are not a request for human takeover.
        await context.addInitScript(() => {
          if (!navigator.credentials) return;
          const get = navigator.credentials.get.bind(navigator.credentials);
          navigator.credentials.get = (options) => {
            if (
              options &&
              "publicKey" in options &&
              options.mediation !== "conditional"
            )
              Reflect.set(window, "__ceremonyAuthenticatorRequested", true);
            return get(options);
          };
        });
        page = await context.newPage();
        if (popupOrigins.length > 0)
          tracker = createWindowTracker<Page>(page as unknown as WindowOpener, {
            popupOrigins,
            onWindow: (window) => {
              windowPending = true;
              guards.set(
                window,
                guardWindow(window).catch(() => false),
              );
            },
          });
        // Playwright routing skips redirect hops. The isolated Chromium engine's
        // network boundary checks every top-level hop before it sends a request;
        // CAPTCHA subframes are not top-level credential destinations.
        // A window the page opens is refused here before its first request,
        // unless the authorization declared its origin; then its top-level
        // requests are held to the same replay guard as the page's own.
        await context.route("**/*", async (route) => {
          try {
            const request = route.request();
            // Popup navigation can arrive before Playwright has created its frame.
            const frame = (() => {
              try {
                return request.frame();
              } catch {
                return undefined;
              }
            })();
            const topLevel = !frame || !frame.parentFrame();
            const foreign =
              request.isNavigationRequest() &&
              (!frame || (!frame.parentFrame() && frame.page() !== page));
            const privateIn = (text: string) =>
              [...privateValues].filter(
                (value) =>
                  value &&
                  [
                    value,
                    encodeURIComponent(value),
                    JSON.stringify(value).slice(1, -1),
                    new URLSearchParams({ v: value }).toString().slice(2),
                  ].some((encoded) => text.includes(encoded)),
              );
            /**
             * A window's redirect hops are visible only to a guard attached to
             * that window, and one can be attached only once Playwright has
             * reported the window - by which time its first request is already
             * on its way. A late guard does not see that request's redirects
             * (a 307 carries a POST body on to wherever it points), so until a
             * window is guarded it may only load: a bare GET or HEAD with no
             * private value in its URL. Anything else - a form submitted into
             * a new window, credentials in a query - is refused before it is
             * sent, whatever origin it names.
             */
            const unguarded =
              foreign &&
              !(frame && guarded.has(frame.page())) &&
              (!["GET", "HEAD"].includes(request.method()) ||
                privateIn(request.url()).length > 0);
            if (
              foreign &&
              (unguarded ||
                !(tracker && popupOrigins.includes(originOf(request.url()))))
            ) {
              popupBlocked = true;
              await route.abort("blockedbyclient");
              await closeContext();
            } else {
              if (foreign) windowPending = true;
              const body = request.postData();
              const values = body ? privateIn(body) : [];
              if (
                (frame === page.mainFrame() || (tracker && topLevel)) &&
                !["GET", "HEAD"].includes(request.method()) &&
                (request.isNavigationRequest() || values.length)
              ) {
                // Consume before forwarding. Neither model retries nor a driver
                // fallback can establish whether the first effect succeeded.
                const url = new URL(request.url());
                // A new nonce/boundary is not progress. New private input (such
                // as an inbox code) or a different endpoint is a distinct step.
                // ponytail: opaque/encrypted bodies need provider outcome reconciliation.
                const identity =
                  input.generateAccount &&
                  credentials?.password &&
                  values.includes(credentials.password)
                    ? [
                        request.method(),
                        url.origin,
                        url.pathname,
                        values.sort(),
                      ]
                    : [request.method(), request.url(), body];
                const fingerprint = createHash("sha256")
                  .update(JSON.stringify(identity))
                  .digest("hex");
                if (submittedRequests.has(fingerprint)) {
                  submissionUncertain = true;
                  await route.abort("blockedbyclient");
                  await closeContext();
                  return;
                }
                submittedRequests.add(fingerprint);
                // Journal immediately before the first possible credential
                // effect, not when loading a page or collecting missing input.
                if (
                  input.generateAccount &&
                  !accountStored &&
                  credentials &&
                  stagedAccount !== credentials
                ) {
                  await input.vault?.stage?.(credentials);
                  stagedAccount = credentials;
                }
              }
              await route.continue();
            }
          } catch {
            // Decide the request before tearing down: a request left paused
            // is continued by the browser when the context closes, which here
            // would send exactly the submission the failure was about - a
            // registration whose journal entry could not be written.
            await route.abort("blockedbyclient").catch(() => {});
            await closeContext().catch(() => {});
          }
        });
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        if (!targetInfo.browserContextId)
          throw new Error("Isolated browser context is unavailable");
        const watched = await watchForeignWindows(session, targetInfo);
        windows = watched;
        hasUnexpectedPage = async () => {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            const { targetInfos } = await Promise.race([
              session.send("Target.getTargets"),
              new Promise<never>((_, reject) => {
                deadline = setTimeout(
                  () =>
                    reject(new Error("Browser target inspection timed out")),
                  5000,
                );
                deadline.unref();
              }),
            ]);
            return targetInfos.some(
              (target) =>
                target.type === "page" &&
                target.browserContextId === targetInfo.browserContextId &&
                target.targetId !== targetInfo.targetId &&
                // A declared window, guarded here, at a declared origin.
                !(
                  admitted.has(target.targetId) &&
                  popupOrigins.includes(originOf(target.url))
                ),
            );
          } finally {
            clearTimeout(deadline);
          }
        };
        // Observe creation before the popup's first network event. A fast
        // interpreter can otherwise finish on the unchanged opener too early.
        session.on("Page.windowOpen", ({ url }) => {
          watched.expect();
          // A declared window starts blank or at its declared origin; which
          // document it ends up in is decided again at every read.
          if (
            tracker &&
            (!url ||
              url === "about:blank" ||
              popupOrigins.includes(originOf(url)))
          ) {
            windowPending = true;
            return;
          }
          popupBlocked = true;
          void closeContext().catch(() => {});
        });
        await session.send("Page.enable");
        const { frameTree } = await session.send("Page.getFrameTree");
        /**
         * Every top-level document hop - redirects included, which Playwright
         * routing never sees - is checked against the authorization's
         * origins before it is sent. The page gets this at setup; a declared
         * window gets it when it is reported, before anything reads it.
         */
        const guardDocuments = async (cdp: CDPSession, frameId: string) => {
          cdp.on("Fetch.requestPaused", async (request) => {
            try {
              if (
                request.frameId === frameId &&
                !allowedAuthorizationOrigin(
                  request.request.url,
                  input.allowedOrigins,
                  input.redirectUri,
                )
              ) {
                originBlocked = true;
                await cdp.send("Fetch.failRequest", {
                  requestId: request.requestId,
                  errorReason: "BlockedByClient",
                });
                await closeContext();
              } else {
                await cdp.send("Fetch.continueRequest", {
                  requestId: request.requestId,
                });
              }
            } catch {
              // As above: fail it rather than leave it for teardown to continue.
              await cdp
                .send("Fetch.failRequest", {
                  requestId: request.requestId,
                  errorReason: "BlockedByClient",
                })
                .catch(() => {});
              await closeContext().catch(() => {});
            }
          });
          await cdp.send("Fetch.enable", {
            patterns: [{ resourceType: "Document", requestStage: "Request" }],
          });
        };
        await guardDocuments(session, frameTree.frame.id);
        guardWindow = async (window) => {
          const cdp = await context.newCDPSession(window);
          const { targetInfo: opened } = await cdp.send("Target.getTargetInfo");
          if (opened.browserContextId !== targetInfo.browserContextId)
            return false;
          await cdp.send("Page.enable");
          const { frameTree: tree } = await cdp.send("Page.getFrameTree");
          await guardDocuments(cdp, tree.frame.id);
          admitted.add(opened.targetId);
          guarded.add(window);
          return true;
        };
      } catch {
        await closeContext().catch(() => {});
        await opened.close().catch(() => {});
        return { status: "blocked", reason: "browser-unavailable" };
      }
      const urls = input.startUrls?.length ? input.startUrls : [input.startUrl];
      const full = input.timeoutMs ?? 45_000;
      const progress = {
        registrationSubmitted: false,
        emailRejected: false,
        verificationDone: false,
        rejected: false,
        submittedAccount: false,
      };
      let last: AuthorizationBrowserResult = {
        status: "blocked",
        reason: "timeout",
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const close = async () => {
        if (timer) clearTimeout(timer);
        if (input.sessionKey) sessions.delete(input.sessionKey);
        await closeContext().catch(() => {});
        await opened.close().catch(() => {});
      };
      const finish = async () => {
        // A model can finish before popup network notifications are dispatched.
        // Inspect native targets before publishing either a result or credentials.
        if (
          !originBlocked &&
          !popupBlocked &&
          !submissionUncertain &&
          (await hasUnexpectedPage())
        )
          popupBlocked = true;
        if (originBlocked) last = { status: "blocked", reason: "origin" };
        else if (popupBlocked) last = { status: "blocked", reason: "popup" };
        else if (submissionUncertain)
          last = { status: "blocked", reason: "submission-uncertain" };
        if (last.status !== "blocked" && credentials?.password && input.vault) {
          await input.vault.put(credentials);
          accountStored = true;
        }
        if (
          last.status === "blocked" &&
          input.sessionKey &&
          ![
            "origin",
            "popup",
            "submission-uncertain",
            "email-in-use",
            "username-in-use",
            "rejected",
            "missing",
            "unreachable",
            "no-form",
          ].includes(last.reason)
        ) {
          if (!timer) {
            timer = setTimeout(() => {
              void close();
            }, 10 * 60_000);
            timer.unref();
          }
          return { ...last, sessionPending: true };
        }
        await close();
        return {
          ...last,
          ...(accountStored ? { accountStored: true } : {}),
        };
      };
      const driveOn = async (on: Page, attempt: DriveInput) =>
        (await driveInferred(on, {
          ...attempt,
          ...(options.interpreter ? { interpreter: options.interpreter } : {}),
        })) ??
        (await drive(on, {
          ...attempt,
          ...(options.interpreter ? { resume: true } : {}),
        }));
      /**
       * Drive the page, and the declared window it opens when it opens one.
       *
       * The drive itself stays single-document; this is where the document
       * changes. Before every step it asks whether a window has taken over
       * (or, inside a window, whether the window is still the one the rule
       * picks) and, when it has, settles the window, re-resolves under the
       * shared rule and carries on in the document that rule names - the
       * window while it is open, the page once it has closed. An undeclared
       * or second window refuses as `popup`, exactly as an unadmitted one
       * always has. Never used when no window was declared.
       */
      const runDrive = async (attempt: DriveInput) => {
        for (const value of Object.values(attempt.credentials ?? {}))
          privateValues.add(value);
        const windows = tracker;
        if (!windows) return driveOn(page, attempt);
        const deadline = Date.now() + (attempt.timeoutMs ?? 45_000);
        const chosen = () => {
          try {
            return windows.current() ?? page;
          } catch {
            return undefined;
          }
        };
        let on = page;
        let resume = attempt.resume;
        for (let hop = 0; hop < 8; hop += 1) {
          const current = on;
          let result: AuthorizationBrowserResult;
          try {
            result = await driveOn(current, {
              ...attempt,
              ...(resume ? { resume: true } : {}),
              timeoutMs: Math.max(1, deadline - Date.now()),
              yieldTo: () =>
                current.isClosed() ||
                (current === page && windowPending) ||
                chosen() !== current,
              afterClick: () => windows.settle(true),
            });
          } catch (error) {
            // A window that closed under the step acting in it has done its
            // job; anything else is the drive's own failure.
            if (current === page || !current.isClosed()) throw error;
            result = { status: "blocked", reason: windowTakeover };
          }
          held.page = current;
          if (result.status !== "blocked" || result.reason !== windowTakeover)
            return result;
          await windows.settle(windowPending);
          windowPending = false;
          const next = chosen();
          if (!next || (next !== page && !(await guards.get(next)))) {
            popupBlocked = true;
            return { status: "blocked" as const, reason: "popup" };
          }
          on = next;
          resume = true;
        }
        popupBlocked = true;
        return { status: "blocked" as const, reason: "popup" };
      };
      const held = {
        page,
        liveView: opened.liveView,
        privateValues,
        busy: true,
        allowed: () =>
          allowedAuthorizationOrigin(
            held.page.url(),
            input.allowedOrigins,
            input.redirectUri,
          ),
        close,
        verified: () => {
          progress.verificationDone = true;
        },
        resume: async (next: AuthorizationBrowserInput) => {
          if (held.busy)
            return {
              status: "blocked" as const,
              reason: "busy",
              sessionPending: true,
            };
          held.busy = true;
          if (next.credentials?.password)
            credentials = {
              username: next.credentials.username ?? "",
              password: next.credentials.password,
            };
          try {
            last = await runDrive({
              ...input,
              privateValues,
              resume: true,
              ...(credentials ? { credentials } : {}),
              ...(provisionedEmail ? { provisionedEmail, provisionedAt } : {}),
              progress,
            });
            return await finish();
          } catch {
            await close();
            return {
              status: "blocked" as const,
              reason: originBlocked
                ? "origin"
                : popupBlocked
                  ? "popup"
                  : submissionUncertain
                    ? "submission-uncertain"
                    : "session-expired",
            };
          } finally {
            held.busy = false;
          }
        },
      };
      if (input.sessionKey) sessions.set(input.sessionKey, held);
      const runAttempts = async () => {
        for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
          for (const [index, startUrl] of urls.entries()) {
            input.onEvent?.("Trying the provider sign-in page");
            const attempt: DriveInput = {
              ...input,
              privateValues,
              startUrl,
              timeoutMs: input.generateAccount
                ? full
                : index === urls.length - 1
                  ? full
                  : Math.min(20_000, full),
              ...(credentials ? { credentials } : {}),
              ...(provisionedEmail ? { provisionedEmail, provisionedAt } : {}),
              progress,
            };
            last = await runDrive(attempt);
            if (last.status !== "blocked") break;
            if (
              progress.submittedAccount ||
              !["missing", "unreachable", "no-form"].includes(last.reason)
            )
              break;
          }
          if (
            attemptNumber === 0 &&
            input.generateAccount &&
            generatedUsername &&
            last.status === "blocked" &&
            last.reason === "username-in-use"
          ) {
            credentials = {
              ...generateIsolatedAccount(),
              ...(credentials?.email ? { email: credentials.email } : {}),
            };
            progress.registrationSubmitted = false;
            progress.emailRejected = false;
            progress.verificationDone = false;
            progress.rejected = false;
            progress.submittedAccount = false;
            input.onEvent?.(
              "Generated username was unavailable; retrying once with a new generated username",
            );
            continue;
          }
          if (
            attemptNumber === 0 &&
            last.status === "blocked" &&
            last.reason === "unreachable" &&
            !progress.submittedAccount
          ) {
            input.onEvent?.(
              "Provider temporarily unavailable; retrying once before requesting human help",
            );
            await page.waitForTimeout(250);
            continue;
          }
          break;
        }
      };
      try {
        await runAttempts();
        return await finish();
      } catch {
        await close();
        return {
          status: "blocked",
          reason: originBlocked
            ? "origin"
            : popupBlocked
              ? "popup"
              : submissionUncertain
                ? "submission-uncertain"
                : progress.submittedAccount
                  ? "session-expired"
                  : "browser-unavailable",
        };
      } finally {
        held.busy = false;
      }
    },
  };
}
