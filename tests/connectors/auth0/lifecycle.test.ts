import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createAuth0TokenVaultAdapter } from "../../../src/server/connectors/providers/auth0/index.js";
import {
  REFRESH_TOKEN_TYPE,
  TOKEN_VAULT_GRANT,
  startAuth0TokenVaultDouble,
} from "../doubles/auth0-token-vault.js";
import { canaries } from "../fixtures/builders.js";
import {
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
 * IB-04: reconnect, expiry and revocation mapping, and explicit failure for an
 * unavailable grant or unsupported exchange. IB-05: nothing an upstream body
 * carries reaches a caller.
 */

const linked = {
  id: "cac_primary",
  connection: CONNECTION,
  subject: SUBJECT,
  scopes: ["openid"],
  upstreamToken: "ya29.upstream",
};

async function adapterFor(
  auth0: Awaited<ReturnType<typeof startAuth0TokenVaultDouble>>,
) {
  return createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: REFRESH_TOKEN_TYPE,
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
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

test("Auth0 maps the documented missing-refresh-token and consent errors to reconnect", async () => {
  for (const failure of [
    {
      status: 403,
      error: "invalid_grant",
      description:
        "The connection does not have a refresh token; the user must re-consent.",
    },
    { status: 400, error: "consent_required" },
    { status: 401, error: "login_required" },
    { status: 403, error: "unmet_authentication_requirements" },
  ]) {
    const auth0 = await startAuth0TokenVaultDouble({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      accounts: [linked],
      failWith: failure,
    });
    const adapter = await adapterFor(auth0);
    const binding = tokenVaultBinding(auth0.origin);
    const app = harness({ binding, domain: auth0.domain });
    const result = await adapter.invoke!(
      app.context({ connection: linkedConnection(binding) }),
      {
        operationRef: "operation:auth0.exchange",
        input: {},
        commandId: `command:${failure.error}`,
      },
    );
    assert.equal(result.state, "human-required", failure.error);
    assert.equal(result.code, "auth0.reconnect-required", failure.error);
    // No credential was written and the journal records no applied effect.
    assert.deepEqual(app.ports.inspect.credentialRefs(), []);
    const [effect] = app.ports.inspect.effects();
    assert.equal(effect?.outcome?.status, "not-applied");
    await auth0.close();
  }
});

test("Auth0 reports an unavailable grant as unsupported rather than retrying another way", async () => {
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked],
    // The Token Vault grant is not enabled on this client.
    grantTypes: ["authorization_code", "refresh_token"],
  });
  const adapter = await adapterFor(auth0);
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  await assert.rejects(
    adapter.invoke!(app.context({ connection: linkedConnection(binding) }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "command:grant",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "auth0.grant.unsupported",
  );
  // Exactly one attempt: no second grant was tried.
  assert.equal(auth0.received("POST", "/oauth/token").length, 1);
  await auth0.close();
});

test("Auth0 maps MFA and client rejection to their own outcomes", async () => {
  const mfa = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked],
    failWith: {
      status: 401,
      error: "mfa_required",
      description: "Multifactor authentication required",
    },
  });
  const mfaAdapter = await adapterFor(mfa);
  const mfaBinding = tokenVaultBinding(mfa.origin);
  const mfaApp = harness({ binding: mfaBinding, domain: mfa.domain });
  const mfaResult = await mfaAdapter.invoke!(
    mfaApp.context({ connection: linkedConnection(mfaBinding) }),
    { operationRef: "operation:auth0.exchange", input: {}, commandId: "c" },
  );
  assert.equal(mfaResult.state, "human-required");
  assert.equal(mfaResult.code, "auth0.mfa-required");
  await mfa.close();

  const wrongSecret = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: "another-secret",
    accounts: [linked],
  });
  const adapter = await adapterFor(wrongSecret);
  const binding = tokenVaultBinding(wrongSecret.origin);
  const app = harness({ binding, domain: wrongSecret.domain });
  await assert.rejects(
    adapter.invoke!(app.context({ connection: linkedConnection(binding) }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "auth0.client.rejected",
  );
  await wrongSecret.close();
});

test("Auth0 treats a removed link as a revoked connection, not a transient failure", async () => {
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked],
  });
  const adapter = await adapterFor(auth0);
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  const connection = linkedConnection(binding);
  assert.equal(
    (await adapter.verify!(app.context({ connection }))).state,
    "complete",
  );

  // The person removed the link in their account settings.
  auth0.unlink("cac_primary");
  const gone = await adapter.verify!(app.context({ connection }));
  assert.equal(gone.state, "denied");
  assert.equal(gone.code, "auth0.account.removed");

  // And the exchange now reports that a person must act, with no credential.
  const exchanged = await adapter.invoke!(app.context({ connection }), {
    operationRef: "operation:auth0.exchange",
    input: {},
    commandId: "c",
  });
  assert.equal(exchanged.state, "human-required");
  assert.equal(exchanged.code, "auth0.reconnect-required");
  assert.deepEqual(app.ports.inspect.credentialRefs(), []);
  await auth0.close();
});

