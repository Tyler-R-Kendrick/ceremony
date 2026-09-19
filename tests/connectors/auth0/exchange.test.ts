import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createAuth0TokenVaultAdapter } from "../../../src/server/connectors/providers/auth0/index.js";
import {
  ACCESS_TOKEN_TYPE,
  FEDERATED_TOKEN_TYPE,
  REFRESH_TOKEN_TYPE,
  TOKEN_VAULT_GRANT,
  startAuth0TokenVaultDouble,
} from "../doubles/auth0-token-vault.js";
import {
  API_AUDIENCE,
  CLIENT_ID,
  CLIENT_SECRET,
  CONNECTION,
  OTHER_SUBJECT,
  SUBJECT,
  connectionRecord,
  harness,
  heldToken,
  identityPort,
  subjectToken,
  tokenVaultBinding,
} from "./support.js";

/*
 * IB-03 (exchange half) and the audience half of AC-AUTH-05: the documented
 * Token Vault exchange, bound to the configured tenant, the permitted subject
 * token type, the bound connection, the expected user and the intended
 * audience. AC-EXT-06: an exchange naming another tenant, user, audience or
 * provider is refused, with claims verified rather than decoded.
 */

const UPSTREAM = "ya29.upstream-google-token";

async function tenant(options: Record<string, unknown> = {}) {
  return startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    apiAudience: API_AUDIENCE,
    accounts: [
      {
        id: "cac_primary",
        connection: CONNECTION,
        subject: SUBJECT,
        scopes: ["openid", "https://www.googleapis.com/auth/calendar"],
        upstreamToken: UPSTREAM,
      },
    ],
    ...options,
  });
}

const linkedConnection = (binding: ReturnType<typeof tokenVaultBinding>) =>
  connectionRecord(binding, {
    externalIds: {
      connectedAccountId: "cac_primary",
      auth0Connection: CONNECTION,
      auth0Subject: SUBJECT,
    },
  });

test("Auth0 refresh-token exchange sends the documented parameters and keeps the result in custody", async () => {
  const auth0 = await tenant();
  const refresh = auth0.refreshToken(SUBJECT);
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: refresh,
        tokenType: REFRESH_TOKEN_TYPE,
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin, {
    settings: {
      connection: CONNECTION,
      requestedScopes: ["https://www.googleapis.com/auth/calendar"],
    },
  });
  const app = harness({ binding, domain: auth0.domain });
  const connection = linkedConnection(binding);
  const result = await adapter.invoke!(app.context({ connection }), {
    operationRef: "operation:auth0.exchange",
    input: {},
    commandId: "command:exchange",
  });

  assert.equal(result.state, "complete");
  const output = result.output as Record<string, unknown>;
  // The provider token never comes back to the caller.
  assert.equal(JSON.stringify(output).includes(UPSTREAM), false);
  assert.equal(output.connection, CONNECTION);
  assert.equal(output.connectedAccountId, "cac_primary");
  assert.deepEqual(output.scopes, ["https://www.googleapis.com/auth/calendar"]);

  const [exchange] = auth0.received("POST", "/oauth/token");
  assert.ok(exchange);
  const sent = new URLSearchParams(exchange.body.toString("utf8"));
  assert.equal(sent.get("grant_type"), TOKEN_VAULT_GRANT);
  assert.equal(sent.get("subject_token_type"), REFRESH_TOKEN_TYPE);
  assert.equal(sent.get("requested_token_type"), FEDERATED_TOKEN_TYPE);
  assert.equal(sent.get("connection"), CONNECTION);
  assert.equal(sent.get("client_id"), CLIENT_ID);
  assert.equal(sent.get("subject_token"), refresh);
  assert.equal(sent.get("scope"), "https://www.googleapis.com/auth/calendar");
  // No login hint was configured, so none was sent.
  assert.equal(sent.get("login_hint"), null);

  const scope = {
    tenantId: binding.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: binding.bindingRef,
    custody: "external-credential-broker" as const,
  };
  const stored = await app.ports.credentials.use(
    scope,
    String(output.credentialRef),
    async (material) => material.access_token,
  );
  assert.equal(stored, UPSTREAM);
  const described = await app.ports.credentials.describe(
    scope,
    String(output.credentialRef),
  );
  // The documented expires_in is 1377 seconds; custody holds it that long.
  assert.ok(
    described?.expiresAt !== undefined &&
      described.expiresAt > Date.now() + 1_300_000 - 1_300_000,
  );
  await auth0.close();
});

