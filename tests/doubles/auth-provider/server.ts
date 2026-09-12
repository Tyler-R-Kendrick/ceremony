import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { AddressInfo } from "node:net";
import { createMarkup, type Markup } from "./markup.js";

/**
 * A self-hosted identity provider double.
 *
 * It is not a stub that returns canned strings: it serves real HTML over real
 * HTTP, keeps server-side sessions in cookies, enforces password, terms,
 * confirmation and second-factor rules, and implements authorization-code with
 * PKCE S256, a token endpoint, userinfo and OIDC discovery. Registration
 * delivers a real confirmation message to an outbox that the mailbox port reads.
 *
 * Because every page is regenerated per instance from a seed, the double is a
 * contract fixture rather than a golden page: passing it means the driver
 * understood the page, not that it memorised this provider.
 */

export type SeedAccount = {
  email: string;
  username: string;
  password: string;
  verified?: boolean;
};

export type ProviderBehavior = {
  seed?: number;
  accounts?: readonly SeedAccount[];
  /** Registration requires accepting terms before the account is created. */
  requireTerms?: boolean;
  /** Sign-in is followed by a one-time code page. */
  requireMfa?: boolean;
  /** How a new account is confirmed. */
  verification?: "code" | "link" | "none";
  /** Serve a human challenge instead of the named page. */
  challengeAt?: "sign-in" | "sign-up" | "consent";
  /** The consent page refuses and redirects with `error=access_denied`. */
  denyConsent?: boolean;
  /** Sign-in fails with a provider fault the first `n` times. */
  faultySignIns?: number;
  /** Sign-in posts to this absolute URL instead of its own origin. */
  hijackSignInTo?: string;
  /** Sign-in always redisplays itself without accepting or explaining. */
  neverAccept?: boolean;
  /** The sign-in button sits outside any form, so pressing it does nothing. */
  inertSignIn?: boolean;
  /**
   * A person can clear the challenge in the same browser. When false the widget
   * never passes, which is what an unsolvable wall looks like.
   */
  challengeClearable?: boolean;
  /** Sign-in is a passkey prompt with no password to fill. */
  passkeyOnly?: boolean;
  /** Sign-in hints at conditional passkey UI but still accepts a password. */
  conditionalPasskey?: boolean;
  /** The protected resource answers 401 with a Basic challenge and no page. */
  basicRealm?: string;
  /** Issue an ID token bound to the request nonce at the token endpoint. */
  openidConnect?: boolean;
  /** Accept RFC 7591 dynamic client registration before authorization. */
  dynamicRegistration?: boolean;
  /**
   * Honour `requested_actor` and `actor_token` as
   * draft-oauth-ai-agents-on-behalf-of-user-02 describes them: the consent
   * screen names the agent as well as the client, the token request must
   * authenticate that agent, and the issued access token carries `act`.
   */
  delegation?: boolean;
  /**
   * Actor identifiers this authorization server understands. The draft
   * requires the identifier be understood, so an unlisted one is refused
   * rather than silently accepted.
   */
  knownActors?: readonly string[];
  clientId?: string;
  redirectUri?: string;
};

export type MailMessage = {
  to: string;
  subject: string;
  code: string;
  link: string;
  at: number;
};

export type Account = SeedAccount & { verified: boolean; totp: string };

export type ProviderDouble = {
  origin: string;
  markup: Markup;
  signupPath: string;
  behavior: ProviderBehavior;
  clientId: string;
  redirectUri: string;
  /** Start an authorization-code ceremony; returns the PKCE verifier too. */
  authorization(options?: {
    state?: string;
    scope?: string;
    clientId?: string;
    resource?: string;
    /** Agent to request delegated access for (`requested_actor`). */
    actor?: string;
  }): {
    url: string;
    verifier: string;
    state: string;
    nonce: string;
    clientId: string;
  };
  deviceUrl(userCode: string): string;
  issueDeviceCode(): string;
  account(email: string): Account | undefined;
  accounts(): readonly Account[];
  mailbox: {
    messages(): readonly MailMessage[];
    waitFor(to: string, timeoutMs?: number): Promise<MailMessage | undefined>;
  };
  /** Redeem an authorization code exactly as a relying party would. */
  exchange(
    code: string,
    verifier: string,
    options?: { actorToken?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /**
   * Mint a token authenticating an agent, as the agent's own issuer would.
   * Pass `issuer: "wrong"` to get one this authorization server will refuse.
   */
  actorToken(
    actor: string,
    options?: { issuer?: "agent" | "wrong" },
  ): Promise<string>;
  /** Read an issued access token the way a resource server would. */
  readAccessToken(
    token: string,
  ): Promise<{ sub: string; act?: { sub: string } } | undefined>;
  /** Provider-side proof that a session exists for this account. */
  verifyAccess(email: string): Promise<boolean>;
  /** Access tokens the provider displayed. Never something an agent may hold. */
  issuedTokens(): readonly string[];
  /** Applications a person installed, and accounts a federation accepted. */
  installed(): readonly string[];
  federated(): readonly string[];
  /** Accounts that completed an HTTP Basic exchange against the resource. */
  authenticatedBasic(): readonly string[];
  /** Validate an ID token the way a relying party would. */
  verifyIdToken(
    token: string,
  ): Promise<{ sub: string; nonce: string } | undefined>;
  close(): Promise<void>;
};

type PendingRegistration = {
  email: string;
  username: string;
  password: string;
  code: string;
  token: string;
};

type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope: string;
  nonce: string;
  resource: string;
  /** The agent the user is being asked to delegate to, or "". */
  actor: string;
};

function cookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
}

