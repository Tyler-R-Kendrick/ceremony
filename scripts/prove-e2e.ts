import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { chromium } from "playwright-core";
import { createHostedRuntime } from "../src/server/hosted/runtime.js";
import { hostedHttp } from "../src/server/hosted/http.js";
import { postgresFixture } from "../tests/fixtures/postgres.js";

/**
 * Proof of the full flow against the real identity provider.
 *
 * What runs: the hosted runtime this repository deploys, locally, configured
 * against the project's real Supabase Auth (an OAuth 2.1 / OIDC issuer), with
 * an OAuth client registered on it for this origin. What is done to it: an
 * account is created on that provider, the ceremony's own sign-in is started,
 * the provider's consent is approved by that account's session — the same
 * request the hosted consent page makes — the callback exchanges the code and
 * validates the ID token, and the signed-in session then starts a real GitHub
 * ceremony in the real UI, in a real browser, up to the handoff GitHub owns.
 *
 * Nothing is stubbed. The one leg not driven is the consent page's own HTML,
 * because the browser in this sandbox cannot reach external hosts; the API
 * that page calls is exercised directly instead, with a real session.
 */

const ORIGIN = "http://127.0.0.1:4270";
const OUT = "/tmp/ceremony-proof";

// This proof reads NO credentials from the environment. The provider is given
// on the command line as the public configuration a developer already ships in
// a browser client: the project URL and the publishable (anon) key. There is
// no process.env fallback and no hardcoded client — run it with real public
// values or not at all.
const required = (name: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit ? hit.slice(name.length + 3) : "";
  if (!value) {
    console.error(
      "Usage: prove-e2e --supabase-url=https://<ref>.supabase.co --anon-key=sb_publishable_...\n" +
        "No environment credentials are read; pass the provider's public URL and publishable key.",
    );
    process.exit(2);
  }
  return value;
};
const SUPABASE = required("supabase-url");
const PUBLISHABLE = required("anon-key");
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
const log = (step: string, detail: unknown) => {
  console.log(`\n▶ ${step}`);
  if (detail !== undefined)
    console.log(
      "  ",
      typeof detail === "string" ? detail : JSON.stringify(detail),
    );
  report[step] = detail;
};

/** Supabase Auth on this project has been answering 504s intermittently. */
async function retry<T>(
  what: string,
  fn: () => Promise<T>,
  attempts = 8,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      console.log(
        `   ${what}: attempt ${i} failed (${String((error as Error).message).slice(0, 80)}); retrying`,
      );
      await new Promise((r) => setTimeout(r, 6000 * i));
    }
  }
  throw last;
}
async function supabase(
  path: string,
  init: RequestInit & { jwt?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("apikey", PUBLISHABLE);
  if (init.jwt) headers.set("authorization", `Bearer ${init.jwt}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${SUPABASE}/auth/v1${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  if (response.status >= 500)
    throw new Error(`${response.status} from Supabase: ${text.slice(0, 80)}`);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// 1a. The ceremony registers its OWN OAuth client with the provider. No client
// is pre-provisioned or hardcoded. On a provider that advertises RFC 7591 in
// its discovery document, createOidcIdentity registers the client itself when
// none is configured; Supabase keeps registration off discovery, so the proof
// performs the same registration against the documented endpoint and hands the
// resulting id — the ceremony's own, freshly minted — to the runtime.
const CLIENT_ID = await retry(
  "register the ceremony's own OAuth client",
  async () => {
    const r = await supabase("/oauth/clients/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "Ceremony e2e proof (local)",
        redirect_uris: [`${ORIGIN}/api/auth/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (r.status >= 300 || !r.body?.client_id)
      throw new Error(
        `register ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`,
      );
    return r.body.client_id as string;
  },
);
log("registered the ceremony's own OAuth client", {
  clientId: `${CLIENT_ID.slice(0, 8)}…`,
  note: "dynamically registered against the provider, not pre-provisioned",
});

// 1b. Real infrastructure: an isolated PostgreSQL, and the runtime this repo ships.
const database = await postgresFixture();
const cfg = database.config;
const runtime = await retry(
  "hosted runtime (OIDC discovery against Supabase)",
  () =>
    createHostedRuntime({
      NODE_ENV: "test",
      CEREMONY_TEST_PROFILE: "true",
      CEREMONY_PUBLIC_ORIGIN: ORIGIN,
      CEREMONY_DATABASE_URL: `postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}`,
      CEREMONY_VAULT_KEY: randomBytes(32).toString("hex"),
      CEREMONY_VAULT_KEY_ID: "proof",
      CEREMONY_OIDC_ISSUER: `${SUPABASE}/auth/v1`,
      CEREMONY_OIDC_CLIENT_ID: CLIENT_ID,
      CEREMONY_TENANT_ID: "ceremony-proof",
      CEREMONY_GITHUB_ACCOUNT: "Tyler-R-Kendrick",
      CEREMONY_CONFIGURATION_VERSION: "v1",
    }),
);
log("runtime", {
  origin: ORIGIN,
  issuer: `${SUPABASE}/auth/v1`,
  connectors: runtime.connectors,
});

// 2. The app, served the way the deployment serves it: static shell + /api → hostedHttp.
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", ORIGIN);
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/.well-known/")
  ) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const withBody = !["GET", "HEAD"].includes(req.method ?? "GET");
    const request = new Request(url, {
      method: req.method ?? "GET",
      headers,
      ...(withBody
        ? ({
            body: Readable.toWeb(req) as unknown as ReadableStream,
            duplex: "half",
          } as RequestInit)
        : {}),
    });
    const response = await hostedHttp(request, runtime, async () => {});
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((v, k) => {
      if (k !== "set-cookie") out[k] = v;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  let file = join(
    "web-dist",
    url.pathname === "/" ? "index.html" : url.pathname,
  );
  if (!existsSync(file)) file = join("web-dist", "index.html");
  res.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
  });
  res.end(readFileSync(file));
}
const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    res.writeHead(500);
    res.end(String(e));
  });
});
await new Promise<void>((r) => server.listen(4270, "127.0.0.1", r));

