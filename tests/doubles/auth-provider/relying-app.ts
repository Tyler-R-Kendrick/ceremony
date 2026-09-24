import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMarkup } from "./markup.js";
import type { RealisticLayout } from "./layouts.js";

/**
 * A second provider that signs people in *with* the first: the relying-app
 * half of "create an OAuth app at provider A, then use it at provider B".
 *
 * This is the most common real shape of that chain. A workspace, a CI
 * service or a wiki offers "Sign in with <identity provider>"; an admin
 * registers an OAuth app at the identity provider, pastes the client ID and
 * secret into the app's admin settings, and from then on people sign in
 * through the identity provider's consent screen. Everything here is a local
 * fixture over real HTTP, and the identity provider is the auth provider
 * double with `strictClients` on, so nothing is accepted on trust:
 *
 * - The admin API (`PUT /api/admin/sign-in-providers/idp`) checks a client ID
 *   and secret *against the identity provider* before saving them, by
 *   authenticating to its RFC 7662 introspection endpoint as that client. A
 *   pair the provider does not know is refused and nothing is saved. The
 *   response never contains the secret.
 * - "Continue with …" runs authorization code with PKCE and `state` bound to
 *   the browser, to the identity provider's `/authorize` with this app's
 *   exact callback URL; a callback registered differently is refused there.
 * - The callback redeems the code at the identity provider's token endpoint
 *   with `client_secret_basic`, reads the person at `userinfo` with the access
 *   token, and only then opens a session.
 *
 * Pages use a realistic layout's shell, so a recording or a screenshot shows
 * a plausible product, and the button names the identity provider the way
 * real ones do.
 */

export type RelyingApp = {
  origin: string;
  /** The product name people see, and the app name registered at the IdP. */
  name: string;
  homepageUrl: string;
  /** The exact redirect URI this app sends to the identity provider. */
  callbackUrl: string;
  /** Held by the connector host, never by a model: the admin API bearer. */
  adminToken: string;
  /** The saved integration, without its secret. */
  integration(): { clientId: string } | undefined;
  /** Accounts that finished signing in through the identity provider. */
  signIns(): readonly string[];
  /** Every client ID the admin API refused, for negative assertions. */
  refusedClients(): readonly string[];
  close(): Promise<void>;
};

