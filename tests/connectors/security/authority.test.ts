import assert from "node:assert/strict";
import test from "node:test";
import {
  createMetadataCache,
  discoverAuthorizationServer,
  hostAuthorizedTokenExchange,
  exchangeToken,
  issuerPolicy,
  metadataCacheKey,
  resolveAuthorizationServer,
  resolveClientRegistration,
  reviewPermissionEscalation,
  scopeEnforcement,
  trustedEndpoint,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { startAuthorizationServer } from "../doubles/authorization-server.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  authHarness,
  CALLBACK_URI,
  HOST_ORIGIN,
  memoryRegistrationStore,
} from "../auth/harness.js";
import { fixtureActor } from "../doubles/ports.js";

/*
 * SEC-03. Account, issuer and permission attacks against the real OAuth
 * modules and the real loopback issuer double. Every metadata document and
 * every callback below was produced by the fixture server, never assembled by
 * the module under test, so an agreement between them is evidence.
 */

async function refused(work: () => Promise<unknown>): Promise<ConnectorError> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof ConnectorError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

test("issuer mix-up: metadata that names another issuer is refused, not adapted", async (t) => {
  const server = await startAuthorizationServer({
    clientId: "fixture-client",
    redirectUris: [CALLBACK_URI],
    misbehave: { issuerMismatch: "https://issuer.attacker.example" },
  });
  t.after(() => server.close());
  const error = await refused(() =>
    discoverAuthorizationServer(server.issuer, {
      fetch,
      allowLoopbackHttp: true,
    }),
  );
  assert.equal(error.code, "network-policy");
  assert.equal(error.detail, "oauth.metadata.issuer-mismatch");

  // Exact comparison, not display canonicalization: a trailing slash, a case
  // change and a percent-encoding are three different issuers.
  const honest = await startAuthorizationServer({
    clientId: "fixture-client",
    redirectUris: [CALLBACK_URI],
  });
  t.after(() => honest.close());
  const discovered = await discoverAuthorizationServer(honest.issuer, {
    fetch,
    allowLoopbackHttp: true,
  });
  assert.equal(discovered.state, "discovered");
  for (const spelling of [
    `${honest.issuer}/`,
    honest.issuer.replace("127.0.0.1", "127.000.000.001"),
  ]) {
    const outcome = await discoverAuthorizationServer(spelling, {
      fetch,
      allowLoopbackHttp: true,
    }).catch((error: unknown) => error);
    const rejected =
      outcome instanceof ConnectorError ||
      (typeof outcome === "object" &&
        outcome !== null &&
        (outcome as { state?: string }).state === "unavailable");
    assert.ok(rejected, `${spelling} must not resolve to the honest issuer`);
  }
});

test("a callback for another issuer or another client never binds a credential", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: {
      misbehave: { callbackIssuer: "https://issuer.attacker.example" },
    },
  });
  const { beginAuthorizationCode, completeAuthorizationCode, issueHandoff } =
    await import("../../../src/server/connectors/auth/index.js");
  const ctx = harness.ctx();
  const start = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["openid"],
  });
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") return;
  const issued = await issueHandoff(ctx, start.handoff);
  const record = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef)!;
  const callback = await harness.server.authorize(
    start.handoff.private["authorizationUrl"]!,
  );
  const error = await refused(() =>
    completeAuthorizationCode(ctx, {
      url: new URL(callback),
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
  );
  assert.equal(error.code, "denied");
  assert.equal(error.detail, "oauth.callback.issuer-mismatch");
  // Nothing was stored and the handoff is still open for the honest flow.
  assert.deepEqual(harness.ports.inspect.credentialRefs(), []);
  assert.equal(
    harness.ports.inspect
      .handoffs()
      .find((item) => item.handoffRef === issued.handoffRef)?.state,
    "issued",
  );
});

