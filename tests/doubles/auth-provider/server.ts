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
import {
  developerSettingsPages,
  oauthAppsPath,
  type NewOAuthAppValues,
} from "./developer-settings.js";
import type { AuthLayout } from "./layouts.js";
import { totpCode } from "../../../src/server/totp.js";
import {
  verifyRequestSignature,
  type SignatureVerdict,
} from "../web-bot-auth.js";

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
 * understood the page, not that it memorised this provider. A realistic
 * `layout` swaps that shape for a fixed, styled page modelled on common
 * real-world sign-in patterns; the protocol behind it is the same.
 */

export type SeedAccount = {
  email: string;
  username: string;
  password: string;
  verified?: boolean;
};

export type ProviderBehavior = {
  seed?: number;
  /**
   * How pages look. `randomized` (the default) regenerates field names, label
   * wording and attachment, control order and captions per seed, to stress a
   * driver. The realistic layouts in `layouts.ts` render the conventional,
   * styled pages real providers ship, for demonstrations and to prove the
   * driver reads those too. Markup only: sessions, codes and redirects are
   * unchanged, except that `identifier-first` implies `identifierFirst`.
   */
  layout?: AuthLayout;
  accounts?: readonly SeedAccount[];
  /** Registration requires accepting terms before the account is created. */
  requireTerms?: boolean;
  /**
   * Registration offers an optional "send me product news and offers" box,
   * and remembers who ticked it. A marketing opt-in is never an agent's to
   * tick, so a scenario can check nobody did.
   */
  offerNewsletter?: boolean;
  /**
   * Registration asks for a country or region from a required `<select>`,
   * whose first option is an empty "Select a country". The account is not
   * created without one of the listed regions.
   */
  requireRegion?: boolean;
  /** Sign-in is followed by a one-time code page. */
  requireMfa?: boolean;
  /**
   * The one-time code is RFC 6238, derived from this base32 enrolment seed,
   * rather than a fixed code per account. What a real authenticator step is,
   * and what a caller holding the seed can answer.
   */
  totpSeed?: string;
  /**
   * Sign-in asks for the identifier alone, then shows the password on its
   * own page - the identifier-first shape most large providers use.
   */
  identifierFirst?: boolean;
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
  /**
   * Gate every page behind a Web Bot Auth signature
   * (draft-meunier-webbotauth-httpsig-protocol-02). A request that does not
   * carry a verifiable one is answered 403 with a human-verification
   * interstitial, which is the fork a real deployment presents: a recognised
   * agent passes straight through, an unrecognised one meets a person's work.
   */
  requireSignature?: boolean;
  /**
   * Only registered clients may authorize or redeem a code, as at a real
   * provider. `/authorize` refuses an unknown `client_id` or a `redirect_uri`
   * that is not exactly the one registered, with an error page and no
   * redirect; `/token` requires a confidential client to authenticate with its
   * secret (`client_secret_basic` or `client_secret_post`) and the code to
   * have been issued to that client. Clients are registered by a person at
   * "Developer settings → OAuth apps → New OAuth app", or through dynamic
   * registration, whose redirect URIs are then enforced too. The double's own
   * default client stays registered as a public client for its redirect URI.
   *
   * Off by default, which keeps the permissive behaviour every existing
   * scenario was written against: any `client_id` accepted.
   */
  strictClients?: boolean;
  clientId?: string;
  redirectUri?: string;
};

/**
 * The regions registration offers when `requireRegion` is on, by the label a
 * person sees and the code the form submits. The labels are what a plan
 * names and a snapshot lists; the codes are markup nobody is shown.
 */
