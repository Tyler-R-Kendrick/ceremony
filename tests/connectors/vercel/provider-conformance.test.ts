import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevIssuer } from "../../../examples/issuer.js";
import {
  assessConnectProviderConformance,
  discoveryLocations,
  VERCEL_CONNECT_PROVIDER_REDIRECT_URI,
  type ConformanceFinding,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { oidcIdpFixture } from "../../fixtures/oidc-idp.js";

/*
 * AC-VC-08: Ceremony on the *provider* side of Vercel Connect.
 *
 * The "For Service Providers" page states what a service must publish and
 * support so Connect can discover it, register a client and authorize against
 * it. This harness plays the Connect client against two authorization servers
 * this repository already serves - the OIDC IdP fixture and the reference
 * application's development issuer - and reports each requirement as met, not
 * met or unknown. No new IdP, no live Vercel, and no network beyond loopback.
 */

const status = (findings: ConformanceFinding[], id: string) =>
  findings.find((finding) => finding.id === id)?.status;
const detail = (findings: ConformanceFinding[], id: string) =>
  findings.find((finding) => finding.id === id)?.detail ?? "";

/** Fails the test rather than the assertion if anything leaves loopback. */
function loopbackOnlyFetch(seen: string[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error(`conformance harness reached ${url.origin}`);
    seen.push(`${url.origin}${url.pathname}`);
    return fetch(input, init);
  };
}

/**
 * The same guard, tallying requests per origin. Counting is the only way to
 * state the containment property as a test: it is not enough that the report
 * says "not met", nothing may have been sent to the other origin at all.
 */
function countingFetch(counts: Map<string, number>): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    counts.set(url.origin, (counts.get(url.origin) ?? 0) + 1);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error(`conformance harness reached ${url.origin}`);
    return fetch(input, init);
  };
}

/**
 * A server that completes the whole flow for whoever asks: it registers a
 * client and mints a token. It is deliberately co-operative, so that the only
 * thing standing between it and a real authorization code with its PKCE
 * verifier is the harness's own containment check.
 */
async function startAttacker(t: { after(fn: () => Promise<void>): void }) {
  const received: Array<{ path: string; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "/",
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          (request.url ?? "").startsWith("/register")
            ? {
                client_id: "client-the-attacker-issued",
                redirect_uris: [VERCEL_CONNECT_PROVIDER_REDIRECT_URI],
                token_endpoint_auth_method: "none",
              }
            : {
                access_token: "token-the-attacker-minted",
                token_type: "Bearer",
                expires_in: 3600,
              },
        ),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
  };
}

/**
 * Serves one RFC 8414 document at the well-known location, and registers a
 * client on its own origin - so that when a document sends only the *token*
 * endpoint elsewhere, nothing else in the flow is what stops the harness. The
 * document is built from the origin, which has to be claimed before the server
 * that publishes it can name itself.
 */
