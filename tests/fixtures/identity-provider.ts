import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * A self-hosted identity provider that browser-login tests can interrogate as
 * an INDEPENDENT ORACLE.
 *
 * An agent's "I signed in" message and a page's own markup are both authored by
 * the thing under test, so neither can establish that a login happened. This
 * fixture holds the sessions, so asking it who a cookie belongs to
 * (`accountForCookie`, `/api/whoami`) is the one statement about a login the
 * subject cannot forge. `/forged` exists to make that gap observable: it looks
 * signed in and is not.
 *
 * It serves the contract the rest of the repo already depends on: the extension's
 * `verify-fixture` message requires `/account` to expose
 * `<data id="account" value="X">X</data>`, and the `owned-fixture-login` catalog
 * profile declares `verification: { strategy: "fixture-account", path: "/account" }`.
 */

/** Synthetic account. Nothing here is a real credential for any service. */
export type FixtureAccount = {
  /** Stable identifier `/account` and `/api/whoami` report. */
  readonly account: string;
  /** What a person types into the identifier field. */
  readonly identifier: string;
  /** Synthetic secret. Compared only; never rendered outside `/echo`, never logged. */
  readonly password: string;
};

/** One credential-bearing POST, as the SERVER saw it. Values are excluded. */
export type CredentialSubmission = {
  /**
   * Account the submission claimed. Unknown identifiers are recorded verbatim so
   * a wrong attempt is still countable; empty when the POST claimed no identity.
   */
  readonly account: string;
  /**
   * Whether the submitted password matched. The identifier-first step records
   * `false` because it carries no password at all — `path` separates the two.
   */
  readonly passwordMatched: boolean;
  readonly at: number;
  /** Route that received it, so the two-document flow's steps stay distinct. */
  readonly path: string;
};

/** A field value that actually reached the server, for canary assertions. */
export type EchoedField = {
  readonly path: string;
  readonly field: string;
  readonly value: string;
  readonly at: number;
};

export type IdentityFixtureOptions = {
  readonly accounts?: readonly FixtureAccount[];
  /** How long `/slow` waits before navigating to `/account`. */
  readonly slowDelayMs?: number;
};

export type IdentityOrigin = {
  /** Canonical loopback origin on an ephemeral port; never a hardcoded one. */
  readonly origin: string;
  readonly accounts: readonly FixtureAccount[];
  url(path: string): string;
  /** Every credential submission received, oldest first. */
  submissions(): readonly CredentialSubmission[];
  /** Session identifiers the server currently believes belong to `account`. */
  sessionsFor(account: string): readonly string[];
  /**
   * The server's own answer to "whose session is this?". Accepts a bare session
   * id, a `Cookie` header or a `Set-Cookie` header, because a test holds
   * whichever of those `fetch` happened to hand it.
   */
  accountForCookie(cookie: string): string | undefined;
  canary: {
    /** Absolute URL of the echo page. */
    readonly url: string;
    received(): readonly EchoedField[];
    /** Whether `value` ever reached this origin in a submitted field. */
    sawValue(value: string): boolean;
  };
  /**
   * Subresource requests this origin served, oldest first.
   *
   * Separate from `submissions` because they answer different questions. A
   * submission is a credential arriving; a subresource is the browser fetching
   * something a page asked for. ORIGIN-RESOURCE is about the second, and the
   * honest answer there is that nothing contains it.
   */
  resourceHits(): readonly string[];
  /** Drop sessions and recordings so one server can serve independent cases. */
  reset(): void;
  close(): Promise<void>;
};

export type IdentityFixture = IdentityOrigin & {
  /** A second origin from the same helper, for multi-origin SSO-ish navigation. */
  readonly partner: IdentityOrigin;
};

/** Two accounts with distinct identifiers AND distinct passwords, so a test
 * cannot pass by confusing one for the other. */
export const defaultFixtureAccounts: readonly FixtureAccount[] = [
  {
    account: "account-owner",
    identifier: "owner@fixture.test",
    password: "fixture-owner-secret-7!",
  },
  {
    account: "account-deputy",
    identifier: "deputy@fixture.test",
    password: "fixture-deputy-secret-9!",
  },
];

const sessionCookie = "ceremony_session";
const identifiedCookie = "ceremony_identified";
const cookieAttributes = "Path=/; HttpOnly; SameSite=Strict";
/** Bound the body a fixture will buffer; a test should never need more. */
const maxBodyBytes = 64_000;