export const regionList = [
  { code: "CA", name: "Canada" },
  { code: "DE", name: "Germany" },
  { code: "JP", name: "Japan" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
] as const;
const regionField = "country";
const regionOptions = `<option value="">Select a country</option>${regionList
  .map((entry) => `<option value="${entry.code}">${entry.name}</option>`)
  .join("")}`;

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
  /**
   * Regenerate every page's shape from a new seed, on the same origin and
   * with the same accounts: what a provider redeploying its sign-in pages
   * looks like to anything that recorded the old ones.
   */
  restyle(seed: number): void;
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
  /** User codes issued so far, oldest first: what each device showed. */
  issuedDeviceCodes(): readonly string[];
  /** Which account approved a device's user code, if one has. */
  deviceApprovedBy(userCode: string): string | undefined;
  /** The region an address registered with, when registration asked. */
  regionOf(email: string): string | undefined;
  /** Addresses whose registration ticked the newsletter box. */
  newsletterSubscribers(): readonly string[];
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
  /**
   * OAuth apps registered at developer settings, as their owner sees them in
   * a list: no secret, and no hash of one, only how many exist.
   */
  oauthApps(): readonly {
    clientId: string;
    name: string;
    homepageUrl: string;
    callbackUrl: string;
    owner: string;
    secrets: number;
  }[];
  /** Applications a person installed, and accounts a federation accepted. */
  installed(): readonly string[];
  federated(): readonly string[];
  /** Accounts that completed an HTTP Basic exchange against the resource. */
  authenticatedBasic(): readonly string[];
  /** Every signature verdict the gate reached, oldest first. */
  signatureVerdicts(): readonly SignatureVerdict[];
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

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(request));
}

/**
 * A client the provider knows. `confidential` clients were registered by a
 * person and must authenticate with a secret they generated; the double's
 * default and dynamically registered clients are public, bound by PKCE and
 * their redirect URIs alone. Only a hash of each secret is kept, as a real
 * provider keeps it, which is also why the page can show a secret only once.
 */
type RegisteredClient = {
  name: string;
  homepageUrl: string;
  callbackUrls: string[];
  owner: string;
  confidential: boolean;
  secretHashes: string[];
  /** The settings path segment, for clients registered by a person. */
  appId?: string;
};

const hashSecret = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

const digits = (length: number) =>
  Array.from({ length }, () => randomInt(0, 10)).join("");

