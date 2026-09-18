import assert from "node:assert/strict";
import test from "node:test";
import {
  exchangeToken,
  hostAuthorizedTokenExchange,
  tokenTypeIdentifiers,
  TOKEN_EXCHANGE_GRANT,
  credentialScopeFor,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { CredentialScope } from "../../../src/server/connectors/index.js";
import { authHarness, type AuthHarness } from "./harness.js";

/*
 * RFC 8693 token exchange. The fixture mints real ES256 JWTs and publishes a
 * real JWKS, so the audience, issuer, subject and actor checks run against
 * signatures the module did not create.
 */

const RESOURCE = "https://downstream.example/api";
const OTHER_RESOURCE = "https://other.example/api";

function scopeOf(harness: AuthHarness): CredentialScope {
  return credentialScopeFor(harness.ctx(), {
    connectionRef: harness.connection.connectionRef,
    bindingRef: harness.connection.bindingRef,
  });
}

async function exchangeHarness(
  t: Parameters<typeof authHarness>[0],
  options: {
    audiences?: string[];
    resources?: string[];
    idJag?: boolean;
    actorTokens?: boolean;
    subjectCheck?: "required" | "none";
    mintAudience?: string;
    enabled?: boolean;
  } = {},
) {
  return authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: {
      tokenExchange: true,
      jwtAccessTokens: true,
      exchangeAudiences: [RESOURCE, OTHER_RESOURCE],
      ...(options.mintAudience
        ? { misbehave: { mintAudience: options.mintAudience } }
        : {}),
    },
    policy: {
      tokenExchange: {
        enabled: options.enabled ?? true,
        audiences: options.audiences ?? [RESOURCE],
        resources: options.resources ?? [RESOURCE],
        ...(options.idJag !== undefined ? { idJag: options.idJag } : {}),
        ...(options.actorTokens !== undefined
          ? { actorTokens: options.actorTokens }
          : {}),
        ...(options.subjectCheck !== undefined
          ? { subjectCheck: options.subjectCheck }
          : {}),
      },
    },
  });
}

test("AC-AUTH-05: exchange is impossible without an enabling host policy", async (t) => {
  const harness = await exchangeHarness(t, { enabled: false });
  assert.throws(
    () =>
      hostAuthorizedTokenExchange(
        harness.policy,
        harness.resolved,
        harness.client,
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "oauth.exchange.not-enabled",
  );
  assert.equal(
    harness.server.tokenRequests.length,
    0,
    "no request could even be attempted",
  );
});

test("a permitted exchange verifies the issued token and stores it in custody", async (t) => {
  const harness = await exchangeHarness(t);
  const ctx = harness.ctx();
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const subjectToken = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.client.client.client_id,
  });
  const outcome = await exchangeToken(ctx, port, {
    subjectToken,
    subjectTokenType: tokenTypeIdentifiers.accessToken,
    resource: RESOURCE,
    scope: scopeOf(harness),
  });
  assert.equal(outcome.verified.issuer, harness.server.issuer);
  assert.ok(outcome.verified.audience.includes(RESOURCE));
  assert.equal(outcome.verified.subject, "user-1");
  assert.equal(outcome.verified.via, "jwt");
  assert.ok(outcome.credentialRef);
  const material = harness.ports.inspect.credentialMaterial(
    outcome.credentialRef,
  );
  assert.ok(material?.["access_token"]);
  assert.equal(material?.["audience"], RESOURCE);
  const request = harness.server.tokenRequests.at(-1)!;
  assert.equal(request.grantType, TOKEN_EXCHANGE_GRANT);
  assert.equal(request.parameters["resource"], RESOURCE);
  assert.equal(
    request.parameters["subject_token_type"],
    tokenTypeIdentifiers.accessToken,
  );
  assert.equal(outcome.claims.length, 2);
  assert.equal(outcome.claims[1]?.kind, "account-identity");
});

test("AC-AUTH-05: a token minted for another audience is refused", async (t) => {
  const harness = await exchangeHarness(t, { mintAudience: OTHER_RESOURCE });
  const ctx = harness.ctx();
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const subjectToken = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.client.client.client_id,
  });
  await assert.rejects(
    exchangeToken(ctx, port, {
      subjectToken,
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      resource: RESOURCE,
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "oauth.exchange.token-invalid",
  );
  assert.equal(
    harness.ports.inspect.credentialRefs().length,
    0,
    "a wrong-audience token is never stored",
  );
});