try {
  // 3. "Generate an account if the user doesn't have one": a real account on the real provider.
  const email = `ceremony-e2e-${Date.now()}@example.com`;
  const password = `Pr0of-${randomBytes(9).toString("base64url")}`;
  const signup = await retry("sign-up on Supabase", async () => {
    const r = await supabase("/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (r.status !== 200 || !r.body?.access_token)
      throw new Error(
        `signup ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`,
      );
    return r.body;
  });
  log("account created on Supabase Auth", {
    email,
    userId: signup.user.id,
    confirmed: Boolean(signup.user.email_confirmed_at),
    isAnonymous: signup.user.is_anonymous,
  });
  const userJwt: string = signup.access_token;

  // 4. The ceremony's own sign-in: what the UI's "Sign in" button does.
  const begun = await fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: "{}",
  });
  const loginCookie = begun.headers.getSetCookie()[0]!.split(";")[0]!;
  const { authorizationUrl } = (await begun.json()) as {
    authorizationUrl: string;
  };
  const authz = new URL(authorizationUrl);
  log("ceremony sign-in started", {
    status: begun.status,
    authorizeEndpoint: authz.origin + authz.pathname,
    params: Object.fromEntries(
      [...authz.searchParams].map(([k, v]) => [
        k,
        k === "state" || k === "nonce" || k === "code_challenge"
          ? `${v.slice(0, 6)}…`
          : v,
      ]),
    ),
  });

  // 5. The provider sends the person to its consent page — exactly as a browser would be sent.
  const consentHop = await retry("authorize → consent page", async () => {
    const r = await fetch(authorizationUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(45_000),
    });
    if (r.status >= 500) throw new Error(`${r.status}`);
    return r;
  });
  const consentUrl = consentHop.headers.get("location") ?? "";
  const authorizationId =
    new URL(consentUrl).searchParams.get("authorization_id") ?? "";
  log("provider redirected to its consent page", {
    status: consentHop.status,
    consentPage: consentUrl.split("?")[0],
    authorizationId: `${authorizationId.slice(0, 6)}…`,
  });
  if (!authorizationId)
    throw new Error(
      `no authorization_id in ${consentUrl.slice(0, 200)} (status ${consentHop.status}); body: ${(await consentHop.text()).slice(0, 200)}`,
    );

  // 6. What the consent page shows, and the approval it submits — same API, same session.
  const details = await retry("consent details", async () => {
    const r = await supabase(`/oauth/authorizations/${authorizationId}`, {
      jwt: userJwt,
    });
    if (r.status !== 200)
      throw new Error(
        `details ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`,
      );
    return r.body;
  });
  log("consent page details (what the person is asked)", {
    client: details.client?.name,
    scope: details.scope,
    redirectUri: details.redirect_uri,
  });
  const approved = await retry("approve consent", async () => {
    const r = await supabase(
      `/oauth/authorizations/${authorizationId}/consent`,
      {
        method: "POST",
        jwt: userJwt,
        body: JSON.stringify({ action: "approve" }),
      },
    );
    if (r.status !== 200 || !r.body?.redirect_url)
      throw new Error(
        `consent ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`,
      );
    return r.body;
  });
  const back = new URL(approved.redirect_url);
  log("consent approved by that account", {
    returnsTo: back.origin + back.pathname,
    hasCode: back.searchParams.has("code"),
    hasState: back.searchParams.has("state"),
  });

  // 7. The callback: the ceremony server exchanges the code with Supabase and validates the ID token.
  const callback = await retry(
    "OIDC callback (code exchange + ID token validation)",
    async () => {
      const r = await fetch(approved.redirect_url, {
        redirect: "manual",
        headers: { cookie: loginCookie },
      });
      if (r.status >= 500)
        throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
      return r;
    },
  );
  const sessionCookie = callback.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith("ceremony_session="));
  log("callback completed", {
    status: callback.status,
    redirectedTo: callback.headers.get("location"),
    sessionCookieSet: Boolean(sessionCookie),
  });
  if (!sessionCookie)
    throw new Error(
      `no session cookie; body: ${(await callback.text()).slice(0, 300)}`,
    );

  const caps = await (
    await fetch(`${ORIGIN}/api/v1/teaching/capabilities`, {
      headers: { cookie: sessionCookie },
    })
  ).json();
  log("signed-in session, as the app sees it", caps);

  // 8. The real UI, in a real browser, with that session: start the GitHub ceremony.
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
  });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
  });
  await context.addCookies([
    {
      name: "ceremony_session",
      value: sessionCookie.split("=")[1]!,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${ORIGIN}/?connector=github`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  const connectButton = page.getByRole("button", { name: /^Connect GitHub$/ });
  await connectButton.waitFor({ timeout: 30_000 });
  await page.screenshot({
    path: `${OUT}/1-signed-in-connect.png`,
    fullPage: true,
  });
  log("UI: signed in, ready to connect", {
    heading: (await page.locator("h2").first().textContent())?.trim(),
    buttons: (await page.locator("button").allTextContents())
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12),
  });
  await connectButton.click();
  const humanLink = page.getByRole("link", { name: /Continue with GitHub/ });
  const outcome = await Promise.race([
    humanLink.waitFor({ timeout: 60_000 }).then(() => "awaiting-human"),
    page
      .locator("[role=alert]")
      .first()
      .waitFor({ timeout: 60_000 })
      .then(() => "alert"),
  ]).catch(() => "neither");
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: `${OUT}/2-github-ceremony.png`,
    fullPage: true,
  });
  log("UI after Connect GitHub", {
    outcome,
    status: (await page.locator("[role=status]").allTextContents())
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 6),
    alerts: (await page.locator("[role=alert]").allTextContents())
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 4),
    humanHref:
      outcome === "awaiting-human"
        ? await humanLink.getAttribute("href")
        : null,
    pageErrors: pageErrors.slice(0, 3),
  });

  // 9. Where that handoff goes: the page the human link serves, and the GitHub URL it posts to.
  if (outcome === "awaiting-human") {
    const href = (await humanLink.getAttribute("href"))!;
    const human = await fetch(`${ORIGIN}${href}`, {
      headers: { cookie: sessionCookie },
      redirect: "manual",
    });
    const html = await human.text();
    const action =
      html.match(/action="([^"]+)"/)?.[1] ??
      human.headers.get("location") ??
      "";
    log("the handoff GitHub owns", {
      status: human.status,
      githubUrl: action.replace(/&amp;/g, "&").slice(0, 160),
      containsManifest: html.includes('name="manifest"'),
    });
  }
  await browser.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`\n✔ report: ${OUT}/report.json`);
} finally {
  server.close();
  await database.close();
}