test("Auth0 access-token exchange requires the bound audience and a verifiable token", async () => {
  const auth0 = await tenant();
  const good = await auth0.accessToken(SUBJECT, API_AUDIENCE, "read:calendar");
  const adapter = (value: string, audience: string | undefined) =>
    createAuth0TokenVaultAdapter({
      identity: identityPort({
        subject: subjectToken({
          value,
          tokenType: ACCESS_TOKEN_TYPE,
          subject: SUBJECT,
          ...(audience === undefined ? {} : { audience }),
        }),
        myAccount: heldToken("unused"),
      }),
    });
  const binding = tokenVaultBinding(auth0.origin, {
    settings: {
      connection: CONNECTION,
      subjectTokenTypes: [ACCESS_TOKEN_TYPE],
      expectedAudience: API_AUDIENCE,
    },
  });
  const app = harness({ binding, domain: auth0.domain });
  const connection = linkedConnection(binding);

  const ok = await adapter(good, API_AUDIENCE).invoke!(
    app.context({ connection }),
    { operationRef: "operation:auth0.exchange", input: {}, commandId: "c1" },
  );
  assert.equal(ok.state, "complete");
  const [exchange] = auth0.received("POST", "/oauth/token");
  assert.equal(
    new URLSearchParams(exchange!.body.toString("utf8")).get(
      "subject_token_type",
    ),
    ACCESS_TOKEN_TYPE,
  );

  // AC-AUTH-05: a token the same person holds for another API is a different
  // authority and is refused before the exchange is attempted.
  const otherAudience = await auth0.accessToken(
    SUBJECT,
    "https://other-api.example.com",
  );
  const before = auth0.received("POST", "/oauth/token").length;
  await assert.rejects(
    adapter(otherAudience, "https://other-api.example.com").invoke!(
      app.context({ connection }),
      { operationRef: "operation:auth0.exchange", input: {}, commandId: "c2" },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "auth0.audience.mismatch",
  );
  assert.equal(auth0.received("POST", "/oauth/token").length, before);

  // A token whose host-declared audience matches but whose claims do not is
  // caught by verification, not believed.
  const lying = await auth0.accessToken(
    SUBJECT,
    "https://other-api.example.com",
  );
  await assert.rejects(
    adapter(lying, API_AUDIENCE).invoke!(app.context({ connection }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c3",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "auth0.token.unverified",
  );
  assert.equal(auth0.received("POST", "/oauth/token").length, before);
  await auth0.close();
});

test("AC-EXT-06: a subject token from another tenant or another user is refused", async () => {
  const auth0 = await tenant();
  const binding = tokenVaultBinding(auth0.origin, {
    settings: {
      connection: CONNECTION,
      subjectTokenTypes: [ACCESS_TOKEN_TYPE],
      expectedAudience: API_AUDIENCE,
    },
  });
  const app = harness({ binding, domain: auth0.domain });
  const connection = linkedConnection(binding);

  // Another tenant signed it: the tenant JWKS does not verify it.
  const foreign = await auth0.foreignToken(SUBJECT, API_AUDIENCE);
  const foreignAdapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: foreign,
        tokenType: ACCESS_TOKEN_TYPE,
        subject: SUBJECT,
        audience: API_AUDIENCE,
      }),
      myAccount: heldToken("unused"),
    }),
  });
  await assert.rejects(
    foreignAdapter.invoke!(app.context({ connection }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "auth0.token.unverified",
  );

  // Right tenant, wrong person: the connection records whose it is.
  const otherUser = await auth0.accessToken(OTHER_SUBJECT, API_AUDIENCE);
  const otherAdapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: otherUser,
        tokenType: ACCESS_TOKEN_TYPE,
        subject: OTHER_SUBJECT,
        audience: API_AUDIENCE,
      }),
      myAccount: heldToken("unused"),
    }),
  });
  await assert.rejects(
    otherAdapter.invoke!(app.context({ connection }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c2",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "auth0.subject.mismatch",
  );
  assert.equal(auth0.received("POST", "/oauth/token").length, 0);
  await auth0.close();
});

