import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createMetadataCache,
  discoverAuthorizationServer,
  discoverProtectedResource,
  issuerPolicy,
  metadataCandidates,
  protectedResourceMetadataUrl,
  resolveAuthorizationServer,
  resourceMetadataFromChallenge,
  trustedEndpoint,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { startAuthorizationServer } from "../doubles/authorization-server.js";
import { startHttpFixture } from "../doubles/http-fixture.js";

/*
 * Discovery is exercised against the real fixture authorization server over
 * loopback HTTP: every metadata document these tests read was produced by the
 * fixture, never by the code under test.
 */

const loopbackFetch: typeof fetch = (input, init) => fetch(input, init);

async function serverFixture(
  t: TestContext,
  options: Parameters<typeof startAuthorizationServer>[0] = {},
) {
  const server = await startAuthorizationServer(options);
  t.after(() => server.close());
  return server;
}

test("path-insertion candidates follow the MCP/RFC 8414 order", () => {
  assert.deepEqual(
    metadataCandidates(new URL("https://as.example")).map((c) => c.url),
    [
      "https://as.example/.well-known/oauth-authorization-server",
      "https://as.example/.well-known/openid-configuration",
    ],
  );
  assert.deepEqual(
    metadataCandidates(new URL("https://as.example/tenant/a")).map(
      (c) => c.url,
    ),
    [
      "https://as.example/.well-known/oauth-authorization-server/tenant/a",
      "https://as.example/.well-known/openid-configuration/tenant/a",
      "https://as.example/tenant/a/.well-known/openid-configuration",
    ],
  );
});

test("RFC 9728 protected-resource metadata inserts the well-known segment before the path", () => {
  assert.equal(
    protectedResourceMetadataUrl(new URL("https://api.example/")),
    "https://api.example/.well-known/oauth-protected-resource",
  );
  assert.equal(
    protectedResourceMetadataUrl(new URL("https://api.example/mcp/v1")),
    "https://api.example/.well-known/oauth-protected-resource/mcp/v1",
  );
  // A terminating slash is part of the resource identifier and is preserved.
  assert.equal(
    protectedResourceMetadataUrl(new URL("https://api.example/mcp/")),
    "https://api.example/.well-known/oauth-protected-resource/mcp/",
  );
});

test("discovery reads a real metadata document and caches it per tenant and issuer", async (t) => {
  const server = await serverFixture(t);
  const cache = createMetadataCache();
  const first = await discoverAuthorizationServer(server.issuer, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
    cache,
    tenantId: "tenant-a",
  });
  assert.equal(first.state, "discovered");
  assert.equal(first.state === "discovered" && first.fromCache, false);
  assert.equal(server.counts.metadata, 1);

  const again = await discoverAuthorizationServer(server.issuer, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
    cache,
    tenantId: "tenant-a",
  });
  assert.equal(again.state === "discovered" && again.fromCache, true);
  assert.equal(server.counts.metadata, 1, "a cache hit makes no request");

  // Another tenant does not read the first tenant's cache entry.
  const other = await discoverAuthorizationServer(server.issuer, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
    cache,
    tenantId: "tenant-b",
  });
  assert.equal(other.state === "discovered" && other.fromCache, false);
  assert.equal(server.counts.metadata, 2);
});

test("a cache entry expires and is not served past its TTL", async (t) => {
  const server = await serverFixture(t);
  let clock = 1_000_000;
  const cache = createMetadataCache({ now: () => clock });
  const options = {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
    cache,
    tenantId: "tenant-a",
    now: () => clock,
    ttlMs: 60_000,
  };
  await discoverAuthorizationServer(server.issuer, options);
  assert.equal(server.counts.metadata, 1);
  clock += 59_000;
  await discoverAuthorizationServer(server.issuer, options);
  assert.equal(server.counts.metadata, 1);
  clock += 2_000;
  await discoverAuthorizationServer(server.issuer, options);
  assert.equal(server.counts.metadata, 2, "an expired entry is refetched");
});