const htmlEntities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escaped so the canary proves a value ARRIVED, never that it executed. */
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => htmlEntities[character] ?? character,
  );

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title></head><body>${body}</body></html>`;

const identifierField =
  '<label for="identifier">Email</label>' +
  '<input id="identifier" name="identifier" type="text" autocomplete="username">';
const passwordField =
  '<label for="password">Password</label>' +
  '<input id="password" name="password" type="password" autocomplete="current-password">';
const submitField = '<button id="submit" type="submit">Sign in</button>';
/**
 * The same identifier control, carrying the WebAuthn autocomplete hint.
 *
 * This is what conditional passkey UI actually looks like on a real provider:
 * the browser may offer a passkey in the identifier field, and the form still
 * accepts a password for everyone who does not have one. It is the common
 * shape now, not an edge case, which is why telling it apart from a page that
 * can *only* be answered by an authenticator matters so much.
 */
const conditionalIdentifierField =
  '<label for="identifier">Email</label>' +
  '<input id="identifier" name="identifier" type="text" autocomplete="username webauthn">';

/** Alert markup matching `snapshotSelectors.alerts`, so a refusal is observable. */
const alert = (message: string) =>
  `<p role="alert" class="form-error">${escapeHtml(message)}</p>`;

function cookiesOf(request: IncomingMessage): Map<string, string> {
  const jar = new Map<string, string>();
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index > 0)
      jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return jar;
}

async function readFields(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > maxBodyBytes) throw new Error("Fixture body bound exceeded");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function startOrigin(
  accounts: readonly FixtureAccount[],
  slowDelayMs: number,
  peer: () => string,
): Promise<IdentityOrigin> {
  /** Server-side truth. A cookie is evidence only because this map says so. */
  const sessions = new Map<string, string>();
  /** Half-finished identifier-first flows: token -> account, no session yet. */
  const identified = new Map<string, string>();
  const submissions: CredentialSubmission[] = [];
  const echoes: EchoedField[] = [];
  const resources: string[] = [];
  let origin = "";

  const byIdentifier = (value: string) =>
    accounts.find((candidate) => candidate.identifier === value);
  const byAccount = (value: string) =>
    accounts.find((candidate) => candidate.account === value);

  const html = (response: ServerResponse, body: string, status = 200) => {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      // A cached /account could report a session that no longer exists, which
      // would make the oracle lie about the present.
      "cache-control": "no-store",
    });
    response.end(body);
  };
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  };
  const redirect = (
    response: ServerResponse,
    location: string,
    setCookie: readonly string[] = [],
  ) => {
    response.writeHead(303, {
      location,
      ...(setCookie.length ? { "set-cookie": [...setCookie] } : {}),
    });
    response.end();
  };

  const accountOf = (request: IncomingMessage) => {
    const id = cookiesOf(request).get(sessionCookie);
    return id === undefined ? undefined : sessions.get(id);
  };
  const openSession = (account: string) => {
    const id = randomUUID();
    sessions.set(id, account);
    return `${sessionCookie}=${id}; ${cookieAttributes}`;
  };
  const clear = (name: string) => `${name}=; ${cookieAttributes}; Max-Age=0`;

  const signInForm = (action: string, fields: string, error: string | null) =>
    `<h1>Sign in</h1>${error ? alert("That identifier and password were not accepted.") : ""}` +
    `<form method="post" action="${action}">${fields}${submitField}</form>`;

  function record(path: string, account: string, passwordMatched: boolean) {
    submissions.push({ account, passwordMatched, at: Date.now(), path });
  }

  async function post(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const fields = await readFields(request);
    const at = Date.now();
    // Every field value is retained, which is what lets a canary test prove a
    // secret reached — or never reached — this origin.
    for (const [field, value] of fields)
      echoes.push({ path, field, value, at });
    // Real pages disagree on the identifier field's name; accept both rather
    // than making the oracle depend on one page's spelling.
    const identifier = fields.get("identifier") ?? fields.get("username") ?? "";
    const password = fields.get("password") ?? "";

    if (path === "/signin" || path === "/login") {
      const match = byIdentifier(identifier);
      const passwordMatched = !!match && match.password === password;
      record(path, match?.account ?? identifier, passwordMatched);
      if (!match || !passwordMatched)
        return redirect(response, "/signin?error=invalid");
      return redirect(response, "/account", [openSession(match.account)]);
    }

    if (path === "/signin-conditional") {
      // Identical to `/signin` in every way that matters: the password is
      // what completes it. The only difference is the hint on the identifier,
      // which must not change the outcome.
      const match = accounts.find(
        (candidate) => candidate.identifier === identifier,
      );
      record(path, match?.account ?? identifier, match?.password === password);
      if (!match || match.password !== password)
        return redirect(response, "/signin-conditional?error=1");
      return redirect(response, "/account", [openSession(match.account)]);
    }

    if (path === "/signin-window") {
      // `/signin`, in a window. Recorded under its own path so a case can say
      // the credential went through the window and not through the page.
      const match = byIdentifier(identifier);
      const passwordMatched = !!match && match.password === password;
      record(path, match?.account ?? identifier, passwordMatched);
      if (!match || !passwordMatched)
        return redirect(response, "/signin-window?error=invalid");
      return redirect(response, "/window-done", [openSession(match.account)]);
    }

    if (path === "/signin-identifier") {
      const match = byIdentifier(identifier);
      record(path, match?.account ?? identifier, false);
      if (!match) return redirect(response, "/signin-identifier?error=invalid");
      const token = randomUUID();
      identified.set(token, match.account);
      return redirect(response, "/signin-password", [
        `${identifiedCookie}=${token}; ${cookieAttributes}`,
      ]);
    }

    if (path === "/signin-password") {
      const token = cookiesOf(request).get(identifiedCookie);
      const claimed = token === undefined ? undefined : identified.get(token);
      const match = claimed === undefined ? undefined : byAccount(claimed);
      const passwordMatched = !!match && match.password === password;
      record(path, claimed ?? "", passwordMatched);
      if (!match || !passwordMatched)
        return redirect(response, "/signin-password?error=invalid");
      if (token !== undefined) identified.delete(token);
      return redirect(response, "/account", [
        openSession(match.account),
        clear(identifiedCookie),
      ]);
    }

    if (path === "/passkey") {
      // A passkey page has no password to match; recording it keeps "every
      // credential submission" literally true and keeps the budget countable.
      record(path, identifier, false);
      return html(
        response,
        page(
          "Passkey",
          `${alert("This account requires a passkey; no password can complete it.")}${passkeyBody()}`,
        ),
      );
    }

    return html(response, page("Not found", "<h1>Not found</h1>"), 404);
  }

  const passkeyBody = () =>
    '<h1>Use your passkey</h1><form method="post" action="/passkey">' +
    '<label for="credential">Passkey</label>' +
    '<input id="credential" name="credential" type="text" autocomplete="webauthn">' +
    '<button id="submit" type="submit">Continue</button></form>';

  function get(url: URL, request: IncomingMessage, response: ServerResponse) {
    const path = url.pathname;
    const error = url.searchParams.get("error");
    const account = accountOf(request);

    // `/login` is the entry path the browser-login catalog profile declares;
    // `/signin` is this fixture's own name for the same combined document.
    if (path === "/signin" || path === "/login")
      return html(
        response,
        page(
          "Sign in",
          signInForm("/signin", identifierField + passwordField, error),
        ),
      );

    if (path === "/signin-conditional")
      return html(
        response,
        page(
          "Sign in",
          signInForm(
            "/signin-conditional",
            conditionalIdentifierField + passwordField,
            error,
          ),
        ),
      );

    if (path === "/signin-identifier")
      return html(
        response,
        page(
          "Sign in",
          signInForm("/signin-identifier", identifierField, error),
        ),
      );

    if (path === "/signin-password") {
      const token = cookiesOf(request).get(identifiedCookie);
      // A password document that was never reached through step one is not
      // step two; rendering it anyway would let a test skip the flow it claims.
      if (token === undefined || !identified.has(token))
        return html(
          response,
          page(
            "Sign in",
            `<h1>Start again</h1><a href="/signin-identifier">Enter your email</a>`,
          ),
        );
      return html(
        response,
        page("Sign in", signInForm("/signin-password", passwordField, error)),
      );
    }

    if (path === "/account")
      return html(
        response,
        page(
          "Account",
          account === undefined
            ? // No marker at all when signed out: the element IS the contract, so
              // rendering an empty one would already be a false positive.
              '<h1>Signed out</h1><p id="banner">Not signed in.</p><a href="/signin">Sign in</a>'
            : `<h1>Account</h1><data id="account" value="${escapeHtml(
                account,
              )}">${escapeHtml(account)}</data><a href="/signout">Sign out</a>`,
        ),
      );

    if (path === "/api/whoami")
      return account === undefined
        ? json(response, 401, { error: "unauthenticated" })
        : json(response, 200, { account });

    if (path === "/forged") {
      // Convincing markup, no session. It even carries the contract's own data
      // element, so a test that trusts the DOM passes here and the oracle does
      // not — which is the whole point of shipping this page.
      const pretend = accounts[0]?.account ?? "account-unknown";
      return html(
        response,
        page(
          "Account",
          `<h1>Account</h1><p id="banner">Signed in as ${escapeHtml(
            pretend,
          )}</p><data id="account" value="${escapeHtml(pretend)}">${escapeHtml(
            pretend,
          )}</data><a href="/signout">Sign out</a>`,
        ),
      );
    }

    if (path === "/slow") {
      const requested = Number(url.searchParams.get("ms"));
      const wait = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 0), 60_000)
        : slowDelayMs;
      // The delay is client-side on purpose: a pending server timer would keep
      // the process alive and turn a settling test into a hang.
      return html(
        response,
        page(
          "Signing in",
          `<h1>Signing you in</h1><p id="progress" data-slow-delay="${wait}">Working…</p>` +
            `<a id="continue" href="/account">Continue</a>` +
            `<script>setTimeout(function(){location.assign("/account");}, ${wait});</script>`,
        ),
      );
    }

    if (path === "/challenge")
      // Matches `snapshotSelectors.challenge` through both `[data-captcha]` and
      // `.g-recaptcha`, so detection is not tied to one selector alternative.
      return html(
        response,
        page(
          "Verify",
          '<h1>Verify you are human</h1><div class="g-recaptcha" data-captcha="fixture-challenge">Challenge</div>' +
            `<form method="post" action="/signin">${identifierField}${passwordField}${submitField}</form>`,
        ),
      );

    if (path === "/passkey")
      // The only credential control carries the WebAuthn autocomplete hint and
      // there is no password input anywhere, so the page classifies as passkey.
      return html(response, page("Passkey", passkeyBody()));

    if (path === "/pixel") {
      // A subresource, recorded. Nothing about it is a credential; what it
      // establishes is only that the browser fetched it from here.
      resources.push(path);
      response.writeHead(200, {
        "content-type": "image/gif",
        "cache-control": "no-store",
      });
      return response.end(
        Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
          "base64",
        ),
      );
    }

    if (path === "/resourced") {
      // A perfectly ordinary login page that also pulls one image from another
      // origin, which is what almost every real sign-in page does. The point
      // of the route is the gap it exposes: navigation is controlled, and
      // subresources are not.
      const target = peer();
      if (!target)
        return html(response, page("Resourced", "<h1>No partner origin</h1>"));
      return html(
        response,
        page(
          "Sign in",
          `<h1>Sign in</h1><img id="badge" alt="" src="${escapeHtml(
            target,
          )}/pixel" width="1" height="1">` +
            `<form method="post" action="/signin">${identifierField}${passwordField}${submitField}</form>`,
        ),
      );
    }

    if (path === "/popup") {
      // A sign-in that happens in a window the page opens, which is the shape
      // OAuth, the GitHub App and provider-run registration all take: the
      // page has no fields of its own, a button opens the provider's form in
      // a window, and the page learns the outcome when the window reports
      // back and closes. A driver has to follow the credential into the
      // window and then come back to the page that opened it.
      return html(
        response,
        page(
          "Sign in",
          `<h1>Sign in</h1><p>Continue in a window.</p>` +
            `<button id="open" type="button">Sign in</button>` +
            `<script>
document.getElementById("open").addEventListener("click", () => {
  window.open("/signin-window", "signin", "popup,width=480,height=560");
});
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data !== "signed-in") return;
  document.body.innerHTML =
    '<h1>Signed in</h1><p id="banner">The window has finished.</p>';
});
</script>`,
        ),
      );
    }

    if (path === "/popup-elsewhere") {
      // The same page, opening its window somewhere the plan never admitted.
      // Nothing about the click is different; what is different is where the
      // next document lives, and the plan is the only thing entitled to say
      // whether a credential may go there.
      const target = peer();
      if (!target)
        return html(response, page("Sign in", "<h1>No partner origin</h1>"));
      return html(
        response,
        page(
          "Sign in",
          `<h1>Sign in</h1><p>Continue in a window.</p>` +
            `<button id="open" type="button">Sign in</button>` +
            `<script>
document.getElementById("open").addEventListener("click", () => {
  window.open(${JSON.stringify(`${target}/signin`)}, "signin", "popup,width=480,height=560");
});
</script>`,
        ),
      );
    }

    if (path === "/signin-window")
      return html(
        response,
        page(
          "Sign in",
          signInForm(
            "/signin-window",
            identifierField + passwordField,
            url.searchParams.get("error"),
          ),
        ),
      );

    if (path === "/window-done")
      // The window's last act: tell the page that opened it, then leave.
      return html(
        response,
        page(
          "Signed in",
          `<h1>Signed in</h1><script>
if (window.opener) window.opener.postMessage("signed-in", location.origin);
window.close();
</script>`,
        ),
      );

    if (path === "/framed") {
      // A credential form served by a *different* origin, embedded. This is
      // the shape `frameOrigins` exists for and the one nothing could drive:
      // the outer page has no fields at all, so a driver bound to the main
      // frame sees an empty document and the login is unreachable rather
      // than merely awkward.
      //
      // The partner is a separate server with its own cookies, so a session
      // established in the frame is the partner's, which is what makes the
      // assertion about *which* origin signed the account in meaningful.
      const target = peer();
      if (!target)
        return html(response, page("Framed", "<h1>No partner origin</h1>"));
      return html(
        response,
        page(
          "Framed",
          `<h1>Sign in to continue</h1><iframe id="credentials" title="Sign in" src="${escapeHtml(
            target,
          )}/signin" width="420" height="320"></iframe>`,
        ),
      );
    }

    if (path === "/sso") {
      const target = peer();
      if (!target)
        return html(response, page("SSO", "<h1>No partner origin</h1>"));
      if (url.searchParams.get("redirect") === "1")
        return redirect(response, `${target}/signin`);
      return html(
        response,
        page(
          "SSO",
          `<h1>Continue to your identity provider</h1><a id="sso" href="${escapeHtml(
            target,
          )}/signin">Continue</a>`,
        ),
      );
    }

    if (path === "/signout") {
      const id = cookiesOf(request).get(sessionCookie);
      if (id !== undefined) sessions.delete(id);
      return redirect(response, "/account", [clear(sessionCookie)]);
    }

    if (path === "/echo")
      return html(
        response,
        page(
          "Echo",
          `<h1>Received fields</h1><ul id="echo">${echoes
            .map(
              (entry) =>
                `<li data-path="${escapeHtml(entry.path)}" data-field="${escapeHtml(
                  entry.field,
                )}">${escapeHtml(entry.value)}</li>`,
            )
            .join("")}</ul>`,
        ),
      );

    if (path === "/")
      return html(
        response,
        page(
          "Fixture",
          '<h1>Identity fixture</h1><a href="/signin">Sign in</a><a href="/account">Account</a>',
        ),
      );

    return html(response, page("Not found", "<h1>Not found</h1>"), 404);
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    const work =
      request.method === "POST"
        ? post(url.pathname, request, response)
        : Promise.resolve(get(url, request, response));
    void work.catch(() => {
      if (!response.headersSent)
        response.writeHead(500, { "content-type": "text/plain" });
      response.end("fixture error");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Identity fixture failed to bind");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    accounts,
    url: (path: string) => new URL(path, origin).href,
    submissions: () => [...submissions],
    sessionsFor: (account: string) =>
      [...sessions.entries()]
        .filter(([, value]) => value === account)
        .map(([id]) => id),
    accountForCookie: (cookie: string) => {
      const match = /(?:^|;\s*)ceremony_session=([^;]*)/.exec(cookie);
      return sessions.get((match?.[1] ?? cookie).trim());
    },
    resourceHits: () => [...resources],
    canary: {
      url: new URL("/echo", origin).href,
      received: () => [...echoes],
      sawValue: (value: string) =>
        echoes.some((entry) => entry.value === value),
    },
    reset() {
      sessions.clear();
      identified.clear();
      submissions.length = 0;
      echoes.length = 0;
      resources.length = 0;
    },
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((problem) => (problem ? reject(problem) : resolve())),
      );
      // `close` alone waits on idle keep-alive sockets, which would hang a test
      // run rather than fail it.
      server.closeAllConnections();
      await closed;
    },
  };
}

/**
 * Start the oracle on two independent loopback origins.
 *
 * The partner is a second instance of the same server, so its cookies are its
 * own: carrying a primary session to the partner proves nothing there, which is
 * exactly what makes a multi-origin navigation worth testing.
 */
export async function createIdentityFixture(
  options?: IdentityFixtureOptions,
): Promise<IdentityFixture> {
  const accounts = options?.accounts ?? defaultFixtureAccounts;
  const slowDelayMs = options?.slowDelayMs ?? 250;
  let primaryOrigin = "";
  let partnerOrigin = "";
  const primary = await startOrigin(accounts, slowDelayMs, () => partnerOrigin);
  primaryOrigin = primary.origin;
  const partner = await startOrigin(accounts, slowDelayMs, () => primaryOrigin);
  partnerOrigin = partner.origin;
  return {
    ...primary,
    partner,
    async close() {
      await Promise.all([primary.close(), partner.close()]);
    },
  };
}