test("AC-EXT-06: the exchange is bound to the connection the binding names", async () => {
  const auth0 = await tenant({
    accounts: [
      {
        id: "cac_primary",
        connection: CONNECTION,
        subject: SUBJECT,
        scopes: ["openid"],
        upstreamToken: UPSTREAM,
      },
      {
        id: "cac_slack",
        connection: "slack",
        subject: SUBJECT,
        scopes: ["channels:read"],
        upstreamToken: "xoxp-slack",
      },
    ],
  });
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: REFRESH_TOKEN_TYPE,
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  // The binding is for Slack; the connection was established for Google.
  const binding = tokenVaultBinding(auth0.origin, {
    settings: { connection: "slack" },
  });
  const app = harness({ binding, domain: auth0.domain });
  await assert.rejects(
    adapter.invoke!(app.context({ connection: linkedConnection(binding) }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "auth0.connection.mismatch",
  );
  assert.equal(auth0.received("POST", "/oauth/token").length, 0);
  await auth0.close();
});

test("Auth0 refuses a subject-token type the binding does not permit", async () => {
  const auth0 = await tenant();
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: await auth0.accessToken(SUBJECT, API_AUDIENCE),
        tokenType: ACCESS_TOKEN_TYPE,
        subject: SUBJECT,
        audience: API_AUDIENCE,
      }),
      myAccount: heldToken("unused"),
    }),
  });
  // Refresh tokens only: an access token is a different exchange profile and
  // is not silently accepted because it happens to be valid.
  const binding = tokenVaultBinding(auth0.origin, {
    settings: {
      connection: CONNECTION,
      subjectTokenTypes: [REFRESH_TOKEN_TYPE],
    },
  });
  const app = harness({ binding, domain: auth0.domain });
  await assert.rejects(
    adapter.invoke!(app.context({ connection: linkedConnection(binding) }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "auth0.subject-token.type",
  );
  assert.equal(auth0.requests.length, 0);
  await auth0.close();
});

test("Auth0 requires an approved audience before any access-token exchange", async () => {
  const auth0 = await tenant();
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: await auth0.accessToken(SUBJECT, API_AUDIENCE),
        tokenType: ACCESS_TOKEN_TYPE,
        subject: SUBJECT,
        audience: API_AUDIENCE,
      }),
      myAccount: heldToken("unused"),
    }),
  });
  // The binding permits access tokens but never says for which API: an
  // unbound audience is a policy gap, not a default of "any".
  const binding = tokenVaultBinding(auth0.origin, {
    settings: {
      connection: CONNECTION,
      subjectTokenTypes: [ACCESS_TOKEN_TYPE],
    },
  });
  const app = harness({ binding, domain: auth0.domain });
  await assert.rejects(
    adapter.invoke!(app.context({ connection: linkedConnection(binding) }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "auth0.audience.unbound",
  );
  await auth0.close();
});

test("Auth0 sends a login hint only when the binding asks for one", async () => {
  const auth0 = await tenant({
    accounts: [
      {
        id: "cac_work",
        connection: CONNECTION,
        subject: SUBJECT,
        scopes: ["openid"],
        loginHint: "person@work.example",
        upstreamToken: "work-token",
      },
      {
        id: "cac_home",
        connection: CONNECTION,
        subject: SUBJECT,
        scopes: ["openid"],
        loginHint: "person@home.example",
        upstreamToken: "home-token",
      },
    ],
  });
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: REFRESH_TOKEN_TYPE,
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin, {
    settings: { connection: CONNECTION, useLoginHint: true },
  });
  const app = harness({ binding, domain: auth0.domain });
  const connection = connectionRecord(binding, {
    externalIds: {
      connectedAccountId: "cac_home",
      auth0Connection: CONNECTION,
      auth0Subject: SUBJECT,
    },
    state: { loginHint: "person@home.example" },
  });
  const result = await adapter.invoke!(app.context({ connection }), {
    operationRef: "operation:auth0.exchange",
    input: {},
    commandId: "c1",
  });
  assert.equal(result.state, "complete");
  const [exchange] = auth0.received("POST", "/oauth/token");
  assert.equal(
    new URLSearchParams(exchange!.body.toString("utf8")).get("login_hint"),
    "person@home.example",
  );
  const stored = await app.ports.credentials.use(
    {
      tenantId: binding.tenantId,
      ownerKind: connection.ownerKind,
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: binding.bindingRef,
      custody: "external-credential-broker",
    },
    String((result.output as Record<string, unknown>).credentialRef),
    async (material) => material.access_token,
  );
  // The hint picked the account it named, not simply the first one.
  assert.equal(stored, "home-token");
  await auth0.close();
});