async function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const digits = (length: number) =>
  Array.from({ length }, () => randomInt(0, 10)).join("");

export async function startAuthProvider(
  behavior: ProviderBehavior = {},
): Promise<ProviderDouble> {
  const markup = createMarkup(behavior.seed ?? 1);
  const clientId = behavior.clientId ?? "ceremony-test-client";
  const verification = behavior.verification ?? "code";
  const accounts = new Map<string, Account>();
  for (const seeded of behavior.accounts ?? [])
    accounts.set(seeded.email.toLowerCase(), {
      ...seeded,
      verified: seeded.verified ?? true,
      totp: digits(6),
    });
  const sessions = new Map<string, { email: string; factors: number }>();
  const pending = new Map<string, PendingRegistration>();
  const requests = new Map<string, AuthorizationRequest>();
  const grants = new Map<
    string,
    {
      email: string;
      verifier: string;
      redirectUri: string;
      nonce: string;
      resource: string;
      clientId: string;
      actor: string;
    }
  >();
  const devices = new Map<string, { approved: boolean; email?: string }>();
  /** Challenge tokens issued, and the browsers that have cleared one. */
  const challenges = new Set<string>();
  const cleared = new Set<string>();
  const installations = new Set<string>();
  const assertions = new Set<string>();
  const basicAccounts = new Set<string>();
  const idTokenKey = randomBytes(32);
  const actorKey = randomBytes(32);
  const knownActors = new Set(behavior.knownActors ?? []);
  let closed = false;
  const clients = new Map<string, string>();
  const tokens = new Map<string, string>();
  const outbox: MailMessage[] = [];
  let faults = behavior.faultySignIns ?? 0;

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.writeHead(500, { "content-type": "text/html" });
      response.end(markup.page("Error", "<h1>Provider failure</h1>"));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const redirectUri = behavior.redirectUri ?? `${origin}/callback`;

  const sessionOf = (request: IncomingMessage) => {
    const id = cookies(request)["sid"];
    return id ? sessions.get(id) : undefined;
  };
  /**
   * The agent's own issuer, kept separate from the authorization server so an
   * actor token is a real second credential rather than a restatement of the
   * first. Returns the agent it authenticates, or nothing.
   */
  const actorIssuer = `${origin}/agent-issuer`;
  const actorSubject = async (token: string): Promise<string | undefined> => {
    if (!token) return undefined;
    try {
      const { payload } = await jwtVerify(token, actorKey, {
        issuer: actorIssuer,
        audience: origin,
      });
      const subject = String(payload.sub ?? "");
      return subject || undefined;
    } catch {
      return undefined;
    }
  };

  const deliver = (to: string, code: string, token: string) => {
    outbox.push({
      to,
      subject: "Confirm your account",
      code,
      link: `${origin}/confirm/${token}`,
      at: Date.now(),
    });
  };

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    const body =
      method === "POST" ? await readBody(request) : new URLSearchParams();
    // A browser identity exists before any session does, so state such as a
    // cleared challenge can belong to the browser a person actually used.
    const existingBrowser = cookies(request)["bid"];
    const browserId = existingBrowser ?? randomBytes(12).toString("hex");
    const browser = () => browserId;
    const withCookies = (headers: Record<string, string>) => {
      const own = headers["set-cookie"];
      const extra = existingBrowser
        ? []
        : [`bid=${browserId}; Path=/; HttpOnly`];
      const all = [...(own ? [own] : []), ...extra];
      const rest = { ...headers };
      delete rest["set-cookie"];
      return all.length ? { ...rest, "set-cookie": all } : rest;
    };
    const send = (
      status: number,
      html: string,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        ...withCookies(headers),
      });
      response.end(html);
    };
    const json = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...withCookies(headers),
      });
      response.end(JSON.stringify(value));
    };
    const redirect = (
      location: string,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(302, { location, ...withCookies(headers) });
      response.end();
    };
    const openSession = (email: string, factors: number) => {
      const id = randomBytes(16).toString("hex");
      sessions.set(id, { email, factors });
      return `sid=${id}; Path=/; HttpOnly`;
    };

    const challengePage = () => {
      // The widget is the real obstacle; the form beside it is what a person
      // submits once they have satisfied it in their own browser.
      const token = randomBytes(8).toString("hex");
      if (behavior.challengeClearable) challenges.add(token);
      return send(
        200,
        markup.page(
          "Security check",
          `<h1>Confirm you are human</h1>
           <div data-captcha="required">Complete the challenge to continue.</div>
           ${
             behavior.challengeClearable
               ? `<form method="post" action="/challenge?to=${encodeURIComponent(url.pathname + url.search)}">
                    <input type="hidden" name="solved" value="${token}">
                    <button type="submit">I am not a robot</button>
                  </form>`
               : "<p>This step cannot be completed automatically.</p>"
           }`,
        ),
      );
    };

    const blocked = (at: ProviderBehavior["challengeAt"]) =>
      behavior.challengeAt === at && !cleared.has(browser());

    const signInPage = (next: string, error?: string) => {
      if (blocked("sign-in")) return challengePage();
      if (behavior.passkeyOnly)
        return send(
          200,
          markup.page(
            "Use your passkey",
            `<h1>Use your passkey to continue</h1>
             <div data-passkey="required">Your device will ask for the passkey.</div>
             <form method="post" action="/passkey?next=${encodeURIComponent(next)}">
               <button type="submit">Continue with passkey</button>
             </form>`,
          ),
        );
      const action =
        behavior.hijackSignInTo ??
        `${url.pathname}?next=${encodeURIComponent(next)}`;
      const fields = markup.arrange("sign-in", [
        markup.field(
          markup.labels.identifier,
          markup.names.identifier,
          "text",
          behavior.conditionalPasskey
            ? 'required autocomplete="username webauthn"'
            : "required",
        ),
        markup.field(
          markup.labels.password,
          markup.names.password,
          "password",
          "required",
        ),
      ]);
      if (behavior.inertSignIn)
        return send(
          200,
          markup.page(
            "Sign in",
            `${markup.alert(error)}
             <h1>${markup.headings.signIn}</h1>
             ${fields.join("\n")}
             <button type="button">${markup.captions.signIn}</button>`,
          ),
        );
      send(
        200,
        markup.page(
          "Sign in",
          `${markup.alert(error)}
           <h1>${markup.headings.signIn}</h1>
           <form method="post" action="${action}">
             ${fields.join("\n")}
             <button type="submit">${markup.captions.signIn}</button>
           </form>
           <p><a href="${markup.signupPath}?next=${encodeURIComponent(next)}">${markup.captions.signUpLink}</a></p>`,
        ),
      );
    };

    const signUpPage = (next: string, error?: string) => {
      if (blocked("sign-up")) return challengePage();
      const fields = markup.arrange("sign-up", [
        markup.field(
          markup.labels.email,
          markup.names.email,
          markup.emailInputType,
          "required",
        ),
        markup.field(
          markup.labels.password,
          markup.names.password,
          "password",
          "required",
        ),
        markup.field(
          markup.labels.confirm,
          markup.names.confirm,
          "password",
          "required",
        ),
        ...(markup.includeDisplayName
          ? [
              markup.field(
                markup.labels.displayName,
                markup.names.displayName,
                "text",
              ),
            ]
          : []),
        ...(markup.includeBirthDate
          ? [
              markup.field(
                markup.labels.birthDate,
                markup.names.birthDate,
                "date",
              ),
            ]
          : []),
        ...(behavior.requireTerms
          ? [markup.checkbox(markup.labels.terms, markup.names.terms)]
          : []),
      ]);
      send(
        200,
        markup.page(
          "Create account",
          `${markup.alert(error)}
           <h1>${markup.headings.signUp}</h1>
           <form method="post" action="${markup.signupPath}?next=${encodeURIComponent(next)}">
             ${fields.join("\n")}
             <button type="submit">${markup.captions.signUp}</button>
           </form>`,
        ),
      );
    };

    const confirmPage = (token: string, next: string, error?: string) =>
      send(
        200,
        markup.page(
          "Confirm your account",
          `${markup.alert(error)}
           <h1>${markup.messages.checkInbox}</h1>
           <form method="post" action="/confirm?p=${token}&next=${encodeURIComponent(next)}">
             ${markup.field(markup.labels.verification, markup.names.code, "text", 'required inputmode="numeric"')}
             <button type="submit">${markup.captions.submitCode}</button>
           </form>
           <form method="post" action="/resend?p=${token}">
             <button type="submit">${markup.captions.resend}</button>
           </form>`,
        ),
      );

    const mfaPage = (id: string, target: string, error?: string) =>
      send(
        200,
        markup.page(
          "Two-factor",
          `${markup.alert(error)}
           <h1>Enter your ${markup.escape(markup.labels.totp)}</h1>
           <form method="post" action="/mfa?next=${encodeURIComponent(target)}">
             ${markup.field(markup.labels.totp, markup.names.code, "text", "required")}
             <button type="submit">${markup.captions.submitCode}</button>
           </form>`,
        ),
        { "set-cookie": `sid=${id}; Path=/; HttpOnly` },
      );

    const dashboard = (email: string) =>
      send(
        200,
        markup.page(
          "Account",
          `<h1>You are signed in</h1>
           <p data-account="${markup.escape(email)}">Signed in as ${markup.escape(email)}.</p>
           <form method="post" action="/signout"><button type="submit">Sign out</button></form>`,
        ),
      );

    const next = url.searchParams.get("next") ?? "/";

    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        userinfo_endpoint: `${origin}/userinfo`,
        code_challenge_methods_supported: ["S256"],
        ...(behavior.dynamicRegistration
          ? { registration_endpoint: `${origin}/oauth/register` }
          : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
      });

    if (url.pathname === "/") {
      const session = sessionOf(request);
      if (!session) return redirect("/signin");
      if (behavior.requireMfa && session.factors < 2) return redirect("/mfa");
      return dashboard(session.email);
    }

    if (url.pathname === "/signin") {
      if (method === "GET") return signInPage(next);
      if (faults > 0) {
        faults--;
        return send(
          503,
          markup.page(
            "Unavailable",
            `${markup.alert("Sign-in is temporarily unavailable. Try again.")}
             <h1>Service unavailable</h1>
             <p><a href="${url.pathname}?next=${encodeURIComponent(next)}">Try again</a></p>`,
          ),
        );
      }
      if (behavior.neverAccept) return signInPage(next);
      const identifier = (body.get(markup.names.identifier) ?? "").trim();
      const password = body.get(markup.names.password) ?? "";
      const found = [...accounts.values()].find(
        (account) =>
          account.username.toLowerCase() === identifier.toLowerCase() ||
          account.email.toLowerCase() === identifier.toLowerCase(),
      );
      if (!found || found.password !== password)
        return signInPage(next, markup.messages.rejected);
      if (!found.verified) {
        const token = randomBytes(12).toString("hex");
        const code = digits(6);
        pending.set(token, {
          email: found.email,
          username: found.username,
          password: found.password,
          code,
          token,
        });
        deliver(found.email, code, token);
        return confirmPage(token, next, markup.messages.unverified);
      }
      const cookie = openSession(found.email, behavior.requireMfa ? 1 : 2);
      if (behavior.requireMfa) {
        const id = cookie.slice("sid=".length, cookie.indexOf(";"));
        return mfaPage(id, next);
      }
      return redirect(next, { "set-cookie": cookie });
    }

    if (url.pathname === "/mfa") {
      const session = sessionOf(request);
      if (!session) return redirect("/signin");
      if (method === "GET") {
        const id = cookies(request)["sid"] ?? "";
        return mfaPage(id, next);
      }
      const account = accounts.get(session.email.toLowerCase());
      if (!account || body.get(markup.names.code) !== account.totp) {
        const id = cookies(request)["sid"] ?? "";
        return mfaPage(id, next, markup.messages.badCode);
      }
      session.factors = 2;
      return redirect(next);
    }

    if (url.pathname === markup.signupPath) {
      if (method === "GET") return signUpPage(next);
      const email = (body.get(markup.names.email) ?? "").trim().toLowerCase();
      const password = body.get(markup.names.password) ?? "";
      const confirm = body.get(markup.names.confirm) ?? "";
      if (behavior.requireTerms && body.get(markup.names.terms) !== "yes")
        return signUpPage(next, markup.messages.termsRequired);
      if (!email.includes("@") || password.length < 8)
        return signUpPage(
          next,
          "Enter an email address and a password of at least 8 characters.",
        );
      if (password !== confirm)
        return signUpPage(next, markup.messages.mismatch);
      if (accounts.has(email))
        return signUpPage(next, markup.messages.emailInUse);
      const username = email.split("@")[0] ?? email;
      if (verification === "none") {
        accounts.set(email, {
          email,
          username,
          password,
          verified: true,
          totp: digits(6),
        });
        return redirect(next, { "set-cookie": openSession(email, 2) });
      }
      const token = randomBytes(12).toString("hex");
      const code = digits(6);
      pending.set(token, { email, username, password, code, token });
      deliver(email, code, token);
      return confirmPage(token, next);
    }

    if (url.pathname === "/resend" && method === "POST") {
      const record = pending.get(url.searchParams.get("p") ?? "");
      if (!record) return redirect("/signin");
      deliver(record.email, record.code, record.token);
      return confirmPage(record.token, next, undefined);
    }

    if (url.pathname.startsWith("/confirm")) {
      const linkToken = url.pathname.slice("/confirm/".length);
      if (url.pathname !== "/confirm" && method === "GET") {
        const record = pending.get(linkToken);
        if (!record) return signInPage(next, markup.messages.rejected);
        pending.delete(linkToken);
        accounts.set(record.email, {
          email: record.email,
          username: record.username,
          password: record.password,
          verified: true,
          totp: digits(6),
        });
        return redirect(next, { "set-cookie": openSession(record.email, 2) });
      }
      const token = url.searchParams.get("p") ?? "";
      const record = pending.get(token);
      if (!record) return signInPage(next, markup.messages.rejected);
      if (method === "GET") return confirmPage(token, next);
      if (body.get(markup.names.code) !== record.code)
        return confirmPage(token, next, markup.messages.badCode);
      pending.delete(token);
      accounts.set(record.email, {
        email: record.email,
        username: record.username,
        password: record.password,
        verified: true,
        totp: digits(6),
      });
      return redirect(next, { "set-cookie": openSession(record.email, 2) });
    }

    if (url.pathname === "/authorize") {
      const session = sessionOf(request);
      if (!session || (behavior.requireMfa && session.factors < 2))
        return redirect(
          `/signin?next=${encodeURIComponent(url.pathname + url.search)}`,
        );
      if (blocked("consent")) return challengePage();
      const actor = url.searchParams.get("requested_actor") ?? "";
      // The draft requires the identifier be one the server understands. An
      // unrecognised agent is refused at the redirect, so the client learns the
      // delegation was rejected rather than silently receiving a plain grant.
      if (behavior.delegation && actor && !knownActors.has(actor)) {
        const refusal = new URL(url.searchParams.get("redirect_uri") ?? origin);
        refusal.searchParams.set("error", "invalid_request");
        const sent = url.searchParams.get("state");
        if (sent) refusal.searchParams.set("state", sent);
        return redirect(refusal.href);
      }
      const requestId = randomBytes(8).toString("hex");
      requests.set(requestId, {
        clientId: url.searchParams.get("client_id") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        challenge: url.searchParams.get("code_challenge") ?? "",
        state: url.searchParams.get("state") ?? "",
        scope: url.searchParams.get("scope") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        resource: url.searchParams.get("resource") ?? "",
        actor: behavior.delegation ? actor : "",
      });
      // Delegation is a different question from access, so the page asks it
      // out loud: this names the agent, not just the client asking.
      const delegation =
        behavior.delegation && actor
          ? `<p>${markup.escape(actor)} will act on your behalf.</p>`
          : "";
      return send(
        200,
        markup.page(
          "Authorize",
          `<h1>${markup.headings.consent}</h1>
           <p>${markup.escape(clientId)} is requesting ${markup.escape(url.searchParams.get("scope") ?? "access")}.</p>
           ${delegation}
           <form method="post" action="/consent">
             <input type="hidden" name="r" value="${requestId}">
             <button type="submit" name="decision" value="allow">${markup.captions.approve}</button>
             <button type="submit" name="decision" value="deny">${markup.captions.deny}</button>
           </form>`,
        ),
      );
    }

    if (url.pathname === "/consent" && method === "POST") {
      const session = sessionOf(request);
      const pendingRequest = requests.get(body.get("r") ?? "");
      if (!session || !pendingRequest) return redirect("/signin");
      const target = new URL(pendingRequest.redirectUri);
      if (behavior.denyConsent || body.get("decision") === "deny") {
        target.searchParams.set("error", "access_denied");
        if (pendingRequest.state)
          target.searchParams.set("state", pendingRequest.state);
        return redirect(target.href);
      }
      const code = randomBytes(24).toString("hex");
      grants.set(code, {
        email: session.email,
        verifier: pendingRequest.challenge,
        redirectUri: pendingRequest.redirectUri,
        nonce: pendingRequest.nonce,
        resource: pendingRequest.resource,
        clientId: pendingRequest.clientId,
        actor: pendingRequest.actor,
      });
      target.searchParams.set("code", code);
      if (pendingRequest.state)
        target.searchParams.set("state", pendingRequest.state);
      return redirect(target.href);
    }

    if (url.pathname === "/token" && method === "POST") {
      const code = body.get("code") ?? "";
      const grant = grants.get(code);
      const verifier = body.get("code_verifier") ?? "";
      const derived = createHash("sha256").update(verifier).digest("base64url");
      if (
        !grant ||
        grant.verifier !== derived ||
        body.get("redirect_uri") !== grant.redirectUri
      )
        return json(400, { error: "invalid_grant" });
      // Delegation is only real if the agent authenticates too: a code alone
      // must not buy a token that claims someone acts for the user.
      let acting: string | undefined;
      if (grant.actor) {
        const presented = body.get("actor_token") ?? "";
        const subject = await actorSubject(presented);
        if (!subject || subject !== grant.actor)
          return json(400, { error: "invalid_grant" });
        acting = subject;
      }
      grants.delete(code);
      const issued: Record<string, unknown> = {
        access_token: acting
          ? await new SignJWT({ act: { sub: acting } })
              .setProtectedHeader({ alg: "HS256" })
              .setIssuer(origin)
              .setAudience(grant.clientId || clientId)
              .setSubject(grant.email)
              .setIssuedAt()
              .setExpirationTime("5m")
              .sign(idTokenKey)
          : `at_${randomBytes(16).toString("hex")}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
        sub: grant.email,
        client_id: grant.clientId,
        // MCP binds a token to the resource the client asked for; echoing it
        // is what lets a consumer check it got the audience it requested.
        ...(grant.resource ? { aud: grant.resource } : {}),
      };
      if (behavior.openidConnect)
        // A real signed assertion, so a consumer's nonce and issuer checks are
        // exercised rather than assumed.
        issued["id_token"] = await new SignJWT({
          nonce: grant.nonce,
          email: grant.email,
        })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer(origin)
          .setAudience(grant.verifier ? clientId : clientId)
          .setSubject(grant.email)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(idTokenKey);
      return json(200, issued);
    }

    if (url.pathname === "/userinfo") {
      const session = sessionOf(request);
      if (!session) return json(401, { error: "invalid_token" });
      return json(200, { sub: session.email, email: session.email });
    }

    if (url.pathname === "/device") {
      const session = sessionOf(request);
      if (!session)
        return redirect(`/signin?next=${encodeURIComponent("/device")}`);
      if (method === "GET")
        return send(
          200,
          markup.page(
            "Connect a device",
            `<h1>Enter the code shown on your device</h1>
             <form method="post" action="/device">
               ${markup.field(markup.labels.userCode, markup.names.userCode, "text", "required")}
               <button type="submit">${markup.captions.approve}</button>
             </form>`,
          ),
        );
      const entered = (body.get(markup.names.userCode) ?? "")
        .trim()
        .toUpperCase();
      const device = devices.get(entered);
      if (!device)
        return send(
          200,
          markup.page(
            "Connect a device",
            `${markup.alert(markup.messages.badCode)}
             <h1>Enter the code shown on your device</h1>
             <form method="post" action="/device">
               ${markup.field(markup.labels.userCode, markup.names.userCode, "text", "required")}
               <button type="submit">${markup.captions.approve}</button>
             </form>`,
          ),
        );
      device.approved = true;
      device.email = session.email;
      return send(
        200,
        markup.page(
          "Device connected",
          `<h1>You are signed in</h1><p data-account="${markup.escape(session.email)}">The device is now approved.</p>`,
        ),
      );
    }

    // A person clears the widget in the same browser they were handed. The
    // clearance belongs to that browser, so the agent resuming there sees it.
    // Only a person can satisfy the authenticator; the provider then opens the
    // session, exactly as it would after a real assertion.
    if (url.pathname === "/passkey" && method === "POST") {
      const account = [...accounts.values()][0];
      if (!account) return redirect("/signin");
      return redirect(url.searchParams.get("next") ?? "/", {
        "set-cookie": openSession(account.email, 2),
      });
    }

    if (url.pathname === "/challenge" && method === "POST") {
      const solved = body.get("solved") ?? "";
      if (!challenges.has(solved)) return redirect("/signin");
      challenges.delete(solved);
      cleared.add(browser());
      return redirect(url.searchParams.get("to") ?? "/");
    }

    // Personal access tokens: the value is shown on the page, never in a field.
    // An agent can reach this page; only a person may carry the value onward.
    if (url.pathname === "/tokens") {
      const session = sessionOf(request);
      if (!session)
        return redirect(`/signin?next=${encodeURIComponent("/tokens")}`);
      if (method === "GET")
        return send(
          200,
          markup.page(
            "Access tokens",
            `<h1>Personal access tokens</h1>
             <form method="post" action="/tokens">
               ${markup.field("Token name", "token_name", "text", "required")}
               <button type="submit">Generate token</button>
             </form>`,
          ),
        );
      const issued = `pat_${randomBytes(20).toString("hex")}`;
      tokens.set(issued, session.email);
      return send(
        200,
        markup.page(
          "Access tokens",
          `<h1>Copy your new token</h1>
           <p>This value is shown once. Copy it into the application now.</p>
           <code data-token>${issued}</code>`,
        ),
      );
    }

    // HTTP Basic: the challenge is a header, so there is no page to fill.
    if (url.pathname === "/basic") {
      if (!behavior.basicRealm) return send(404, markup.page("Not found", ""));
      const header = request.headers.authorization ?? "";
      const [scheme, encoded] = header.split(" ");
      const [user, secret] = Buffer.from(encoded ?? "", "base64")
        .toString("utf8")
        .split(":");
      const account = [...accounts.values()].find(
        (candidate) =>
          candidate.username.toLowerCase() === (user ?? "").toLowerCase() ||
          candidate.email.toLowerCase() === (user ?? "").toLowerCase(),
      );
      if (
        scheme?.toLowerCase() !== "basic" ||
        !account ||
        account.password !== secret
      ) {
        response.writeHead(401, {
          "www-authenticate": `Basic realm="${behavior.basicRealm}", charset="UTF-8"`,
          "content-type": "text/html; charset=utf-8",
        });
        response.end(markup.page("Unauthorized", "<h1>401</h1>"));
        return;
      }
      basicAccounts.add(account.email.toLowerCase());
      return send(
        200,
        markup.page(
          "Protected",
          `<h1>You are signed in</h1><p data-account="${markup.escape(account.email)}">Basic access granted.</p>`,
        ),
      );
    }

    // A resource that explicitly needs no authentication at all.
    if (url.pathname === "/public")
      return send(
        200,
        markup.page(
          "Public resource",
          `<h1>You are signed in</h1><p>This resource is public; no account is required.</p>`,
        ),
      );

    // auth.md anonymous identity, claimed later with an emailed approval code.
    if (url.pathname === "/anonymous") {
      if (method === "GET")
        return send(
          200,
          markup.page(
            "Anonymous access",
            `<h1>Continue without an account</h1>
             <form method="post" action="/anonymous">
               <button type="submit">Continue anonymously</button>
             </form>`,
          ),
        );
      const handle = `anon-${randomBytes(6).toString("hex")}`;
      accounts.set(handle, {
        email: handle,
        username: handle,
        password: randomBytes(12).toString("hex"),
        verified: false,
        totp: digits(6),
      });
      return redirect("/claim", { "set-cookie": openSession(handle, 1) });
    }

    if (url.pathname === "/claim") {
      const session = sessionOf(request);
      if (!session) return redirect("/anonymous");
      if (method === "GET")
        return send(
          200,
          markup.page(
            "Claim this access",
            `<h1>Claim your anonymous access</h1>
             <form method="post" action="/claim">
               ${markup.field(markup.labels.email, markup.names.email, markup.emailInputType, "required")}
               <button type="submit">Send approval code</button>
             </form>`,
          ),
        );
      const address = (body.get(markup.names.email) ?? "").trim().toLowerCase();
      const existing = pending.get(session.email);
      if (!existing && address.includes("@")) {
        const code = digits(6);
        pending.set(session.email, {
          email: address,
          username: session.email,
          password: "",
          code,
          token: session.email,
        });
        deliver(address, code, session.email);
        return send(
          200,
          markup.page(
            "Claim this access",
            `<h1>${markup.messages.checkInbox}</h1>
             <form method="post" action="/claim">
               ${markup.field(markup.labels.verification, markup.names.code, "text", "required")}
               <button type="submit">${markup.captions.submitCode}</button>
             </form>`,
          ),
        );
      }
      if (!existing) return redirect("/claim");
      if (body.get(markup.names.code) !== existing.code)
        return send(
          200,
          markup.page(
            "Claim this access",
            `${markup.alert(markup.messages.badCode)}
             <h1>${markup.messages.checkInbox}</h1>
             <form method="post" action="/claim">
               ${markup.field(markup.labels.verification, markup.names.code, "text", "required")}
               <button type="submit">${markup.captions.submitCode}</button>
             </form>`,
          ),
        );
      pending.delete(session.email);
      const claimed = accounts.get(session.email);
      if (claimed) claimed.verified = true;
      session.factors = 2;
      return send(
        200,
        markup.page(
          "Claimed",
          `<h1>You are signed in</h1><p data-account="${markup.escape(existing.email)}">This access is now claimed.</p>`,
        ),
      );
    }

    // GitHub App shape: a manifest is submitted, then the app is installed.
    if (url.pathname === "/apps/new") {
      const session = sessionOf(request);
      if (!session)
        return redirect(`/signin?next=${encodeURIComponent("/apps/new")}`);
      if (method === "GET")
        return send(
          200,
          markup.page(
            "Register an application",
            `<h1>Register a new application</h1>
             <form method="post" action="/apps/new">
               ${markup.field("Application name", "app_name", "text", "required")}
               <button type="submit">Create application</button>
             </form>`,
          ),
        );
      const app = randomBytes(6).toString("hex");
      clients.set(app, session.email);
      return redirect(`/apps/${app}/install`);
    }

    if (
      url.pathname.startsWith("/apps/") &&
      url.pathname.endsWith("/install")
    ) {
      const session = sessionOf(request);
      const app = url.pathname.slice("/apps/".length, -"/install".length);
      if (!session || !clients.has(app)) return redirect("/signin");
      if (method === "GET")
        return send(
          200,
          markup.page(
            "Install application",
            `<h1>Install this application</h1>
             <p>Choose where it may act on your behalf.</p>
             <form method="post" action="${url.pathname}">
               <button type="submit">${markup.captions.approve}</button>
             </form>`,
          ),
        );
      installations.add(app);
      return send(
        200,
        markup.page(
          "Installed",
          `<h1>You are signed in</h1><p data-account="${markup.escape(session.email)}">The application is installed.</p>`,
        ),
      );
    }

    // RFC 7591 dynamic client registration, as MCP authorization expects.
    if (url.pathname === "/oauth/register" && method === "POST") {
      if (!behavior.dynamicRegistration)
        return json(404, { error: "not_found" });
      const id = `client_${randomBytes(8).toString("hex")}`;
      clients.set(id, "dynamic");
      return json(201, { client_id: id, token_endpoint_auth_method: "none" });
    }

    if (url.pathname === "/.well-known/oauth-protected-resource")
      return json(200, {
        resource: `${origin}/resource`,
        authorization_servers: [origin],
      });

    // SAML SP-initiated flow: authenticate, then hand back a signed assertion
    // through the POST binding, with the no-script submit real IdPs include.
    if (url.pathname === "/saml/login") {
      const session = sessionOf(request);
      const relay = url.searchParams.get("RelayState") ?? "";
      if (!session)
        return redirect(
          `/signin?next=${encodeURIComponent(url.pathname + url.search)}`,
        );
      const assertion = Buffer.from(
        `<Assertion><Subject>${session.email}</Subject><Audience>${clientId}</Audience></Assertion>`,
      ).toString("base64");
      return send(
        200,
        markup.page(
          "Signing you in",
          `<h1>Completing sign-in</h1>
           <form method="post" action="/saml/acs">
             <input type="hidden" name="SAMLResponse" value="${assertion}">
             <input type="hidden" name="RelayState" value="${markup.escape(relay)}">
             <button type="submit">Continue</button>
           </form>`,
        ),
      );
    }

    if (url.pathname === "/saml/acs" && method === "POST") {
      const decoded = Buffer.from(
        body.get("SAMLResponse") ?? "",
        "base64",
      ).toString("utf8");
      const subject = /<Subject>([^<]+)<\/Subject>/.exec(decoded)?.[1] ?? "";
      if (!accounts.has(subject.toLowerCase()))
        return send(
          401,
          markup.page("Rejected", "<h1>Assertion rejected</h1>"),
        );
      assertions.add(subject.toLowerCase());
      return send(
        200,
        markup.page(
          "Federated",
          `<h1>You are signed in</h1><p data-account="${markup.escape(subject)}">The assertion was accepted.</p>`,
        ),
      );
    }

    if (url.pathname === "/signout" && method === "POST") {
      const id = cookies(request)["sid"];
      if (id) sessions.delete(id);
      return redirect("/signin");
    }

    return send(404, markup.page("Not found", "<h1>Not found</h1>"));
  }

  return {
    origin,
    markup,
    behavior,
    clientId,
    redirectUri,
    signupPath: markup.signupPath,
    authorization: (options = {}) => {
      const verifier = randomBytes(32).toString("base64url");
      const state = options.state ?? randomBytes(8).toString("hex");
      const nonce = randomBytes(8).toString("hex");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const target = new URL(`${origin}/authorize`);
      const client = options.clientId ?? clientId;
      target.searchParams.set("client_id", client);
      if (options.resource)
        target.searchParams.set("resource", options.resource);
      target.searchParams.set("redirect_uri", redirectUri);
      target.searchParams.set("response_type", "code");
      target.searchParams.set("code_challenge", challenge);
      target.searchParams.set("code_challenge_method", "S256");
      target.searchParams.set("scope", options.scope ?? "openid profile");
      target.searchParams.set("state", state);
      target.searchParams.set("nonce", nonce);
      if (options.actor)
        target.searchParams.set("requested_actor", options.actor);
      return { url: target.href, verifier, state, nonce, clientId: client };
    },
    deviceUrl: (userCode) => `${origin}/device?user_code=${userCode}`,
    issueDeviceCode: () => {
      const code = randomBytes(3).toString("hex").toUpperCase();
      devices.set(code, { approved: false });
      return code;
    },
    account: (email) => accounts.get(email.toLowerCase()),
    accounts: () => [...accounts.values()],
    mailbox: {
      messages: () => [...outbox],
      waitFor: async (to, timeoutMs = 2_000) => {
        const deadline = Date.now() + timeoutMs;
        const address = to.toLowerCase();
        for (;;) {
          const found = [...outbox]
            .reverse()
            .find((message) => message.to.toLowerCase() === address);
          if (found) return found;
          if (Date.now() >= deadline) return undefined;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    },
    exchange: async (code, verifier, options = {}) => {
      const result = await fetch(`${origin}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_id: clientId,
          ...(options.actorToken ? { actor_token: options.actorToken } : {}),
        }),
      });
      return {
        status: result.status,
        body: (await result.json()) as Record<string, unknown>,
      };
    },
    actorToken: (actor, options = {}) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(options.issuer === "wrong" ? origin : actorIssuer)
        .setAudience(origin)
        .setSubject(actor)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(actorKey),
    readAccessToken: async (token) => {
      try {
        const { payload } = await jwtVerify(token, idTokenKey, {
          issuer: origin,
        });
        const act = payload["act"] as { sub?: string } | undefined;
        return {
          sub: String(payload.sub ?? ""),
          ...(act?.sub ? { act: { sub: act.sub } } : {}),
        };
      } catch {
        return undefined;
      }
    },
    issuedTokens: () => [...tokens.keys()],
    installed: () => [...installations],
    federated: () => [...assertions],
    authenticatedBasic: () => [...basicAccounts],
    verifyIdToken: async (token) => {
      try {
        const { payload } = await jwtVerify(token, idTokenKey, {
          issuer: origin,
          audience: clientId,
        });
        return {
          sub: String(payload.sub ?? ""),
          nonce: String(payload["nonce"] ?? ""),
        };
      } catch {
        return undefined;
      }
    },
    verifyAccess: async (email) =>
      [...sessions.values()].some(
        (session) =>
          session.email.toLowerCase() === email.toLowerCase() &&
          session.factors >= 2,
      ),
    close: async () => {
      if (closed) return;
      closed = true;
      // `close` alone waits on idle keep-alive sockets, which a fixture that
      // just served a ceremony always has; dropping them releases the port.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * A second origin that is not part of any ceremony's allowlist. It imitates the
 * provider's sign-in page so a driver that follows a redirect off the permitted
 * origin would type a password into it. Nothing here ever receives one: the
 * contract asserts the attempt stops first.
 */
export async function startUntrustedOrigin(): Promise<{
  origin: string;
  submissions(): readonly Record<string, string>[];
  close(): Promise<void>;
}> {
  const submissions: Record<string, string>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "POST") {
        const body = await readBody(request);
        submissions.push(Object.fromEntries(body.entries()));
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body>
         <h1>Sign in to continue</h1>
         <form method="post" action="/">
           <p><label for="u">Username</label><input id="u" name="username" type="text" required></p>
           <p><label for="p">Password</label><input id="p" name="password" type="password" required></p>
           <button type="submit">Sign in</button>
         </form></body></html>`,
      );
    })();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  let shut = false;
  return {
    origin: `http://127.0.0.1:${port}`,
    submissions: () => [...submissions],
    close: async () => {
      if (shut) return;
      shut = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
