import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireClientCredentials,
  CLIENT_CREDENTIALS_GRANT,
  OAUTH_CLIENT_CREDENTIALS_OPERATION,
  renewClientCredentials,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { CredentialScope } from "../../../src/server/connectors/ports.js";
import { authHarness, type AuthHarness } from "./harness.js";

/*
 * Client credentials against the loopback fixture authorization server. The
 * fixture authenticates the client itself and refuses the grant to any client
 * it holds no secret for, so these tests pass only when the request on the
 * wire is a real confidential-client grant.
 */

const SECRET = "cc-secret-71e2";

async function confidential(t: test.TestContext) {
  return authHarness(t, {
    server: {
      clientCredentials: true,
      clientSecret: SECRET,
    },
    configuration: {
      OAUTH_CLIENT_ID: "fixture-client",
      OAUTH_CLIENT_SECRET: SECRET,
    },
    policy: {
      registration: {
        allowed: ["pre-registered"],
        clientIdConfiguration: "OAUTH_CLIENT_ID",
        clientSecretConfiguration: "OAUTH_CLIENT_SECRET",
      },
    },
  });
}

function scopeOf(harness: AuthHarness): CredentialScope {
  const connection = harness.connection;
  return {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody: connection.custody,
  };
}

test("a confidential client gets a token for itself, stored in custody, with no account claimed", async (t) => {
  const harness = await confidential(t);
  const result = await acquireClientCredentials(harness.ctx(), {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["profile"],
    scope: scopeOf(harness),
  });
  assert.equal(result.state, "complete");
  assert.ok(result.credentialRef);
  const [request] = harness.server.tokenRequests;
  assert.equal(request?.grantType, CLIENT_CREDENTIALS_GRANT);
  assert.equal(request?.parameters["scope"], "profile");
  assert.ok(request?.authorization?.startsWith("Basic "));
  const material = harness.ports.inspect.credentialMaterial(
    result.credentialRef!,
  );
  assert.ok(material?.["access_token"]);
  assert.equal(material?.["grant"], CLIENT_CREDENTIALS_GRANT);
  assert.equal(material?.["refresh_token"], undefined);
  assert.deepEqual(
    result.claims.map((claim) => claim.kind),
    ["credential-accepted"],
  );
  assert.equal(result.target, undefined);
  // Neither the token nor the client secret appears in what is returned.
  const shown = JSON.stringify(result);
  assert.ok(!shown.includes(material!["access_token"]!));
  assert.ok(!shown.includes(SECRET));
  const journal = harness.ports.inspect
    .effects()
    .filter(
      (entry) => entry.intent.operation === OAUTH_CLIENT_CREDENTIALS_OPERATION,
    );
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.outcome?.status, "applied");
});

test("a public client is refused before any request is sent", async (t) => {
  const harness = await authHarness(t, {
    server: { clientCredentials: true },
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  await assert.rejects(
    acquireClientCredentials(harness.ctx(), {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      scopes: [],
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "oauth.client-credentials.public-client",
  );
  assert.equal(harness.server.counts.token, 0);
});

test("an issuer error is a sanitized code; the provider's description is not repeated", async (t) => {
  const harness = await authHarness(t, {
    server: { clientSecret: SECRET },
    configuration: {
      OAUTH_CLIENT_ID: "fixture-client",
      OAUTH_CLIENT_SECRET: SECRET,
    },
    policy: {
      registration: {
        allowed: ["pre-registered"],
        clientIdConfiguration: "OAUTH_CLIENT_ID",
        clientSecretConfiguration: "OAUTH_CLIENT_SECRET",
      },
    },
  });
  // The fixture here does not offer the grant at all.
  await assert.rejects(
    acquireClientCredentials(harness.ctx(), {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      scopes: [],
      scope: scopeOf(harness),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "upstream-rejected" &&
      error.detail === "oauth.token.unsupported-grant-type",
  );
});

test("renewal replaces the token in place, and a token another worker already renewed is kept", async (t) => {
  const harness = await confidential(t);
  const ctx = harness.ctx();
  const scope = scopeOf(harness);
  const first = await acquireClientCredentials(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["profile"],
    scope,
  });
  const ref = first.credentialRef!;
  const before = harness.ports.inspect.credentialMaterial(ref)!["access_token"];
  const renewed = await renewClientCredentials(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: [],
    scope,
    credentialRef: ref,
  });
  assert.equal(renewed.credentialRef, ref);
  const after = harness.ports.inspect.credentialMaterial(ref)!;
  assert.notEqual(after["access_token"], before);
  assert.equal(after["scope"], "profile", "the held scope is requested again");
  assert.equal(harness.server.tokenRequests.length, 2);

  // A caller that saw the *old* token fail finds a newer one held: nothing
  // is sent, and the newer token stays.
  await renewClientCredentials(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: [],
    scope,
    credentialRef: ref,
    stillStale: (current) => current["access_token"] === before,
  });
  assert.equal(harness.server.tokenRequests.length, 2);
  assert.equal(
    harness.ports.inspect.credentialMaterial(ref)!["access_token"],
    after["access_token"],
  );
});

test("renewal refuses a credential that did not come from this grant", async (t) => {
  const harness = await confidential(t);
  const scope = scopeOf(harness);
  const ref = await harness.ports.credentials.store(scope, {
    access_token: "at-from-elsewhere",
    refresh_token: "rt-from-elsewhere",
  });
  await assert.rejects(
    renewClientCredentials(harness.ctx(), {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      scopes: [],
      scope,
      credentialRef: ref,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.client-credentials.not-this-grant",
  );
  assert.equal(harness.server.counts.token, 0);
});