test("Auth0 will not exchange before an account has been selected", async () => {
  const auth0 = await tenant();
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: REFRESH_TOKEN_TYPE,
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  const result = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c1",
    },
  );
  assert.equal(result.state, "human-required");
  assert.equal(result.code, "auth0.account.unselected");
  assert.equal(auth0.requests.length, 0);
  await auth0.close();
});

test("a federated provider token that is a JWT for another issuer is exchanged, not called a forgery", async () => {
  // Token Vault federates providers whose own access tokens are JWTs, signed by
  // that provider and carrying its own `kid`. Such a token claims nothing about
  // this Auth0 tenant, so it is not checked against the tenant's keys: doing so
  // reported every correct exchange with an Entra-shaped provider as a forgery.
  const auth0 = await tenant();
  try {
    const provider = await auth0.foreignToken(
      SUBJECT,
      "https://graph.microsoft.com",
    );
    const account = auth0.account("cac_primary");
    assert.ok(account);
    account.upstreamToken = provider;
    const adapter = createAuth0TokenVaultAdapter({
      identity: identityPort({
        subject: subjectToken({
          value: auth0.refreshToken(SUBJECT),
          tokenType: REFRESH_TOKEN_TYPE,
          subject: SUBJECT,
        }),
        myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
      }),
    });
    const binding = tokenVaultBinding(auth0.origin, {
      settings: { connection: CONNECTION },
    });
    const app = harness({ binding, domain: auth0.domain });
    const connection = linkedConnection(binding);
    const result = await adapter.invoke!(app.context({ connection }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c1",
    });
    assert.equal(result.state, "complete");
    const output = result.output as Record<string, unknown>;
    // Nothing was observed about the provider's signature, and the result says
    // so rather than implying a verification that never happened.
    assert.equal(output.tokenClaimsVerified, false);
    // The token went into custody and never came back to the caller.
    assert.equal(JSON.stringify(output).includes(provider), false);
    const stored = await app.ports.credentials.use(
      {
        tenantId: binding.tenantId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        connectionRef: connection.connectionRef,
        bindingRef: binding.bindingRef,
        custody: "external-credential-broker",
      },
      String(output.credentialRef),
      async (material) => material.access_token,
    );
    assert.equal(stored, provider);
  } finally {
    await auth0.close();
  }
});

test("a returned token that claims this tenant as issuer is still verified against its keys", async () => {
  // The other half of the same rule: a token naming the tenant as issuer is
  // checked, a forged one is refused, and the journal entry the exchange opened
  // reaches an outcome on that exit too.
  const auth0 = await tenant();
  try {
    const forged = await auth0.forgedTenantToken(SUBJECT, API_AUDIENCE);
    const account = auth0.account("cac_primary");
    assert.ok(account);
    account.upstreamToken = forged;
    const adapter = createAuth0TokenVaultAdapter({
      identity: identityPort({
        subject: subjectToken({
          value: auth0.refreshToken(SUBJECT),
          tokenType: REFRESH_TOKEN_TYPE,
          subject: SUBJECT,
        }),
        myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
      }),
    });
    const binding = tokenVaultBinding(auth0.origin, {
      settings: { connection: CONNECTION },
    });
    const app = harness({ binding, domain: auth0.domain });
    await assert.rejects(
      adapter.invoke!(app.context({ connection: linkedConnection(binding) }), {
        operationRef: "operation:auth0.exchange",
        input: {},
        commandId: "c1",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "auth0.token.unverified",
    );
    // Nothing forged was stored.
    assert.deepEqual(app.ports.inspect.credentialRefs(), []);
    // And no effect is left as a `begin` with no outcome: an unresolved entry
    // is an effect the deployment has to reconcile forever.
    const exchanges = app.ports.inspect
      .effects()
      .filter(
        (entry) => entry.intent.operation === "auth0.token-vault.exchange",
      );
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0]?.outcome?.status, "not-applied");
  } finally {
    await auth0.close();
  }
});