test("a callback delivered under a record for a different association is refused", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const { beginAuthorizationCode, completeAuthorizationCode, issueHandoff } =
    await import("../../../src/server/connectors/auth/index.js");
  const ctx = harness.ctx();
  const start = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["openid"],
  });
  if (start.kind !== "handoff") throw new Error("unreachable");
  const issued = await issueHandoff(ctx, start.handoff);
  const record = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef)!;
  const callback = new URL(
    await harness.server.authorize(start.handoff.private["authorizationUrl"]!),
  );

  // The handoff remembers the association; a record whose issuer or client
  // was swapped is refused before the code is presented anywhere.
  for (const [field, value, detail] of [
    [
      "issuer",
      "https://issuer.other.example",
      "oauth.callback.binding-mismatch",
    ],
    ["clientId", "another-client", "oauth.callback.binding-mismatch"],
    [
      "redirectUri",
      "https://app.example/other/callback",
      "oauth.callback.binding-mismatch",
    ],
  ] as const) {
    const error = await refused(() =>
      completeAuthorizationCode(ctx, {
        url: callback,
        handoff: { ...record, private: { ...record.private, [field]: value } },
        server: harness.resolved,
        client: harness.client,
        policy: harness.policy,
      }),
    );
    assert.equal(error.detail, detail, field);
  }
  // A callback that lands on a different path of the same origin is refused.
  const elsewhere = new URL(callback.href);
  elsewhere.pathname = "/api/v1/connectors/other";
  assert.equal(
    (
      await refused(() =>
        completeAuthorizationCode(ctx, {
          url: elsewhere,
          handoff: record,
          server: harness.resolved,
          client: harness.client,
          policy: harness.policy,
        }),
      )
    ).detail,
    "oauth.callback.redirect-uri",
  );
  // Two `state` values is not "pick the one that matches".
  const doubled = new URL(callback.href);
  doubled.searchParams.append("state", "attacker-state");
  assert.equal(
    (
      await refused(() =>
        completeAuthorizationCode(ctx, {
          url: doubled,
          handoff: record,
          server: harness.resolved,
          client: harness.client,
          policy: harness.policy,
        }),
      )
    ).detail,
    "oauth.callback.state",
  );
  assert.deepEqual(harness.ports.inspect.credentialRefs(), []);
});

test("registration hijack: a foreign registration endpoint is never used", async (t) => {
  const attacker = await startHttpFixture(() => ({
    body: { client_id: "attacker-client", client_secret: "attacker-secret" },
  }));
  t.after(() => attacker.close());
  const server = await startAuthorizationServer({
    dynamicRegistration: true,
    redirectUris: [CALLBACK_URI],
    misbehave: { registrationEndpointOrigin: attacker.origin },
  });
  t.after(() => server.close());
  const policy = issuerPolicy({
    issuer: server.issuer,
    allowLoopbackHttp: true,
    registration: { allowed: ["dynamic"] },
  });
  const resolved = await resolveAuthorizationServer(policy, { fetch });
  // The endpoint the issuer declared on someone else's origin is removed from
  // the metadata and the removal is reported, not silently tolerated.
  assert.equal(resolved.metadata.registration_endpoint, undefined);
  assert.ok(
    resolved.refused.some((item) => item.role === "registration"),
    JSON.stringify(resolved.refused),
  );
  const registrations = memoryRegistrationStore();
  const error = await refused(() =>
    resolveClientRegistration({
      actor: fixtureActor,
      policy,
      server: resolved,
      redirectUri: CALLBACK_URI,
      hostOrigin: HOST_ORIGIN,
      configuration: {
        read: async () => undefined,
        present: async () => new Set<string>(),
        revision: async () => "cfg:1",
      },
      fetch,
      registrations,
    }),
  );
  assert.ok(
    error.detail?.startsWith("oauth.registration."),
    error.detail ?? error.code,
  );
  assert.equal(registrations.writes, 0);
  assert.equal(
    attacker.requests.length,
    0,
    "the attacker's registration endpoint must never be contacted",
  );
  // The rule is specific to registration: the same foreign origin is refused
  // for registration even when the host accepts issuer-declared origins.
  assert.throws(
    () =>
      trustedEndpoint("registration", `${attacker.origin}/register`, {
        issuer: server.issuer,
        declaredBy: "issuer-metadata",
        policy: {
          trustedOrigins: [],
          acceptIssuerDeclaredOrigins: true,
          allowLoopbackHttp: true,
        },
      }),
    (thrown: unknown) =>
      thrown instanceof ConnectorError &&
      thrown.detail === "oauth.endpoint.registration.foreign-origin",
  );
  // A host that explicitly lists the origin may use it: policy, not the
  // document, is what widens trust.
  assert.equal(
    trustedEndpoint("registration", `${attacker.origin}/register`, {
      issuer: server.issuer,
      declaredBy: "issuer-metadata",
      policy: {
        trustedOrigins: [attacker.origin],
        acceptIssuerDeclaredOrigins: false,
        allowLoopbackHttp: true,
      },
    }),
    `${attacker.origin}/register`,
  );
});