test("AC-AUTH-05: an audience or resource outside policy is refused before any request", async (t) => {
  const harness = await exchangeHarness(t, { resources: [RESOURCE] });
  const ctx = harness.ctx();
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const subjectToken = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.client.client.client_id,
  });
  const before = harness.server.tokenRequests.length;
  await assert.rejects(
    exchangeToken(ctx, port, {
      subjectToken,
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      resource: OTHER_RESOURCE,
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.exchange.resource-not-allowed",
  );
  await assert.rejects(
    exchangeToken(ctx, port, {
      subjectToken,
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.exchange.target-missing",
  );
  assert.equal(harness.server.tokenRequests.length, before);
});

test("AC-EXT-06: a token naming a different subject is refused, not decoded and trusted", async (t) => {
  const harness = await exchangeHarness(t);
  const ctx = harness.ctx();
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const subjectToken = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.client.client.client_id,
  });
  await assert.rejects(
    exchangeToken(ctx, port, {
      subjectToken,
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      resource: RESOURCE,
      expectedSubject: "someone-else",
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.exchange.subject-mismatch",
  );
});

test("a subject token this issuer cannot verify blocks the exchange when a subject is required", async (t) => {
  const harness = await exchangeHarness(t, { subjectCheck: "required" });
  const ctx = harness.ctx();
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const before = harness.server.tokenRequests.length;
  await assert.rejects(
    exchangeToken(ctx, port, {
      subjectToken: "opaque-token-value",
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      resource: RESOURCE,
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.exchange.subject-unverifiable",
  );
  assert.equal(harness.server.tokenRequests.length, before);
});

test("a subject token signed by another issuer is not accepted as this issuer's", async (t) => {
  const harness = await exchangeHarness(t);
  const ctx = harness.ctx();
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const foreign = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.client.client.client_id,
    issuer: "https://evil.example",
  });
  await assert.rejects(
    exchangeToken(ctx, port, {
      subjectToken: foreign,
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      resource: RESOURCE,
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.exchange.subject-unverifiable",
  );
});

test("an actor token is refused unless policy allows delegation, and its actor is checked", async (t) => {
  const denied = await exchangeHarness(t, { actorTokens: false });
  const deniedPort = hostAuthorizedTokenExchange(
    denied.policy,
    denied.resolved,
    denied.client,
  );
  const subjectToken = await denied.server.mintToken({
    subject: "user-1",
    audience: denied.client.client.client_id,
  });
  const actorToken = await denied.server.mintToken({
    subject: "agent-7",
    audience: denied.client.client.client_id,
  });
  await assert.rejects(
    exchangeToken(denied.ctx(), deniedPort, {
      subjectToken,
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      actorToken,
      resource: RESOURCE,
      scope: scopeOf(denied),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.exchange.actor-not-allowed",
  );

  const allowed = await exchangeHarness(t, { actorTokens: true });
  const allowedPort = hostAuthorizedTokenExchange(
    allowed.policy,
    allowed.resolved,
    allowed.client,
  );
  const allowedSubject = await allowed.server.mintToken({
    subject: "user-1",
    audience: allowed.client.client.client_id,
  });
  const allowedActor = await allowed.server.mintToken({
    subject: "agent-7",
    audience: allowed.client.client.client_id,
  });
  const outcome = await exchangeToken(allowed.ctx(), allowedPort, {
    subjectToken: allowedSubject,
    subjectTokenType: tokenTypeIdentifiers.accessToken,
    actorToken: allowedActor,
    resource: RESOURCE,
    scope: scopeOf(allowed),
  });
  assert.equal(outcome.verified.actor, "agent-7");
  assert.equal(
    allowed.server.tokenRequests.at(-1)!.parameters["actor_token_type"],
    tokenTypeIdentifiers.accessToken,
  );
});

test("ID-JAG is unsupported until the profile is separately negotiated", async (t) => {
  const off = await exchangeHarness(t, { idJag: false });
  const offPort = hostAuthorizedTokenExchange(
    off.policy,
    off.resolved,
    off.client,
  );
  const subjectToken = await off.server.mintToken({
    subject: "user-1",
    audience: off.client.client.client_id,
  });
  const before = off.server.tokenRequests.length;
  await assert.rejects(
    exchangeToken(off.ctx(), offPort, {
      subjectToken,
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      requestedTokenType: tokenTypeIdentifiers.idJag,
      resource: RESOURCE,
      scope: scopeOf(off),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "oauth.exchange.id-jag-not-negotiated",
  );
  assert.equal(off.server.tokenRequests.length, before);

  // Negotiating it makes the token type requestable on the wire.
  const on = await exchangeHarness(t, { idJag: true });
  const onPort = hostAuthorizedTokenExchange(on.policy, on.resolved, on.client);
  const onSubject = await on.server.mintToken({
    subject: "user-1",
    audience: on.client.client.client_id,
  });
  const outcome = await exchangeToken(on.ctx(), onPort, {
    subjectToken: onSubject,
    subjectTokenType: tokenTypeIdentifiers.accessToken,
    requestedTokenType: tokenTypeIdentifiers.idJag,
    resource: RESOURCE,
    scope: scopeOf(on),
  });
  assert.equal(outcome.issuedTokenType, tokenTypeIdentifiers.idJag);
  assert.equal(
    on.server.tokenRequests.at(-1)!.parameters["requested_token_type"],
    tokenTypeIdentifiers.idJag,
  );
});

test("a subject token type outside policy is refused", async (t) => {
  const harness = await exchangeHarness(t);
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const subjectToken = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.client.client.client_id,
  });
  await assert.rejects(
    exchangeToken(harness.ctx(), port, {
      subjectToken,
      subjectTokenType: tokenTypeIdentifiers.refreshToken,
      resource: RESOURCE,
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.exchange.subject-type-not-allowed",
  );
});

test("granted scope from the exchange is reported as provider scopes", async (t) => {
  const harness = await exchangeHarness(t);
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const subjectToken = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.client.client.client_id,
  });
  const outcome = await exchangeToken(harness.ctx(), port, {
    subjectToken,
    subjectTokenType: tokenTypeIdentifiers.accessToken,
    resource: RESOURCE,
    scopes: ["read:items"],
    scope: scopeOf(harness),
  });
  assert.deepEqual(outcome.permissions.requested, ["read:items"]);
  assert.deepEqual(outcome.permissions.reported, ["read:items"]);
  assert.equal(outcome.permissions.semantics, "provider-scopes");
  assert.deepEqual(outcome.permissions.observed, []);
});