export type RelyingAppOptions = {
  /** The identity provider's issuer: its origin, with OIDC discovery. */
  issuer: string;
  /** How the identity provider is named on the sign-in button. */
  issuerName: string;
  layout?: RealisticLayout;
};

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(
    `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`,
  ).toString("base64")}`;

export async function startRelyingApp(
  options: RelyingAppOptions,
): Promise<RelyingApp> {
  const markup = createMarkup(1, options.layout ?? "split-panel");
  const adminToken = `adm_${randomBytes(16).toString("hex")}`;
  let integration: { clientId: string; clientSecret: string } | undefined;
  /** A sign-in in flight, keyed by `state`, bound to the browser that began it. */
  const pending = new Map<string, { verifier: string; browser: string }>();
  const sessions = new Map<string, string>();
  const signIns: string[] = [];
  const refused: string[] = [];

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.writeHead(500, { "content-type": "text/html" });
      response.end(markup.page("Error", "<h1>Something went wrong</h1>"));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const callbackUrl = `${origin}/auth/idp/callback`;
  const name = markup.headings.signIn.replace(/^Sign in to /, "");

  /** The identity provider's endpoints, as it publishes them. */
  const discover = async () =>
    (await (
      await fetch(`${options.issuer}/.well-known/openid-configuration`)
    ).json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      userinfo_endpoint: string;
      introspection_endpoint?: string;
    };

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    const raw = method === "GET" ? "" : await readText(request);
    const send = (
      status: number,
      html: string,
      headers: Record<string, string | string[]> = {},
    ) => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        ...headers,
      });
      response.end(html);
    };
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const redirect = (
      location: string,
      headers: Record<string, string | string[]> = {},
    ) => {
      response.writeHead(302, { location, ...headers });
      response.end();
    };
    const browser = cookies(request)["gbid"];

    const loginPage = (error?: string, status = 200) =>
      send(
        status,
        markup.page(
          "Sign in",
          `<h1>Sign in to ${markup.escape(name)}</h1>
           <p class="subtitle">Use your ${markup.escape(options.issuerName)} account to continue.</p>
           ${markup.alert(
             error ??
               (integration
                 ? undefined
                 : `Signing in with ${options.issuerName} has not been set up for this workspace yet.`),
           )}
           ${
             integration
               ? `<form method="post" action="/auth/idp"><button type="submit" class="btn btn-primary btn-block">Continue with ${markup.escape(options.issuerName)}</button></form>`
               : ""
           }`,
        ),
      );

    // The admin API a connector's server-side step calls. The bearer is the
    // host's, and what it saves is checked with the identity provider first.
    if (url.pathname === "/api/admin/sign-in-providers/idp") {
      const bearer = /^bearer\s+(.+)$/i.exec(
        request.headers.authorization ?? "",
      )?.[1];
      const expected = Buffer.from(adminToken);
      const given = Buffer.from(bearer ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        return json(401, { error: "unauthorized" });
      if (method === "GET")
        return json(
          200,
          integration
            ? { configured: true, client_id: integration.clientId }
            : { configured: false },
        );
      if (method !== "PUT") return json(405, { error: "method_not_allowed" });
      let submitted: { client_id?: unknown; client_secret?: unknown };
      try {
        submitted = JSON.parse(raw) as typeof submitted;
      } catch {
        return json(400, { error: "invalid_request" });
      }
      const clientId =
        typeof submitted.client_id === "string" ? submitted.client_id : "";
      const clientSecret =
        typeof submitted.client_secret === "string"
          ? submitted.client_secret
          : "";
      if (!clientId || !clientSecret)
        return json(400, { error: "invalid_request" });
      // A made-up token, introspected *as the client*: the provider answers
      // 401 to a client it does not know or a secret that is wrong, and
      // `active: false` to one it accepts.
      const endpoints = await discover();
      const probe = endpoints.introspection_endpoint
        ? await fetch(endpoints.introspection_endpoint, {
            method: "POST",
            headers: {
              authorization: basic(clientId, clientSecret),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              token: `probe_${randomBytes(8).toString("hex")}`,
            }).toString(),
          })
        : undefined;
      if (!probe || probe.status !== 200) {
        refused.push(clientId);
        return json(422, {
          error: "invalid_client",
          error_description: `${options.issuerName} did not accept this client ID and secret.`,
        });
      }
      integration = { clientId, clientSecret };
      return json(200, { configured: true, client_id: clientId });
    }

    if (url.pathname === "/" || url.pathname === "/login") {
      const email = sessions.get(cookies(request)["gsid"] ?? "");
      if (email && url.pathname === "/") return redirect("/dashboard");
      return loginPage();
    }

    if (url.pathname === "/auth/idp" && method === "POST") {
      if (!integration) return loginPage(undefined, 409);
      const endpoints = await discover();
      const state = randomBytes(16).toString("hex");
      const verifier = randomBytes(32).toString("base64url");
      const own = browser ?? randomBytes(12).toString("hex");
      pending.set(state, { verifier, browser: own });
      const target = new URL(endpoints.authorization_endpoint);
      target.searchParams.set("response_type", "code");
      target.searchParams.set("client_id", integration.clientId);
      target.searchParams.set("redirect_uri", callbackUrl);
      target.searchParams.set("scope", "openid profile email");
      target.searchParams.set("state", state);
      target.searchParams.set(
        "code_challenge",
        createHash("sha256").update(verifier).digest("base64url"),
      );
      target.searchParams.set("code_challenge_method", "S256");
      return redirect(
        target.href,
        browser ? {} : { "set-cookie": `gbid=${own}; Path=/; HttpOnly` },
      );
    }

    if (url.pathname === "/auth/idp/callback") {
      const state = url.searchParams.get("state") ?? "";
      const started = pending.get(state);
      pending.delete(state);
      // A callback this browser did not start is not this browser's sign-in.
      if (!started || started.browser !== browser || !integration)
        return loginPage("That sign-in link has expired. Try again.", 400);
      if (url.searchParams.get("error"))
        return loginPage(
          `${options.issuerName} did not allow the sign-in.`,
          400,
        );
      const endpoints = await discover();
      const redeemed = await fetch(endpoints.token_endpoint, {
        method: "POST",
        headers: {
          authorization: basic(integration.clientId, integration.clientSecret),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: url.searchParams.get("code") ?? "",
          redirect_uri: callbackUrl,
          code_verifier: started.verifier,
        }).toString(),
      });
      const token = (await redeemed.json()) as { access_token?: string };
      if (!redeemed.ok || !token.access_token)
        return loginPage(`${options.issuerName} sign-in failed.`, 502);
      const person = await fetch(endpoints.userinfo_endpoint, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      const profile = (await person.json()) as { email?: string };
      if (!person.ok || !profile.email)
        return loginPage(`${options.issuerName} sign-in failed.`, 502);
      const sid = randomBytes(16).toString("hex");
      sessions.set(sid, profile.email);
      signIns.push(profile.email);
      return redirect("/dashboard", {
        "set-cookie": `gsid=${sid}; Path=/; HttpOnly`,
      });
    }

    if (url.pathname === "/dashboard") {
      const email = sessions.get(cookies(request)["gsid"] ?? "");
      if (!email) return redirect("/login");
      return send(
        200,
        markup.page(
          name,
          `<h1>You are signed in</h1>
           <p class="subtitle" data-account="${markup.escape(email)}">Signed in to ${markup.escape(name)} as ${markup.escape(email)} with ${markup.escape(options.issuerName)}.</p>`,
        ),
      );
    }

    return send(404, markup.page("Not found", "<h1>Not found</h1>"));
  }

  let closed = false;
  return {
    origin,
    name,
    homepageUrl: `${origin}/`,
    callbackUrl,
    adminToken,
    integration: () =>
      integration ? { clientId: integration.clientId } : undefined,
    signIns: () => [...signIns],
    refusedClients: () => [...refused],
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
