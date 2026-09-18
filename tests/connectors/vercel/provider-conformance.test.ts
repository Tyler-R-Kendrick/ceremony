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