test("AC-AUTH-04: metadata naming another issuer is refused, not adapted", async (t) => {
  const server = await serverFixture(t, {
    misbehave: { issuerMismatch: "https://evil.example" },
  });
  await assert.rejects(
    discoverAuthorizationServer(server.issuer, {
      fetch: loopbackFetch,
      allowLoopbackHttp: true,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "oauth.metadata.issuer-mismatch",
  );
});

test("AC-AUTH-04: a trailing-slash issuer spelling is a different identifier", async (t) => {
  const server = await serverFixture(t);
  await assert.rejects(
    discoverAuthorizationServer(`${server.issuer}/`, {
      fetch: loopbackFetch,
      allowLoopbackHttp: true,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.metadata.issuer-mismatch",
    "display canonicalization must not weaken protocol comparison",
  );
});

test("missing metadata reports an explicit unknown state rather than guessing", async (t) => {
  const empty = await startHttpFixture(() => ({
    status: 404,
    body: { error: "not_found" },
  }));
  t.after(() => empty.close());
  const result = await discoverAuthorizationServer(empty.origin, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.state === "unavailable" && result.reason, "not-found");
  assert.equal(result.state === "unavailable" && result.retryable, false);
  assert.equal(
    result.state === "unavailable" && result.attempted.length,
    2,
    "both well-known locations were attempted",
  );
});

test("a server error is reported retryable, not as absence of OAuth", async (t) => {
  const broken = await startHttpFixture(() => ({
    status: 503,
    body: { error: "unavailable" },
  }));
  t.after(() => broken.close());
  const result = await discoverAuthorizationServer(broken.origin, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
  });
  assert.equal(result.state === "unavailable" && result.reason, "network");
  assert.equal(result.state === "unavailable" && result.retryable, true);
});

test("non-JSON and oversized metadata are malformed, never parsed", async (t) => {
  const html = await startHttpFixture(() => ({
    status: 200,
    headers: { "content-type": "text/html" },
    body: "<html>not metadata</html>",
  }));
  t.after(() => html.close());
  const result = await discoverAuthorizationServer(html.origin, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
  });
  assert.equal(result.state === "unavailable" && result.reason, "malformed");

  const huge = await startHttpFixture(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issuer: "x", padding: "a".repeat(200_000) }),
  }));
  t.after(() => huge.close());
  const bounded = await discoverAuthorizationServer(huge.origin, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
    maxBytes: 4096,
  });
  assert.equal(bounded.state === "unavailable" && bounded.reason, "malformed");
});

test("metadata carrying a prototype-polluting key is refused", async (t) => {
  const polluted = await startHttpFixture((request) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: `{"issuer":"${request.url.origin}","__proto__":{"polluted":true}}`,
  }));
  t.after(() => polluted.close());
  const result = await discoverAuthorizationServer(polluted.origin, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
  });
  assert.equal(result.state === "unavailable" && result.reason, "malformed");
  assert.equal(
    ({} as Record<string, unknown>)["polluted"],
    undefined,
    "no runtime object was mutated",
  );
});

test("discovery uses only the injected fetch and refuses redirects", async (t) => {
  const server = await serverFixture(t);
  const seen: string[] = [];
  const injected: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    seen.push(url);
    assert.equal(
      (init as RequestInit).redirect,
      "error",
      "metadata fetches never follow redirects",
    );
    return fetch(input, init);
  };
  await discoverAuthorizationServer(server.issuer, {
    fetch: injected,
    allowLoopbackHttp: true,
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((url) => url.startsWith(server.origin)));
});

test("an issuer with a path is discovered through path insertion", async (t) => {
  const server = await serverFixture(t, { issuerPath: "/tenant/one" });
  const result = await discoverAuthorizationServer(server.issuer, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
  });
  assert.equal(result.state, "discovered");
  assert.equal(
    result.state === "discovered" && result.url,
    `${server.origin}/.well-known/oauth-authorization-server/tenant/one`,
  );
});

test("PRM discovery binds the document to the exact resource identifier", async (t) => {
  const direct = await startAuthorizationServer({});
  t.after(() => direct.close());
  const found = await discoverProtectedResource(`${direct.origin}/mcp`, {
    fetch: loopbackFetch,
    allowLoopbackHttp: true,
  });
  assert.equal(found.state, "discovered");
  assert.equal(
    found.state === "discovered" && found.url,
    `${direct.origin}/.well-known/oauth-protected-resource/mcp`,
  );
  assert.deepEqual(found.state === "discovered" && found.authorizationServers, [
    direct.issuer,
  ]);
});

test("PRM whose `resource` does not match the identifier is refused", async (t) => {
  const lying = await startHttpFixture(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      resource: "https://elsewhere.example/api",
      authorization_servers: ["https://as.example"],
    },
  }));
  t.after(() => lying.close());
  await assert.rejects(
    discoverProtectedResource(`${lying.origin}/api`, {
      fetch: loopbackFetch,
      allowLoopbackHttp: true,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.resource-metadata.resource-mismatch",
  );
});

test("a Bearer challenge hint is parsed but still bound to the resource", () => {
  assert.equal(
    resourceMetadataFromChallenge(
      'Bearer error="invalid_token", resource_metadata="https://api.example/.well-known/oauth-protected-resource"',
    ),
    "https://api.example/.well-known/oauth-protected-resource",
  );
  assert.equal(resourceMetadataFromChallenge("Bearer"), undefined);
  assert.equal(resourceMetadataFromChallenge(null), undefined);
});