async function startMetadata(
  t: { after(fn: () => Promise<void>): void },
  document: (origin: string) => Record<string, unknown>,
) {
  const claim = createServer(() => {});
  claim.listen(0, "127.0.0.1");
  await once(claim, "listening");
  const port = (claim.address() as AddressInfo).port;
  await new Promise<void>((resolve) => claim.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const server: Server = createServer((request, response) => {
    if (request.url === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(document(origin)));
      return;
    }
    if (request.method === "POST" && request.url === "/register") {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          client_id: "client-the-probed-server-issued",
          redirect_uris: [VERCEL_CONNECT_PROVIDER_REDIRECT_URI],
          token_endpoint_auth_method: "none",
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("no metadata here");
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { origin };
}

/**
 * Drives the consent leg the way a person would be driven, and returns the
 * callback the harness needs to carry on to the token endpoint. It must never
 * be called for a document that fails containment: reaching it means a real
 * operator's browser was pointed at whatever the document named.
 */
function recordingAuthorize(handed: URL[]) {
  return async (url: URL) => {
    handed.push(url);
    const callback = new URL(VERCEL_CONNECT_PROVIDER_REDIRECT_URI);
    callback.searchParams.set("code", "code-worth-stealing");
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    return callback;
  };
}

test("discovery locations follow RFC 8414 for issuers with and without a path", () => {
  assert.deepEqual(discoveryLocations("https://auth.example.com"), {
    oauth: ["https://auth.example.com/.well-known/oauth-authorization-server"],
    oidc: ["https://auth.example.com/.well-known/openid-configuration"],
  });
  assert.deepEqual(discoveryLocations("https://auth.example.com/tenant1"), {
    oauth: [
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
    ],
    oidc: [
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
    ],
  });
});

test("a service that publishes no discovery document fails the required tier", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("no metadata here");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seen: string[] = [];
  const report = await assessConnectProviderConformance({
    serverUrl: origin,
    fetch: loopbackOnlyFetch(seen),
  });
  assert.equal(
    status(report.findings, "required.discovery-documents"),
    "not-met",
  );
  assert.equal(report.issuer, undefined);
  assert.deepEqual(report.subjectTypes, []);
  assert.equal(report.findings.length, 1, "nothing else can be assessed");
});

test("Ceremony's OIDC fixture serves discovery, PKCE and a code exchange Connect can drive", async (t) => {
  const idp = await oidcIdpFixture({ seed: 7 });
  t.after(idp.close);
  idp.accounts.set("person@example.test", {
    email: "person@example.test",
    handle: "person",
    password: "correct horse battery staple",
    verified: true,
  });
  const seen: string[] = [];
  const guarded = loopbackOnlyFetch(seen);

  const report = await assessConnectProviderConformance({
    serverUrl: idp.origin,
    fetch: guarded,
    exercise: {
      scope: "openid profile",
      async authorize(url) {
        // The consent leg a person would walk, driven over real HTTP.
        const page = await guarded(url, { redirect: "manual" });
        const html = await page.text();
        const session = /action="\/session\?s=([^"]+)"/.exec(html)?.[1];
        assert.ok(session, "the authorization page starts a session");
        const signedIn = await guarded(`${idp.origin}/session?s=${session}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            [idp.markup.identifierName]: "person",
            [idp.markup.passwordName]: "correct horse battery staple",
          }).toString(),
          redirect: "manual",
        });
        const consent = await signedIn.text();
        const token = /name="s" value="([^"]+)"/.exec(consent)?.[1];
        assert.ok(token, "sign-in reaches the consent screen");
        const granted = await guarded(`${idp.origin}/consent`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ s: token }).toString(),
          redirect: "manual",
        });
        assert.equal(granted.status, 302);
        // The redirect target is Vercel's callback. It is read, never followed.
        return new URL(granted.headers.get("location")!);
      },
    },
  });

  assert.equal(report.issuer, idp.origin);
  assert.equal(status(report.findings, "required.discovery-documents"), "met");
  assert.ok(report.discovery.oauth, "RFC 8414 metadata is served");
  assert.ok(report.discovery.oidc, "OpenID Connect metadata is served");
  assert.equal(report.discovery.issuerConsistent, true);
  assert.equal(report.discovery.tokenEndpointConsistent, true);
  assert.equal(status(report.findings, "required.grant-types-declared"), "met");
  assert.deepEqual(report.subjectTypes, ["user"]);
  assert.equal(status(report.findings, "recommended.pkce-s256"), "met");

  assert.equal(
    report.exercise?.codeExchanged,
    true,
    "code + PKCE exchange works",
  );
  assert.equal(status(report.findings, "required.expires-in"), "met");
  assert.equal(report.exercise?.refreshTokenIssued, true);
  assert.equal(
    status(report.findings, "recommended.refresh-tokens"),
    "not-met",
    "a refresh token was issued but the refresh grant is rejected",
  );
  assert.match(
    detail(report.findings, "recommended.refresh-tokens"),
    /rejected/,
  );
  assert.equal(
    status(report.findings, "recommended.client-registration"),
    "not-met",
    "a registration endpoint without a usable token_endpoint_auth_method cannot be used",
  );
  assert.match(
    detail(report.findings, "recommended.client-registration"),
    /token_endpoint_auth_method/,
  );
  assert.equal(
    status(report.findings, "required.redirect-url-accepted"),
    "unknown",
    "registration echoed no redirect_uris, so acceptance cannot be claimed",
  );
  assert.equal(
    status(report.findings, "recommended.rfc7592-client-update"),
    "not-met",
  );
  assert.equal(status(report.findings, "optional.revocation"), "not-met");
  assert.equal(
    status(report.findings, "optional.protected-resource-metadata"),
    "not-met",
  );
  assert.equal(
    idp.counts.token,
    2,
    "one code exchange and one refused refresh reached the token endpoint",
  );
  assert.ok(
    seen.some((entry) => entry.endsWith("/dcr")),
    "the client was registered dynamically",
  );
});

test("the reference development issuer honours resource indicators, and the harness reports it", async (t) => {
  // The issuer signs and advertises its own origin, so the port is claimed
  // before the issuer is built.
  const probe = createServer(() => {});
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const issuer = await createDevIssuer({
    origin,
    audiences: [`${origin}/resource`],
    subject: "conformance",
  });
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const proxied = new Request(`${origin}${request.url ?? "/"}`, {
          method: request.method ?? "GET",
          headers: Object.entries(request.headers).flatMap(([name, value]) =>
            typeof value === "string"
              ? [[name, value] as [string, string]]
              : [],
          ),
          ...(body.length ? { body } : {}),
        });
        const answer = await issuer.handle(proxied);
        if (!answer) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(
          answer.status,
          Object.fromEntries(answer.headers.entries()),
        );
        response.end(Buffer.from(await answer.arrayBuffer()));
      })();
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const seen: string[] = [];
  const guarded = loopbackOnlyFetch(seen);
  const report = await assessConnectProviderConformance({
    serverUrl: origin,
    fetch: guarded,
    exercise: {
      resource: `${origin}/resource`,
      async authorize(url) {
        const page = await guarded(url, { redirect: "manual" });
        const html = await page.text();
        const href = /href="([^"]*code=[^"]*)"/.exec(html)?.[1];
        assert.ok(href, "the development issuer shows what it is approving");
        return new URL(href.replace(/&amp;/g, "&"));
      },
    },
  });

  assert.equal(report.issuer, origin);
  assert.equal(status(report.findings, "required.discovery-documents"), "met");
  assert.equal(
    status(report.findings, "recommended.client-registration"),
    "met",
    "a registration endpoint plus token_endpoint_auth_methods_supported: none is usable",
  );
  assert.equal(
    status(report.findings, "required.redirect-url-accepted"),
    "met",
    "the exact Connect callback URL is registered without wildcards",
  );
  assert.equal(
    detail(report.findings, "required.redirect-url-accepted").includes(
      VERCEL_CONNECT_PROVIDER_REDIRECT_URI,
    ),
    true,
  );
  assert.equal(status(report.findings, "recommended.pkce-s256"), "met");
  assert.equal(report.exercise?.codeExchanged, true);
  assert.equal(status(report.findings, "required.expires-in"), "met");
  assert.equal(
    status(report.findings, "recommended.refresh-tokens"),
    "not-met",
    "the development issuer mints no refresh tokens and does not claim to",
  );
  assert.equal(
    status(report.findings, "optional.resource-indicators"),
    "met",
    "the access token's audience is the resource the client named",
  );
  assert.equal(report.exercise?.resourceHonored, true);
  assert.deepEqual(report.subjectTypes, ["user"]);
});

test("an authorization that returns to the wrong place or state is not a completion", async (t) => {
  const idp = await oidcIdpFixture({ seed: 11 });
  t.after(idp.close);
  const seen: string[] = [];
  const guarded = loopbackOnlyFetch(seen);
  const hijacked = await assessConnectProviderConformance({
    serverUrl: idp.origin,
    fetch: guarded,
    exercise: {
      async authorize() {
        return new URL(
          "https://connect.vercel.com/callback?code=stolen&state=not-ours",
        );
      },
    },
  });
  assert.equal(hijacked.exercise?.codeExchanged, false);
  assert.equal(hijacked.exercise?.failure, "state mismatch on callback");

  const elsewhere = await assessConnectProviderConformance({
    serverUrl: idp.origin,
    fetch: guarded,
    exercise: {
      async authorize() {
        return new URL("https://attacker.example/callback?code=stolen");
      },
    },
  });
  assert.equal(
    elsewhere.exercise?.failure,
    "callback did not arrive at the registered redirect URL",
  );
  assert.equal(idp.counts.token, 0, "no code was ever exchanged");
});

test("a document that claims a foreign issuer and names foreign endpoints is a failure, not a redirection", async (t) => {
  const attacker = await startAttacker(t);
  const { origin } = await startMetadata(t, () => ({
    // RFC 8414 §3.3: this must be the identifier whose metadata was requested.
    // It is not, and every endpoint is somewhere else again - which is the
    // whole point of publishing such a document.
    issuer: "https://totally-different.example",
    authorization_endpoint: `${attacker.origin}/authorize`,
    token_endpoint: `${attacker.origin}/token`,
    registration_endpoint: `${attacker.origin}/register`,
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid"],
  }));
  const counts = new Map<string, number>();
  const handed: URL[] = [];
  const report = await assessConnectProviderConformance({
    serverUrl: origin,
    fetch: countingFetch(counts),
    exercise: { authorize: recordingAuthorize(handed) },
  });

  // Nothing was sent, opened or exchanged anywhere but the probed origin.
  assert.deepEqual(
    attacker.received,
    [],
    "no client registration, code or code_verifier reached the other origin",
  );
  assert.deepEqual(
    handed,
    [],
    "no operator's browser was pointed at the authorization endpoint",
  );
  assert.equal(counts.get(attacker.origin), undefined);
  assert.equal(
    counts.get(origin),
    3,
    "only the two discovery locations and the protected-resource probe were fetched",
  );
  assert.equal(report.exercise, undefined, "the exercise never started");

  // The harness still reports everything it can read from the document.
  assert.equal(status(report.findings, "required.discovery-documents"), "met");
  assert.equal(status(report.findings, "required.grant-types-declared"), "met");
  assert.deepEqual(report.subjectTypes, ["user"]);
  assert.equal(status(report.findings, "recommended.pkce-s256"), "met");

  // And it reports the mismatch as the required-tier failure it is.
  assert.equal(report.discovery.issuerMatchesProbe, false);
  assert.equal(report.discovery.endpointsContained, false);
  assert.equal(
    status(report.findings, "required.issuer-consistency"),
    "not-met",
    "one published document cannot satisfy issuer consistency by agreeing with itself",
  );
  assert.match(
    detail(report.findings, "required.issuer-consistency"),
    /totally-different\.example/,
  );
  assert.equal(
    status(report.findings, "required.endpoints-within-issuer"),
    "not-met",
  );
  for (const endpoint of [
    "registration_endpoint",
    "authorization_endpoint",
    "token_endpoint",
  ])
    assert.match(
      detail(report.findings, "required.endpoints-within-issuer"),
      new RegExp(endpoint),
      `${endpoint} is named as one of the endpoints that left the origin`,
    );
  assert.equal(status(report.findings, "required.token-endpoint"), "not-met");
  assert.equal(
    status(report.findings, "recommended.client-registration"),
    "not-met",
    "registration the client must not perform is not registration Connect could use",
  );
  assert.match(
    detail(report.findings, "required.expires-in"),
    /does not stay within the issuer/,
    "the skipped exercise says why it was skipped",
  );
});

test("an endpoint off the probed origin fails the harness even when the issuer matches", async (t) => {
  const attacker = await startAttacker(t);
  const { origin } = await startMetadata(t, (self) => ({
    // Everything here is in order except the one endpoint that receives the
    // authorization code and the PKCE verifier.
    issuer: self,
    authorization_endpoint: `${self}/authorize`,
    registration_endpoint: `${self}/register`,
    token_endpoint: `${attacker.origin}/token`,
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  }));
  const counts = new Map<string, number>();
  const handed: URL[] = [];
  const report = await assessConnectProviderConformance({
    serverUrl: origin,
    fetch: countingFetch(counts),
    exercise: { authorize: recordingAuthorize(handed) },
  });

  assert.deepEqual(
    attacker.received,
    [],
    "the code exchange was never attempted off-origin",
  );
  assert.deepEqual(handed, []);
  assert.equal(counts.get(attacker.origin), undefined);
  assert.equal(
    counts.get(origin),
    3,
    "a client is not registered against a server whose token endpoint is elsewhere",
  );
  assert.equal(report.exercise, undefined);
  assert.equal(
    report.discovery.issuerMatchesProbe,
    true,
    "the issuer is the one whose metadata was requested",
  );
  assert.equal(status(report.findings, "required.issuer-consistency"), "met");
  assert.equal(report.discovery.endpointsContained, false);
  assert.equal(
    status(report.findings, "required.endpoints-within-issuer"),
    "not-met",
  );
  assert.equal(status(report.findings, "required.token-endpoint"), "not-met");
  assert.match(
    detail(report.findings, "required.token-endpoint"),
    /token_endpoint/,
  );
});
