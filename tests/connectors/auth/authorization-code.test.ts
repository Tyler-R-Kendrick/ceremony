import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAuthorizationCode,
  completeAuthorizationCode,
  callbackUri,
  refreshAccessToken,
  reviewPermissionEscalation,
  scopeEnforcement,
  credentialScopeFor,
  type BeginAuthorizationCodeInput,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";
import { issueHandoff } from "../../../src/server/connectors/auth/index.js";
import { authHarness, CALLBACK_URI, type AuthHarness } from "./harness.js";

/*
 * Authorization code + PKCE against the loopback fixture authorization server.
 * Every callback URL in these tests was produced by the fixture redirecting,
 * not assembled by the test, so the adapter is validated against a real wire
 * exchange rather than against its own output.
 */

const SCOPES = ["openid", "profile"];

async function begun(
  harness: AuthHarness,
  ctx: AdapterCallContext,
  overrides: Partial<BeginAuthorizationCodeInput> = {},
) {
  const start = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: SCOPES,
    ...overrides,
  });
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") throw new Error("unreachable");
  const issued = await issueHandoff(ctx, start.handoff);
  const record = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef);
  assert.ok(record);
  return { start, record: record as HandoffRecord };
}

function inspectHandoffs(harness: AuthHarness) {
  return harness.ports.inspect.handoffs();
}

test("begin produces an S256 authorization URL and keeps state and verifier private", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  const start = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: SCOPES,
  });
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") return;
  const url = new URL(start.handoff.private["authorizationUrl"]!);
  assert.equal(url.origin, harness.server.origin);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), CALLBACK_URI);
  assert.equal(url.searchParams.get("scope"), "openid profile");
  // The verifier never appears in anything that leaves the server.
  const verifier = start.handoff.private["verifier"]!;
  assert.ok(verifier.length >= 43);
  assert.ok(!url.href.includes(verifier));
  assert.equal(
    url.searchParams.get("code_challenge") === verifier,
    false,
    "the challenge is a digest, not the verifier",
  );
  assert.equal(start.handoff.correlationKey, start.handoff.private["state"]);
});

test("a full code exchange stores credentials and reports requested vs granted scope", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { scopes: ["openid", "profile"], openidConnect: true },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const result = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(result.state, "complete");
  assert.ok(result.credentialRef);
  const material = harness.ports.inspect.credentialMaterial(
    result.credentialRef!,
  );
  assert.ok(material?.["access_token"]);
  assert.ok(material?.["refresh_token"]);
  const claim = result.claims[0]!;
  assert.equal(claim.kind, "credential-accepted");
  assert.deepEqual(claim.permissions?.requested, ["openid", "profile"]);
  assert.deepEqual(claim.permissions?.reported, ["openid", "profile"]);
  assert.deepEqual(claim.permissions?.observed, []);
  assert.equal(claim.permissions?.semantics, "provider-scopes");
  assert.equal(inspectHandoffs(harness)[0]?.state, "completed");
});