test("Auth0 refuses to verify when the host's subject no longer matches the connection", async () => {
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked, { ...linked, id: "cac_other", subject: OTHER_SUBJECT }],
  });
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(OTHER_SUBJECT),
        tokenType: REFRESH_TOKEN_TYPE,
        subject: OTHER_SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(OTHER_SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  const result = await adapter.verify!(
    app.context({ connection: linkedConnection(binding) }),
  );
  assert.equal(result.state, "denied");
  assert.equal(result.code, "auth0.subject-changed");
  // Nothing was listed for the wrong person.
  assert.equal(
    auth0.received("GET", "/me/v1/connected-accounts/accounts").length,
    0,
  );
  await auth0.close();
});

test("Auth0 refuses an expired host token before it reaches the tenant", async () => {
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked],
  });
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: REFRESH_TOKEN_TYPE,
        subject: SUBJECT,
        expiresAt: Date.now() - 1000,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  await assert.rejects(
    adapter.invoke!(app.context({ connection: linkedConnection(binding) }), {
      operationRef: "operation:auth0.exchange",
      input: {},
      commandId: "c",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "expired" &&
      error.detail === "auth0.subject-token.expired",
  );
  assert.equal(auth0.received("POST", "/oauth/token").length, 0);
  await auth0.close();
});

test("Auth0 disconnect separates local, broker and upstream, and revoke stays unsupported", async () => {
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked],
  });
  const adapter = await adapterFor(auth0);
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  const connection = linkedConnection(binding);

  assert.deepEqual(
    await adapter.disconnect!(app.context({ connection }), "local"),
    { local: "applied", broker: "not-attempted", upstream: "not-attempted" },
  );
  assert.equal(auth0.requests.length, 0);

  assert.deepEqual(
    await adapter.disconnect!(app.context({ connection }), "broker"),
    { local: "applied", broker: "applied", upstream: "unsupported" },
  );
  assert.equal(auth0.account("cac_primary"), undefined);

  assert.deepEqual(
    await adapter.disconnect!(app.context({ connection }), "upstream"),
    {
      local: "not-attempted",
      broker: "not-attempted",
      upstream: "unsupported",
    },
  );
  assert.deepEqual(await adapter.revoke!(app.context({ connection })), {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "unsupported",
  });
  const revoke = adapter
    .capabilities(
      new Set(["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"]),
    )
    .find((status) => status.dimension === "revoke");
  assert.equal(revoke?.implementation, "unsupported");
  assert.ok(
    revoke?.limitations.some((text) => text.includes("external provider")),
  );
  await auth0.close();
});

test("Auth0 never lets an upstream error body reach a caller", async () => {
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked],
    failWith: {
      status: 400,
      error: "invalid_grant",
      // A provider description carrying a canary and a signed URL.
      description: `${canaries.providerMessage} see ${canaries.signedUrl}`,
    },
  });
  const adapter = await adapterFor(auth0);
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  const result = await adapter.invoke!(
    app.context({ connection: linkedConnection(binding) }),
    { operationRef: "operation:auth0.exchange", input: {}, commandId: "c" },
  );
  const serialized = JSON.stringify(result);
  for (const canary of [
    canaries.providerMessage,
    canaries.signedUrl,
    canaries.secret,
  ])
    assert.equal(serialized.includes(canary), false, canary);
  assert.equal(result.state, "human-required");
  assert.equal(result.code, "auth0.reconnect-required");
  await auth0.close();
});

test("Auth0 configuration gaps are reported without contacting the tenant", async () => {
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked],
  });
  const adapter = await adapterFor(auth0);
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({
    binding,
    domain: auth0.domain,
    configuration: { AUTH0_DOMAIN: auth0.domain, AUTH0_CLIENT_ID: CLIENT_ID },
  });
  await assert.rejects(
    adapter.verify!(app.context({ connection: linkedConnection(binding) })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required",
  );
  assert.equal(auth0.requests.length, 0);
  const statuses = adapter.capabilities(
    new Set(["AUTH0_DOMAIN", "AUTH0_CLIENT_ID"]),
  );
  for (const dimension of ["authorize", "invoke", "verify"])
    assert.equal(
      statuses.find((status) => status.dimension === dimension)?.configuration,
      "missing",
      dimension,
    );
  await auth0.close();
});

test("Auth0 exchange is what the documented grant says, and nothing else", async () => {
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [linked],
  });
  const adapter = await adapterFor(auth0);
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  await adapter.invoke!(
    app.context({ connection: linkedConnection(binding) }),
    { operationRef: "operation:auth0.exchange", input: {}, commandId: "c" },
  );
  const [exchange] = auth0.received("POST", "/oauth/token");
  assert.equal(
    exchange!.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  const sent = new URLSearchParams(exchange!.body.toString("utf8"));
  assert.equal(sent.get("grant_type"), TOKEN_VAULT_GRANT);
  // No audience, no resource, no ad-hoc parameters: only what is documented.
  assert.deepEqual([...sent.keys()].sort(), [
    "client_id",
    "client_secret",
    "connection",
    "grant_type",
    "requested_token_type",
    "subject_token",
    "subject_token_type",
  ]);
  await auth0.close();
});