test("a host-pinned endpoint and a discovered one that disagree is a conflict, not a choice", async (t) => {
  const server = await startAuthorizationServer({
    clientId: "fixture-client",
    redirectUris: [CALLBACK_URI],
  });
  t.after(() => server.close());
  const policy = issuerPolicy({
    issuer: server.issuer,
    allowLoopbackHttp: true,
    endpoints: { token: `${server.origin}/token-elsewhere` },
    registration: { allowed: ["pre-registered"] },
  });
  const error = await refused(() =>
    resolveAuthorizationServer(policy, { fetch }),
  );
  assert.equal(error.code, "network-policy");
  assert.equal(error.detail, "oauth.endpoint.token.conflict");
});

test("wrong audience: an exchanged token aimed elsewhere is refused", async (t) => {
  const server = await startAuthorizationServer({
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    redirectUris: [CALLBACK_URI],
    tokenExchange: true,
    jwtAccessTokens: true,
    exchangeAudiences: ["https://intended.example", "https://other.example"],
    tokenEndpointAuthMethods: ["client_secret_basic"],
  });
  t.after(() => server.close());
  const harness = await authHarness(t, {
    configuration: {
      OAUTH_CLIENT_ID: "fixture-client",
      OAUTH_CLIENT_SECRET: "fixture-secret",
    },
    server: {
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      tokenExchange: true,
      jwtAccessTokens: true,
      exchangeAudiences: ["https://intended.example", "https://other.example"],
      tokenEndpointAuthMethods: ["client_secret_basic"],
    },
    policy: {
      registration: {
        allowed: ["pre-registered"],
        clientIdConfiguration: "OAUTH_CLIENT_ID",
        clientSecretConfiguration: "OAUTH_CLIENT_SECRET",
        clientAuthentication: "client_secret_basic",
      },
      tokenExchange: {
        enabled: true,
        audiences: ["https://intended.example"],
        subjectCheck: "none",
      },
    },
  });
  const ctx = harness.ctx();
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const scope = {
    tenantId: fixtureActor.tenantId,
    ownerKind: "user" as const,
    ownerId: fixtureActor.subjectId,
    connectionRef: harness.connection.connectionRef,
    bindingRef: harness.binding.bindingRef,
    custody: "host-owned" as const,
  };
  const subjectToken = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.server.issuer,
  });
  // The intended audience is the one host policy named; anything else is
  // refused before the network is touched.
  const denied = await refused(() =>
    exchangeToken(ctx, port, {
      subjectToken,
      subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
      audience: "https://other.example",
      scope,
    }),
  );
  assert.equal(denied.code, "denied");
  assert.equal(denied.detail, "oauth.exchange.audience-not-allowed");
  // Enabling the extension is a separate decision from requesting its type.
  const idJag = await refused(() =>
    exchangeToken(ctx, port, {
      subjectToken,
      subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
      audience: "https://intended.example",
      requestedTokenType: "urn:ietf:params:oauth:token-type:id-jag",
      scope,
    }),
  );
  assert.equal(idJag.detail, "oauth.exchange.id-jag-not-negotiated");
  // An exchange with no target at all is refused: "any audience" is not a
  // target.
  assert.equal(
    (
      await refused(() =>
        exchangeToken(ctx, port, {
          subjectToken,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          scope,
        }),
      )
    ).detail,
    "oauth.exchange.target-missing",
  );
  // The honest case works, so the refusals above are not a broken setup.
  const ok = await exchangeToken(ctx, port, {
    subjectToken,
    subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
    audience: "https://intended.example",
    scope,
  });
  assert.ok(ok.credentialRef);
  assert.deepEqual(ok.verified.audience, ["https://intended.example"]);
  // A port cannot exist at all for an issuer whose policy leaves exchange off.
  const closed = issuerPolicy({
    issuer: harness.server.issuer,
    allowLoopbackHttp: true,
  });
  assert.throws(
    () => hostAuthorizedTokenExchange(closed, harness.resolved, harness.client),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.exchange.not-enabled",
  );
});