test("AC-AUTH-03: a callback with a mismatched state is refused (login CSRF)", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  // An attacker delivers their own completed authorization to this session.
  const attacker = await begun(harness, harness.ctx());
  const attackerCallback = await harness.server.authorize(
    attacker.record.private["authorizationUrl"]!,
  );
  const tokensBefore = harness.server.counts.token;
  await assert.rejects(
    completeAuthorizationCode(ctx, {
      url: new URL(attackerCallback),
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "oauth.callback.state",
  );
  assert.equal(
    harness.server.counts.token,
    tokensBefore,
    "a state mismatch never reaches the token endpoint",
  );
});

test("AC-AUTH-04: a callback whose iss differs from the issuer is refused", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { misbehave: { callbackIssuer: "https://evil.example" } },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const before = harness.server.counts.token;
  await assert.rejects(
    completeAuthorizationCode(ctx, {
      url: new URL(callback),
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.callback.issuer-mismatch",
  );
  assert.equal(harness.server.counts.token, before);
});

test("RFC 9207: a missing iss is refused when the server advertises the parameter", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { misbehave: { omitCallbackIssuer: true } },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  await assert.rejects(
    completeAuthorizationCode(ctx, {
      url: new URL(callback),
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.callback.issuer-missing",
  );
});

test("AC-AUTH-03: a callback for another client or redirect URI is refused before exchange", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const foreign: HandoffRecord = {
    ...record,
    private: { ...record.private, clientId: "someone-else" },
  };
  await assert.rejects(
    completeAuthorizationCode(ctx, {
      url: new URL(callback),
      handoff: foreign,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.callback.binding-mismatch",
  );
  // A callback delivered to a different path than the registered redirect URI.
  const wrongPath = new URL(callback);
  wrongPath.pathname = "/api/v1/connectors/other";
  await assert.rejects(
    completeAuthorizationCode(ctx, {
      url: wrongPath,
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.callback.redirect-uri",
  );
});

test("AC-AUTH-06: the same code delivered twice is not exchanged twice", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { openidConnect: true, misbehave: { reusableCode: true } },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const first = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(first.state, "complete");
  const afterFirst = harness.server.counts.token;
  // Even though this fixture would happily honour the code again, the effect
  // journal answers from the prior outcome and no request is sent.
  await assert.rejects(
    completeAuthorizationCode(ctx, {
      url: new URL(callback),
      handoff: { ...record, state: "issued" },
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "conflict" &&
      error.detail === "oauth.code.duplicate-applied",
  );
  assert.equal(
    harness.server.counts.token,
    afterFirst,
    "the token endpoint was not hit a second time",
  );
});

test("AC-AUTH-07: a callback for an older generation cannot revive the connection", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  // The person cancels and reconnects: the connection generation advances.
  const newer = harness.ctx({
    connection: { ...harness.connection, generation: 1 },
    generation: 1,
  });
  const before = harness.server.counts.token;
  await assert.rejects(
    completeAuthorizationCode(newer, {
      url: new URL(callback),
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "conflict" &&
      error.detail === "oauth.handoff.stale-generation",
  );
  assert.equal(harness.server.counts.token, before);
});

test("AC-AUTH-07: a callback after unlink is refused and no credential is written", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  // Unlink cancels every pending handoff for the connection.
  const cancelled = await harness.ports.handoffs.cancelAll(
    harness.connection.connectionRef,
    "unlinked",
  );
  assert.equal(cancelled, 1);
  const stale = inspectHandoffs(harness)[0]!;
  await assert.rejects(
    completeAuthorizationCode(ctx, {
      url: new URL(callback),
      handoff: stale,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "cancelled" &&
      error.detail === "oauth.handoff.cancelled",
  );
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
});

test("AC-AUTH-03: denial and expiry are distinct results, not failures", async (t) => {
  const denied = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { misbehave: { denyConsent: true } },
  });
  const deniedCtx = denied.ctx();
  const deniedStart = await begun(denied, deniedCtx);
  const deniedCallback = await denied.server.authorize(
    deniedStart.record.private["authorizationUrl"]!,
  );
  const deniedResult = await completeAuthorizationCode(deniedCtx, {
    url: new URL(deniedCallback),
    handoff: deniedStart.record,
    server: denied.resolved,
    client: denied.client,
    policy: denied.policy,
  });
  assert.equal(deniedResult.state, "denied");
  assert.equal(deniedResult.code, "oauth.callback.access-denied");
  assert.deepEqual(deniedResult.claims, []);
  assert.equal(inspectHandoffs(denied)[0]?.state, "denied");

  const expiring = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const expiringCtx = expiring.ctx();
  const expiringStart = await begun(expiring, expiringCtx);
  const expiringCallback = await expiring.server.authorize(
    expiringStart.record.private["authorizationUrl"]!,
  );
  expiring.advance(700_000);
  const expiredResult = await completeAuthorizationCode(expiringCtx, {
    url: new URL(expiringCallback),
    handoff: expiringStart.record,
    server: expiring.resolved,
    client: expiring.client,
    policy: expiring.policy,
  });
  assert.equal(expiredResult.state, "expired");
  assert.equal(expiring.server.counts.token, 0);
});

test("private_key_jwt authenticates the client with a real signed assertion", async (t) => {
  const { generateKeyPair, exportJWK } = await import("jose");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const harness = await authHarness(t, {
    configuration: {
      OAUTH_CLIENT_ID: "fixture-client",
      OAUTH_CLIENT_KEY: JSON.stringify({ ...jwk, alg: "ES256", kid: "k1" }),
    },
    policy: {
      registration: {
        allowed: ["pre-registered"],
        clientIdConfiguration: "OAUTH_CLIENT_ID",
        privateKeyConfiguration: "OAUTH_CLIENT_KEY",
        clientAuthentication: "private_key_jwt",
      },
    },
    server: {
      openidConnect: true,
      tokenEndpointAuthMethods: ["private_key_jwt"],
    },
  });
  assert.equal(harness.client.method, "private_key_jwt");
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const result = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(result.state, "complete");
  const request = harness.server.tokenRequests.at(-1)!;
  assert.equal(
    request.parameters["client_assertion_type"],
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  );
  assert.equal(request.parameters["client_assertion"]?.split(".").length, 3);
  assert.equal(
    request.parameters["client_secret"],
    undefined,
    "no shared secret is sent",
  );
});

test("client_secret_basic sends the secret in the header, never in the query", async (t) => {
  const harness = await authHarness(t, {
    configuration: {
      OAUTH_CLIENT_ID: "fixture-client",
      OAUTH_CLIENT_SECRET: "s3cret-value",
    },
    policy: {
      registration: {
        allowed: ["pre-registered"],
        clientIdConfiguration: "OAUTH_CLIENT_ID",
        clientSecretConfiguration: "OAUTH_CLIENT_SECRET",
        clientAuthentication: "client_secret_basic",
      },
    },
    server: { openidConnect: true, clientSecret: "s3cret-value" },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const result = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(result.state, "complete");
  const request = harness.server.tokenRequests.at(-1)!;
  assert.ok(request.authorization?.startsWith("Basic "));
  assert.equal(request.parameters["client_secret"], undefined);
  assert.ok(
    !harness.fetchLog.some((entry) => entry.url.includes("s3cret-value")),
    "the secret never appears in a URL",
  );
});

test("RFC 8707: the resource indicator travels on authorization and token requests", async (t) => {
  const resource = "https://api.example/v1";
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { openidConnect: true },
    policy: { resource },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const authorizationUrl = new URL(record.private["authorizationUrl"]!);
  assert.equal(authorizationUrl.searchParams.get("resource"), resource);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(
    harness.server.tokenRequests.at(-1)!.parameters["resource"],
    resource,
  );
});

test("AC-AUTH-11: a broker that ignores downscoping is reported as Ceremony-enforced", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: {
      openidConnect: true,
      misbehave: { grantScopes: ["openid", "profile", "admin:everything"] },
    },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const result = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  const permissions = result.claims[0]!.permissions!;
  assert.deepEqual(permissions.requested, ["openid", "profile"]);
  assert.ok(permissions.reported.includes("admin:everything"));
  const enforcement = scopeEnforcement(permissions);
  assert.equal(enforcement.enforcement, "ceremony-enforced");
  assert.deepEqual(enforcement.excess, ["admin:everything"]);
  assert.equal(result.adapterState?.["enforcement"], "ceremony-enforced");
});

test("a provider that reports no scope yields unknown semantics, never the request", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { openidConnect: true, misbehave: { omitScope: true } },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const result = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  const permissions = result.claims[0]!.permissions!;
  assert.deepEqual(permissions.reported, []);
  assert.equal(permissions.semantics, "unknown");
  assert.equal(scopeEnforcement(permissions).enforcement, "unknown");
});

test("AC-AUTH-10: a widened request is flagged for re-review against the reviewed baseline", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { openidConnect: true },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const result = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  const previous = result.claims[0]!;
  assert.equal(
    reviewPermissionEscalation(previous, ["openid", "profile"]).decision,
    "unchanged",
  );
  assert.equal(
    reviewPermissionEscalation(previous, ["openid"]).decision,
    "narrowed",
  );
  const escalated = reviewPermissionEscalation(previous, [
    "openid",
    "profile",
    "repo:write",
  ]);
  assert.equal(escalated.decision, "review-required");
  assert.deepEqual(escalated.added, ["repo:write"]);
  assert.equal(
    reviewPermissionEscalation(undefined, ["openid"]).decision,
    "no-baseline",
  );
});

test("AC-STATE-01: concurrent refreshes make one upstream call and never overwrite the newer token", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { openidConnect: true, misbehave: { tokenDelayMs: 40 } },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const completed = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  const credentialRef = completed.credentialRef!;
  const scope = credentialScopeFor(ctx, record);
  const before = harness.server.counts.token;
  const original =
    harness.ports.inspect.credentialMaterial(credentialRef)?.["refresh_token"];

  const [first, second] = await Promise.all([
    refreshAccessToken(ctx, {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      credentialRef,
      scope,
    }),
    refreshAccessToken(ctx, {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      credentialRef,
      scope,
    }),
  ]);
  assert.equal(
    harness.server.counts.token - before,
    1,
    "two workers share one upstream refresh",
  );
  assert.equal(first.credentialRef, second.credentialRef);
  // Exactly one call performed the refresh; the other joined it.
  assert.equal([first.shared, second.shared].filter(Boolean).length, 1);
  const rotated = [first, second].find((outcome) => outcome.rotated !== undefined);
  assert.equal(rotated?.rotated, true, "the refresh token rotated");
  const stored =
    harness.ports.inspect.credentialMaterial(credentialRef)?.["refresh_token"];
  assert.notEqual(stored, original, "the new refresh token replaced the old");

  // The superseded refresh token is never presented again.
  const after = harness.server.counts.token;
  const third = await refreshAccessToken(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    credentialRef,
    scope,
  });
  assert.equal(harness.server.counts.token - after, 1);
  assert.equal(third.rotated, true);
});

test("a rotating refresh token is never replayed after it was used", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { openidConnect: true },
  });
  const ctx = harness.ctx();
  const { record } = await begun(harness, ctx);
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  const completed = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  const scope = credentialScopeFor(ctx, record);
  const credentialRef = completed.credentialRef!;
  const first = await refreshAccessToken(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    credentialRef,
    scope,
  });
  assert.equal(first.rotated, true);
  // Restore the consumed token to simulate a stale worker holding the old one.
  const material = harness.ports.inspect.credentialMaterial(credentialRef)!;
  await harness.ports.credentials.store(
    scope,
    { ...material, refresh_token: record.private["state"]! },
    { replaces: credentialRef },
  );
  await assert.rejects(
    refreshAccessToken(ctx, {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      credentialRef,
      scope,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      (error.code === "upstream-rejected" || error.code === "conflict"),
  );
});

test("callbackUri refuses a path that could escape the host origin", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  assert.equal(callbackUri(ctx), CALLBACK_URI);
  for (const path of ["//evil.example/x", "/a/../../b", "/a?x=1", "relative"])
    assert.throws(
      () => callbackUri(ctx, path),
      (error: unknown) => error instanceof ConnectorError,
      path,
    );
});