export async function startAuthProvider(
  behavior: ProviderBehavior = {},
): Promise<ProviderDouble> {
  const layout = behavior.layout ?? "randomized";
  let markup = createMarkup(behavior.seed ?? 1, layout);
  /** A two-step sign-in, asked for directly or implied by the layout. */
  const identifierFirst =
    behavior.identifierFirst ?? layout === "identifier-first";
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
  /** Region chosen at registration, by address. */
  const regions = new Map<string, string>();
  const newsletter = new Set<string>();
  const newsletterField = "news_opt_in";
  /** Identifier-first: which account a browser named before its password. */
  const identified = new Map<string, string>();
  /** Challenge tokens issued, and the browsers that have cleared one. */
  const challenges = new Set<string>();
  const cleared = new Set<string>();
  const installations = new Set<string>();
  const assertions = new Set<string>();
  const basicAccounts = new Set<string>();
  const idTokenKey = randomBytes(32);
  const verdicts: SignatureVerdict[] = [];
  const actorKey = randomBytes(32);
  const knownActors = new Set(behavior.knownActors ?? []);
  let closed = false;
  const clients = new Map<string, string>();
  const tokens = new Map<string, string>();
  /** The OAuth client registry `strictClients` enforces. */
  const registry = new Map<string, RegisteredClient>();
  /** Settings path segment → client ID, for apps a person registered. */
  const appIds = new Map<string, string>();
  /** A secret waiting to be shown once, keyed by session and app. */
  const reveals = new Map<string, string>();
  /** Access tokens issued at the token endpoint, for introspection and userinfo. */
  const accessTokens = new Map<
    string,
    { sub: string; clientId: string; scope: string }
  >();
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
  registry.set(clientId, {
    name: "Ceremony Test Client",
    homepageUrl: origin,
    callbackUrls: [redirectUri],
    owner: "",
    confidential: false,
    secretHashes: [],
  });

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
    const raw = method === "POST" ? await readText(request) : "";
    const body = new URLSearchParams(raw);
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

    const challengePage = (status = 200) => {
      // The widget is the real obstacle; the form beside it is what a person
      // submits once they have satisfied it in their own browser.
      const token = randomBytes(8).toString("hex");
      if (behavior.challengeClearable) challenges.add(token);
      return send(
        status,
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

    /**
     * The Web Bot Auth gate. A request carrying a signature this origin can
     * verify goes straight to the page it asked for; anything else gets 403
     * and the same interstitial a person would have to clear. The draft's
     * `Accept-Signature` says what would have been accepted, so an agent that
     * can sign learns to, rather than only learning it was refused.
     */
    const signatureGate = async (): Promise<boolean> => {
      if (!behavior.requireSignature) return true;
      const verdict = await verifyRequestSignature(
        request.headers as Record<string, string | string[] | undefined>,
        request.headers.host ?? "",
      );
      verdicts.push(verdict);
      if (verdict.ok) return true;
      // A cleared challenge stands in for the human-verified cookie a real
      // interstitial sets, so a person's work is not demanded on every page.
      if (cleared.has(browser())) return true;
      response.setHeader(
        "accept-signature",
        'sig=("@authority");keyid;created;expires;tag="web-bot-auth"',
      );
      challengePage(403);
      return false;
    };

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
      if (markup.pages)
        return send(
          200,
          markup.pages.signIn({
            action,
            next,
            signupPath: markup.signupPath,
            ...(error ? { error } : {}),
            identifierOnly: identifierFirst,
            conditionalPasskey: behavior.conditionalPasskey === true,
            inert: behavior.inertSignIn === true,
          }),
        );
      const fields = markup.arrange("sign-in", [
        markup.field(
          markup.labels.identifier,
          markup.names.identifier,
          "text",
          behavior.conditionalPasskey
            ? 'required autocomplete="username webauthn"'
            : "required",
        ),
        ...(identifierFirst
          ? []
          : [
              markup.field(
                markup.labels.password,
                markup.names.password,
                "password",
                "required",
              ),
            ]),
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
      if (markup.pages)
        return send(
          200,
          markup.pages.signUp({
            action: `${markup.signupPath}?next=${encodeURIComponent(next)}`,
            next,
            ...(error ? { error } : {}),
            inUse: error === markup.messages.emailInUse,
            ...(behavior.requireRegion ? { regions: regionList } : {}),
            ...(behavior.offerNewsletter
              ? { newsletter: newsletterField }
              : {}),
          }),
        );
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
        ...(behavior.requireRegion
          ? [
              // Labelled by `for`, not by wrapping: a wrapping label's text
              // would take in every option's too.
              `<label for="field_${regionField}">Country or region</label> <select id="field_${regionField}" name="${regionField}" required>${regionOptions}</select>`,
            ]
          : []),
        ...(behavior.requireTerms
          ? [markup.checkbox(markup.labels.terms, markup.names.terms)]
          : []),
        ...(behavior.offerNewsletter
          ? [
              markup.checkbox(
                "Send me product news and special offers",
                newsletterField,
              ),
            ]
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
      markup.pages
        ? send(
            200,
            markup.pages.verifyEmail({
              action: `/confirm?p=${token}&next=${encodeURIComponent(next)}`,
              resendAction: `/resend?p=${token}`,
              address: pending.get(token)?.email ?? "",
              mode: verification === "link" ? "link" : "code",
              ...(error ? { error } : {}),
            }),
          )
        : send(
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
        markup.pages
          ? markup.pages.twoFactor({
              action: `/mfa?next=${encodeURIComponent(target)}`,
              ...(error ? { error } : {}),
            })
          : markup.page(
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

    const passwordPage = (next: string, error?: string) =>
      markup.pages
        ? send(
            200,
            markup.pages.password({
              next,
              identifier: identified.get(browser()) ?? "",
              ...(error ? { error } : {}),
            }),
          )
        : send(
            200,
            markup.page(
              "Password",
              `${markup.alert(error)}
           <h1>${markup.headings.signIn}</h1>
           <form method="post" action="/signin/password?next=${encodeURIComponent(next)}">
             ${markup.field(markup.labels.password, markup.names.password, "password", "required")}
             <button type="submit">${markup.captions.signIn}</button>
           </form>`,
            ),
          );

    /** Whether a submitted second factor is the one this account expects. */
    const codeAccepted = (account: Account, code: string) =>
      behavior.totpSeed
        ? [-30_000, 0, 30_000].some(
            (skew) => totpCode(behavior.totpSeed!, Date.now() + skew) === code,
          )
        : code === account.totp;

    /** A verified account's password was accepted: the second factor, or in. */
    const signedIn = (found: Account) => {
      const cookie = openSession(found.email, behavior.requireMfa ? 1 : 2);
      if (behavior.requireMfa) {
        const id = cookie.slice("sid=".length, cookie.indexOf(";"));
        return mfaPage(id, next);
      }
      return redirect(next, { "set-cookie": cookie });
    };

    /** An unconfirmed account's password was accepted: mail a code first. */
    const confirmUnverified = (found: Account) => {
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
    };

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

    /**
     * The client a token-endpoint request presents, by `client_secret_basic`
     * or, failing that, `client_secret_post`. Basic credentials are
     * form-urlencoded before encoding (RFC 6749 section 2.3.1), so they are
     * decoded the same way; a malformed header presents nobody.
     */
    const presentedClient = ():
      { clientId: string; secret?: string } | undefined => {
      const header = request.headers.authorization ?? "";
      if (/^basic\s/i.test(header)) {
        const decoded = Buffer.from(header.slice(6).trim(), "base64").toString(
          "utf8",
        );
        const at = decoded.indexOf(":");
        if (at <= 0) return undefined;
        try {
          return {
            clientId: decodeURIComponent(decoded.slice(0, at)),
            secret: decodeURIComponent(decoded.slice(at + 1)),
          };
        } catch {
          return undefined;
        }
      }
      const id = body.get("client_id");
      if (!id) return undefined;
      const secret = body.get("client_secret");
      return secret ? { clientId: id, secret } : { clientId: id };
    };
    /**
     * Whether the presented client is one this provider knows and has proved
     * itself: a confidential client by one of its secrets, a public client by
     * presenting none.
     */
    const authenticatedClient = (presented = presentedClient()) => {
      const client = presented ? registry.get(presented.clientId) : undefined;
      if (!presented || !client) return undefined;
      if (!client.confidential) return presented.secret ? undefined : presented;
      return presented.secret &&
        client.secretHashes.includes(hashSecret(presented.secret))
        ? presented
        : undefined;
    };
    const invalidClient = () =>
      json(
        401,
        { error: "invalid_client" },
        { "www-authenticate": 'Basic realm="token"' },
      );

    const next = url.searchParams.get("next") ?? "/";

    // The challenge endpoint has to stay reachable, or a person sent to clear
    // the interstitial would be refused on the way to clearing it.
    if (url.pathname !== "/challenge" && !(await signatureGate())) return;

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
        ...(behavior.strictClients
          ? {
              introspection_endpoint: `${origin}/oauth/introspect`,
              token_endpoint_auth_methods_supported: [
                "client_secret_basic",
                "client_secret_post",
                "none",
              ],
            }
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
        if (markup.pages)
          return send(
            503,
            markup.pages.unavailable({
              retryHref: `${url.pathname}?next=${encodeURIComponent(next)}`,
            }),
          );
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
      if (identifierFirst) {
        const named = [...accounts.values()].find(
          (account) =>
            account.username.toLowerCase() === identifier.toLowerCase() ||
            account.email.toLowerCase() === identifier.toLowerCase(),
        );
        if (!named) return signInPage(next, markup.messages.rejected);
        identified.set(browser(), named.email.toLowerCase());
        return redirect(`/signin/password?next=${encodeURIComponent(next)}`);
      }
      const password = body.get(markup.names.password) ?? "";
      const found = [...accounts.values()].find(
        (account) =>
          account.username.toLowerCase() === identifier.toLowerCase() ||
          account.email.toLowerCase() === identifier.toLowerCase(),
      );
      if (!found || found.password !== password)
        return signInPage(next, markup.messages.rejected);
      if (!found.verified) return confirmUnverified(found);
      return signedIn(found);
    }

    if (url.pathname === "/signin/password" && identifierFirst) {
      const email = identified.get(browser());
      const found = email ? accounts.get(email) : undefined;
      if (!found) return redirect(`/signin?next=${encodeURIComponent(next)}`);
      if (method === "GET") return passwordPage(next);
      if ((body.get(markup.names.password) ?? "") !== found.password)
        return passwordPage(next, markup.messages.rejected);
      identified.delete(browser());
      // The same rule as the one-page form: a right password on an
      // unconfirmed account earns a confirmation step, not a session.
      if (!found.verified) return confirmUnverified(found);
      return signedIn(found);
    }

    // Who this browser is signed in as, for a verifier asking through the
    // browser's own cookies. A session still owed its second factor is not
    // signed in.
    if (url.pathname === "/api/whoami") {
      const session = sessionOf(request);
      if (!session || session.factors < 2) return json(401, {});
      const account = accounts.get(session.email.toLowerCase());
      return json(200, { account: account?.username ?? session.email });
    }

    if (url.pathname === "/mfa") {
      const session = sessionOf(request);
      if (!session) return redirect("/signin");
      if (method === "GET") {
        const id = cookies(request)["sid"] ?? "";
        return mfaPage(id, next);
      }
      const account = accounts.get(session.email.toLowerCase());
      if (
        !account ||
        !codeAccepted(account, body.get(markup.names.code) ?? "")
      ) {
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
      const region = body.get(regionField) ?? "";
      if (
        behavior.requireRegion &&
        !regionList.some((entry) => entry.code === region)
      )
        return signUpPage(next, "Choose your country or region.");
      if (!email.includes("@") || password.length < 8)
        return signUpPage(
          next,
          "Enter an email address and a password of at least 8 characters.",
        );
      if (password !== confirm)
        return signUpPage(next, markup.messages.mismatch);
      if (accounts.has(email))
        return signUpPage(next, markup.messages.emailInUse);
      if (behavior.requireRegion) regions.set(email, region);
      if (behavior.offerNewsletter && body.get(newsletterField) === "yes")
        newsletter.add(email);
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
      // A client this provider does not know, or a callback it never
      // registered, is refused on a page of its own and never redirected:
      // redirecting would hand whatever follows to an address nobody vouched
      // for (RFC 6749 section 4.1.2.1). Checked before sign-in, so nobody
      // signs in on behalf of an application that does not exist.
      if (behavior.strictClients) {
        const known = registry.get(url.searchParams.get("client_id") ?? "");
        const callback = url.searchParams.get("redirect_uri") ?? "";
        if (!known || !known.callbackUrls.includes(callback))
          return send(
            400,
            markup.page(
              "Application error",
              `<h1>${known ? "Redirect URI mismatch" : "Application not found"}</h1>
               ${markup.alert(
                 known
                   ? "The redirect_uri in this request is not the authorization callback URL registered for this application."
                   : "The client_id in this request does not belong to a registered OAuth app.",
               )}`,
            ),
          );
      }
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
      if (markup.pages)
        return send(
          200,
          markup.pages.consent({
            requestId,
            clientId: url.searchParams.get("client_id") ?? clientId,
            scope: url.searchParams.get("scope") ?? "",
            account: session.email,
            actor: behavior.delegation ? actor : "",
            ...(behavior.strictClients
              ? {
                  application:
                    registry.get(url.searchParams.get("client_id") ?? "")
                      ?.name ?? "",
                }
              : {}),
          }),
        );
      const delegation =
        behavior.delegation && actor
          ? `<p>${markup.escape(actor)} will act on your behalf.</p>`
          : "";
      return send(
        200,
        markup.page(
          "Authorize",
          `<h1>${markup.headings.consent}</h1>
           <p>${markup.escape(
             (behavior.strictClients
               ? registry.get(url.searchParams.get("client_id") ?? "")?.name
               : undefined) ?? clientId,
           )} is requesting ${markup.escape(url.searchParams.get("scope") ?? "access")}.</p>
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
      // Under a registry, the client authenticates before anything about the
      // code is looked at, and a code redeems only for the client it was
      // issued to.
      let authenticated: { clientId: string } | undefined;
      if (behavior.strictClients) {
        authenticated = authenticatedClient();
        if (!authenticated) return invalidClient();
      }
      const code = body.get("code") ?? "";
      const grant = grants.get(code);
      const verifier = body.get("code_verifier") ?? "";
      const derived = createHash("sha256").update(verifier).digest("base64url");
      if (
        !grant ||
        grant.verifier !== derived ||
        body.get("redirect_uri") !== grant.redirectUri ||
        (authenticated && authenticated.clientId !== grant.clientId)
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
      accessTokens.set(String(issued["access_token"]), {
        sub: grant.email,
        clientId: grant.clientId,
        scope: "openid",
      });
      if (behavior.openidConnect)
        // A real signed assertion, so a consumer's nonce and issuer checks are
        // exercised rather than assumed.
        issued["id_token"] = await new SignJWT({
          nonce: grant.nonce,
          email: grant.email,
        })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer(origin)
          .setAudience(grant.clientId || clientId)
          .setSubject(grant.email)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(idTokenKey);
      return json(200, issued);
    }

    if (url.pathname === "/userinfo") {
      // A relying party asks with the access token it redeemed, server to
      // server, where there is no browser cookie to read.
      const bearer = /^bearer\s+(.+)$/i.exec(
        request.headers.authorization ?? "",
      )?.[1];
      if (bearer) {
        const token = accessTokens.get(bearer.trim());
        if (!token) return json(401, { error: "invalid_token" });
        return json(200, { sub: token.sub, email: token.sub });
      }
      const session = sessionOf(request);
      if (!session) return json(401, { error: "invalid_token" });
      return json(200, { sub: session.email, email: session.email });
    }

    if (url.pathname === "/device") {
      const session = sessionOf(request);
      if (!session)
        return redirect(`/signin?next=${encodeURIComponent("/device")}`);
      // A realistic layout renders the verification page whole, in its own
      // shell; the randomized one assembles it from parts below.
      if (markup.pages) {
        if (method === "GET")
          return send(
            200,
            markup.pages.device({ action: "/device", account: session.email }),
          );
        const entered = (body.get(markup.names.userCode) ?? "")
          .replace(/[\s-]/g, "")
          .toUpperCase();
        const device = devices.get(entered);
        if (!device)
          return send(
            200,
            markup.pages.device({
              action: "/device",
              account: session.email,
              error: markup.messages.badCode,
            }),
          );
        device.approved = true;
        device.email = session.email;
        return send(200, markup.pages.deviceConnected());
      }
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

    // Developer settings: a person registers an OAuth app and generates its
    // client secret, which is shown once and then only ever held as a hash.
    if (url.pathname === "/settings/developers") return redirect(oauthAppsPath);
    if (
      url.pathname === oauthAppsPath ||
      url.pathname.startsWith(`${oauthAppsPath}/`)
    ) {
      const session = sessionOf(request);
      if (!session || (behavior.requireMfa && session.factors < 2))
        return redirect(
          `/signin?next=${encodeURIComponent(url.pathname + url.search)}`,
        );
      const pages = developerSettingsPages(markup);
      const owned = [...registry.entries()].filter(
        ([, client]) => client.owner === session.email && client.appId,
      );
      const view = (id: string, client: RegisteredClient) => ({
        id: client.appId ?? "",
        clientId: id,
        name: client.name,
        homepageUrl: client.homepageUrl,
        callbackUrl: client.callbackUrls[0] ?? "",
        secrets: client.secretHashes.length,
      });
      if (url.pathname === oauthAppsPath)
        return send(
          200,
          pages.list(owned.map(([id, client]) => view(id, client))),
        );
      if (url.pathname === `${oauthAppsPath}/new`) {
        // Values may arrive in the query, as a relying app's "register this
        // app" link fills them in; the person still reviews and submits.
        const source = method === "POST" ? body : url.searchParams;
        const values: NewOAuthAppValues = {
          name: (
            source.get("application_name") ??
            source.get("name") ??
            ""
          ).trim(),
          homepageUrl: (source.get("homepage_url") ?? "").trim(),
          description: (source.get("description") ?? "").trim(),
          callbackUrl: (source.get("callback_url") ?? "").trim(),
        };
        if (method === "GET") return send(200, pages.newApp(values));
        const web = (value: string) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === "https:" || parsed.protocol === "http:";
          } catch {
            return false;
          }
        };
        const problem = !values.name
          ? "Application name can't be blank."
          : values.name.length > 100
            ? "Application name is too long."
            : !web(values.homepageUrl)
              ? "Homepage URL must be a valid URL."
              : !web(values.callbackUrl)
                ? "Authorization callback URL must be a valid URL."
                : undefined;
        if (problem) return send(422, pages.newApp(values, problem));
        const id = `oac_${randomBytes(10).toString("hex")}`;
        const appId = String(appIds.size + 1);
        appIds.set(appId, id);
        registry.set(id, {
          name: values.name,
          homepageUrl: values.homepageUrl,
          callbackUrls: [values.callbackUrl],
          owner: session.email,
          confidential: true,
          secretHashes: [],
          appId,
        });
        return redirect(`${oauthAppsPath}/${appId}`);
      }
      const [appId, action] = url.pathname
        .slice(oauthAppsPath.length + 1)
        .split("/");
      const id = appIds.get(appId ?? "");
      const client = id ? registry.get(id) : undefined;
      if (!id || !client || client.owner !== session.email)
        return send(404, markup.page("Not found", "<h1>Not found</h1>"));
      const sid = cookies(request)["sid"] ?? "";
      const revealKey = `${sid}:${appId}`;
      if (action === "secrets" && method === "POST") {
        const secret = `ocs_${randomBytes(20).toString("hex")}`;
        client.secretHashes.push(hashSecret(secret));
        reveals.set(revealKey, secret);
        return redirect(`${oauthAppsPath}/${appId}`);
      }
      if (action !== undefined)
        return send(404, markup.page("Not found", "<h1>Not found</h1>"));
      // Shown to the session that generated it, on the next page, once.
      const revealed = reveals.get(revealKey);
      reveals.delete(revealKey);
      return send(200, pages.app(view(id, client), revealed));
    }

    // RFC 7662 token introspection. Only a client that authenticates may ask,
    // and it learns about its own tokens only; asking with a made-up token is
    // also how a relying party checks, before it saves them, that a client ID
    // and secret are ones this provider accepts.
    if (url.pathname === "/oauth/introspect" && method === "POST") {
      if (!behavior.strictClients) return json(404, { error: "not_found" });
      const presented = authenticatedClient();
      if (!presented || !registry.get(presented.clientId)?.confidential)
        return invalidClient();
      const token = accessTokens.get(body.get("token") ?? "");
      if (!token || token.clientId !== presented.clientId)
        return json(200, { active: false });
      return json(200, {
        active: true,
        client_id: token.clientId,
        sub: token.sub,
        scope: token.scope,
        token_type: "Bearer",
      });
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
      // Under a registry the redirect URIs a client registers are the only
      // ones `/authorize` will send it back to, so they are required.
      if (behavior.strictClients) {
        let requested: unknown;
        try {
          requested = (JSON.parse(raw) as { redirect_uris?: unknown })
            .redirect_uris;
        } catch {
          requested = undefined;
        }
        const uris = Array.isArray(requested)
          ? requested.filter((uri): uri is string => typeof uri === "string")
          : [];
        if (uris.length === 0)
          return json(400, { error: "invalid_redirect_uri" });
        registry.set(id, {
          name: id,
          homepageUrl: "",
          callbackUrls: uris,
          owner: "",
          confidential: false,
          secretHashes: [],
        });
      }
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
    get markup() {
      return markup;
    },
    restyle(seed: number) {
      markup = createMarkup(seed, layout);
    },
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
    issuedDeviceCodes: () => [...devices.keys()],
    deviceApprovedBy: (userCode) => {
      const device = devices.get(userCode);
      return device?.approved ? device.email : undefined;
    },
    regionOf: (email) => regions.get(email.toLowerCase()),
    newsletterSubscribers: () => [...newsletter],
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
    oauthApps: () =>
      [...registry.entries()]
        .filter(([, client]) => client.appId !== undefined)
        .map(([id, client]) => ({
          clientId: id,
          name: client.name,
          homepageUrl: client.homepageUrl,
          callbackUrl: client.callbackUrls[0] ?? "",
          owner: client.owner,
          secrets: client.secretHashes.length,
        })),
    installed: () => [...installations],
    federated: () => [...assertions],
    authenticatedBasic: () => [...basicAccounts],
    signatureVerdicts: () => [...verdicts],
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