test("a broker that ignores downscoping is recorded, not believed", () => {
  // Requested narrow, granted wide: the token no longer bounds access, so the
  // report says Ceremony's operation policy is the only limit.
  const wide = scopeEnforcement({
    requested: ["read"],
    reported: ["read", "admin"],
    semantics: "provider-scopes",
  });
  assert.equal(wide.enforcement, "ceremony-enforced");
  assert.deepEqual(wide.excess, ["admin"]);
  const exact = scopeEnforcement({
    requested: ["read"],
    reported: ["read"],
    semantics: "provider-scopes",
  });
  assert.equal(exact.enforcement, "broker-enforced");
  // Silence is unknown, never "everything we asked for".
  const silent = scopeEnforcement({
    requested: ["read", "write"],
    reported: [],
    semantics: "unknown",
  });
  assert.equal(silent.enforcement, "unknown");
  assert.deepEqual(silent.excess, []);

  // Escalation is measured against what was reviewed, not against what the
  // provider happened to grant last time.
  const baseline = {
    permissions: {
      requested: ["read"],
      reported: ["read", "admin"],
      observed: [],
      semantics: "provider-scopes" as const,
    },
  };
  assert.equal(
    reviewPermissionEscalation(baseline, ["read", "admin"]).decision,
    "review-required",
    "a grant wider than the review does not widen the review",
  );
  assert.equal(
    reviewPermissionEscalation(baseline, ["read"]).decision,
    "unchanged",
  );
  assert.equal(reviewPermissionEscalation(baseline, []).decision, "narrowed");
  assert.equal(
    reviewPermissionEscalation(undefined, ["read"]).decision,
    "no-baseline",
  );
});

test("discovered metadata is cached per tenant and never shared across them", async (t) => {
  const server = await startAuthorizationServer({
    clientId: "fixture-client",
    redirectUris: [CALLBACK_URI],
  });
  t.after(() => server.close());
  const cache = createMetadataCache();
  const before = server.counts.metadata;
  const first = await discoverAuthorizationServer(server.issuer, {
    fetch,
    allowLoopbackHttp: true,
    cache,
    tenantId: "tenant-a",
  });
  assert.equal(first.state === "discovered" && first.fromCache, false);
  const again = await discoverAuthorizationServer(server.issuer, {
    fetch,
    allowLoopbackHttp: true,
    cache,
    tenantId: "tenant-a",
  });
  assert.equal(again.state === "discovered" && again.fromCache, true);
  const other = await discoverAuthorizationServer(server.issuer, {
    fetch,
    allowLoopbackHttp: true,
    cache,
    tenantId: "tenant-b",
  });
  assert.equal(
    other.state === "discovered" && other.fromCache,
    false,
    "the second tenant must fetch for itself",
  );
  assert.ok(
    server.counts.metadata - before >= 2,
    `expected a second fetch, saw ${server.counts.metadata - before}`,
  );
  assert.notEqual(
    metadataCacheKey("tenant-a", server.issuer),
    metadataCacheKey("tenant-b", server.issuer),
  );
  // The cache is keyed by the exact issuer identifier, so a display variant
  // is a miss, not a hit on someone else's document.
  assert.notEqual(
    metadataCacheKey("tenant-a", server.issuer),
    metadataCacheKey("tenant-a", `${server.issuer}/`),
  );
});