test("AC-AUTH-17: a cross-origin registration endpoint is never trusted by issuer declaration", () => {
  const policy = {
    trustedOrigins: [],
    acceptIssuerDeclaredOrigins: true,
    allowLoopbackHttp: false,
  };
  // A token endpoint the issuer itself declares elsewhere is a trusted association.
  assert.equal(
    trustedEndpoint("token", "https://tokens.example/t", {
      issuer: "https://as.example",
      declaredBy: "issuer-metadata",
      policy,
    }),
    "https://tokens.example/t",
  );
  // The registration endpoint is not: it creates clients.
  assert.throws(
    () =>
      trustedEndpoint("registration", "https://attacker.example/register", {
        issuer: "https://as.example",
        declaredBy: "issuer-metadata",
        policy,
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "oauth.endpoint.registration.foreign-origin",
  );
  // Unless the host itself listed that origin.
  assert.equal(
    trustedEndpoint("registration", "https://reg.example/register", {
      issuer: "https://as.example",
      declaredBy: "issuer-metadata",
      policy: { ...policy, trustedOrigins: ["https://reg.example"] },
    }),
    "https://reg.example/register",
  );
});

test("a cross-origin endpoint is refused when policy does not accept declarations", () => {
  assert.throws(
    () =>
      trustedEndpoint("token", "https://tokens.example/t", {
        issuer: "https://as.example",
        declaredBy: "issuer-metadata",
        policy: {
          trustedOrigins: [],
          acceptIssuerDeclaredOrigins: false,
          allowLoopbackHttp: false,
        },
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.endpoint.token.foreign-origin",
  );
});

test("AC-AUTH-17: malicious metadata pointing registration at another host is refused end to end", async (t) => {
  const server = await serverFixture(t, {
    dynamicRegistration: true,
    misbehave: { registrationEndpointOrigin: "https://attacker.example" },
  });
  const resolved = await resolveAuthorizationServer(
    issuerPolicy({ issuer: server.issuer, allowLoopbackHttp: true }),
    { fetch: loopbackFetch },
  );
  assert.equal(resolved.metadata.registration_endpoint, undefined);
  assert.deepEqual(
    resolved.refused.map((item) => item.role),
    ["registration"],
  );
  assert.equal(
    resolved.refused[0]?.detail,
    "oauth.endpoint.registration.foreign-origin",
  );
});

test("a token endpoint on another origin without declaration aborts resolution", async (t) => {
  const server = await serverFixture(t, {
    misbehave: { tokenEndpointOrigin: "https://attacker.example" },
  });
  await assert.rejects(
    resolveAuthorizationServer(
      issuerPolicy({
        issuer: server.issuer,
        allowLoopbackHttp: true,
        acceptIssuerDeclaredOrigins: false,
      }),
      { fetch: loopbackFetch },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.endpoint.token.foreign-origin",
  );
});

test("configured endpoints are used when discovery is disabled and recorded as configured", async (t) => {
  const server = await serverFixture(t);
  const resolved = await resolveAuthorizationServer(
    issuerPolicy({
      issuer: server.issuer,
      allowLoopbackHttp: true,
      discovery: "disabled",
      endpoints: {
        authorization: `${server.origin}/authorize`,
        token: `${server.origin}/token`,
      },
    }),
    { fetch: loopbackFetch },
  );
  assert.equal(resolved.source, "configured");
  assert.equal(resolved.discovery.state, "disabled");
  assert.equal(resolved.metadata.issuer, server.issuer);
  assert.equal(resolved.metadata.token_endpoint, `${server.origin}/token`);
  assert.equal(server.counts.metadata, 0, "discovery was not attempted");
});

test("a configured endpoint that contradicts discovery is a conflict", async (t) => {
  const server = await serverFixture(t);
  await assert.rejects(
    resolveAuthorizationServer(
      issuerPolicy({
        issuer: server.issuer,
        allowLoopbackHttp: true,
        endpoints: { token: `${server.origin}/other-token` },
      }),
      { fetch: loopbackFetch },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.endpoint.token.conflict",
  );
});

test("discovery required plus unavailable metadata blocks rather than guessing endpoints", async (t) => {
  const empty = await startHttpFixture(() => ({
    status: 404,
    body: { error: "not_found" },
  }));
  t.after(() => empty.close());
  await assert.rejects(
    resolveAuthorizationServer(
      issuerPolicy({ issuer: empty.origin, allowLoopbackHttp: true }),
      { fetch: loopbackFetch },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "oauth.discovery.not-found",
  );
});

test("an http issuer is refused unless loopback is explicitly permitted", () => {
  assert.throws(
    () => issuerPolicy({ issuer: "http://127.0.0.1:9/x" }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "network-policy",
  );
  assert.throws(
    () =>
      issuerPolicy({ issuer: "http://as.example", allowLoopbackHttp: true }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "network-policy",
    "loopback permission does not extend to remote http",
  );
});

test("an issuer identifier with a query or fragment is invalid", () => {
  for (const issuer of [
    "https://as.example?tenant=a",
    "https://as.example#frag",
    "https://user:pw@as.example",
  ])
    assert.throws(
      () => issuerPolicy({ issuer }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "oauth.issuer.invalid",
      issuer,
    );
});
