import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createAuth0TokenVaultAdapter } from "../../../src/server/connectors/providers/auth0/index.js";
import {
  REFRESH_TOKEN_TYPE,
  startAuth0TokenVaultDouble,
} from "../doubles/auth0-token-vault.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { canaryValues } from "../fixtures/builders.js";
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
 * IB-05, Auth0 half: the recorded documented payloads from
 * `tests/connectors/fixtures/auth0/` are replayed verbatim, and a shared
 * display identity is shown to be insufficient to link two people.
 */

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/auth0/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as Record<string, any>;

const linkedConnection = (binding: ReturnType<typeof tokenVaultBinding>) =>
  connectionRecord(binding, {
    externalIds: {
      connectedAccountId: "cac_6ZqSK7Kj1R8LDZJvSb1tAn",
      auth0Connection: CONNECTION,
      auth0Subject: SUBJECT,
    },
  });

/** Replays a recorded body for the token endpoint and the accounts listing. */
async function replay(
  bodies: {
    token?: { status: number; body: unknown };
    accounts?: unknown;
  },
) {
  return startHttpFixture((request) => {
    if (request.url.pathname === "/oauth/token" && bodies.token)
      return {
        status: bodies.token.status,
        body: bodies.token.body as Record<string, unknown>,
      };
    if (
      request.url.pathname === "/me/v1/connected-accounts/accounts" &&
      bodies.accounts
    )
      return { status: 200, body: bodies.accounts as Record<string, unknown> };
    return { status: 404, body: { status: 404, title: "Not Found" } };
  });
}

function adapterWith(refresh: string) {
  return createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: refresh,
        tokenType: REFRESH_TOKEN_TYPE,
        subject: SUBJECT,
      }),
      myAccount: heldToken("my-account-token"),
    }),
  });
}

test("Auth0 documented exchange response: the provider token reaches custody and nothing else", async () => {
  const recorded = fixture("exchange-success.json");
  const server = await replay({ token: { status: 200, body: recorded } });
  const binding = tokenVaultBinding(server.origin);
  const app = harness({ binding, domain: new URL(server.origin).host });
  const connection = linkedConnection(binding);
  const result = await adapterWith("rt_fixture").invoke!(
    app.context({ connection }),
    { operationRef: "operation:auth0.exchange", input: {}, commandId: "c" },
  );
  assert.equal(result.state, "complete");
  const serialized = JSON.stringify(result);
  for (const canary of canaryValues)
    assert.equal(serialized.includes(canary), false, canary);
  const output = result.output as Record<string, unknown>;
  assert.deepEqual(output.scopes, [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "openid",
  ]);
  // The documented expires_in of 1377 seconds becomes the custody lease.
  const described = await app.ports.credentials.describe(
    {
      tenantId: binding.tenantId,
      ownerKind: connection.ownerKind,
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: binding.bindingRef,
      custody: "external-credential-broker",
    },
    String(output.credentialRef),
  );
  assert.ok(described?.expiresAt);
  assert.equal(output.tokenClaimsVerified, false);
  await server.close();
});

test("Auth0 documented error bodies map to their outcomes without echoing the description", async () => {
  const recorded = fixture("exchange-errors.json");
  const expectations: Record<
    string,
    { state?: string; code?: string; error?: string; detail?: string }
  > = {
    missing_refresh_token: {
      state: "human-required",
      code: "auth0.reconnect-required",
    },
    consent_required: {
      state: "human-required",
      code: "auth0.reconnect-required",
    },
    unknown_user: {
      state: "human-required",
      code: "auth0.reconnect-required",
    },
    unsupported_grant: { error: "unsupported", detail: "auth0.grant.unsupported" },
    invalid_client: { error: "denied", detail: "auth0.client.rejected" },
    mfa_required: { state: "human-required", code: "auth0.mfa-required" },
  };
  for (const [name, expectation] of Object.entries(expectations)) {
    const entry = recorded[name] as { status: number; body: unknown };
    const server = await replay({ token: entry });
    const binding = tokenVaultBinding(server.origin);
    const app = harness({ binding, domain: new URL(server.origin).host });
    const call = adapterWith("rt_fixture").invoke!(
      app.context({ connection: linkedConnection(binding) }),
      { operationRef: "operation:auth0.exchange", input: {}, commandId: name },
    );
    if (expectation.error) {
      await assert.rejects(
        call,
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === expectation.error &&
          error.detail === expectation.detail,
        name,
      );
    } else {
      const result = await call;
      assert.equal(result.state, expectation.state, name);
      assert.equal(result.code, expectation.code, name);
      const serialized = JSON.stringify(result);
      for (const canary of canaryValues)
        assert.equal(serialized.includes(canary), false, `${name}:${canary}`);
    }
    assert.deepEqual(app.ports.inspect.credentialRefs(), [], name);
    await server.close();
  }
});

test("Auth0 documented accounts listing is filtered to the bound connection", async () => {
  const recorded = fixture("connected-accounts.json");
  const server = await replay({ accounts: recorded });
  const binding = tokenVaultBinding(server.origin);
  const app = harness({ binding, domain: new URL(server.origin).host });
  const result = await adapterWith("rt_fixture").invoke!(
    app.context({ connection: linkedConnection(binding) }),
    {
      operationRef: "operation:auth0.accounts",
      input: {},
      commandId: "command:list",
    },
  );
  assert.equal(result.state, "complete");
  const output = result.output as {
    accounts: Array<{ id: string; connection: string; scopes: string[] }>;
    selected: string | null;
  };
  // The recording carries two accounts; the adapter asked the tenant to filter
  // by the bound connection, and reports which one this connection selected.
  assert.equal(output.selected, "cac_6ZqSK7Kj1R8LDZJvSb1tAn");
  const [request] = server.received(
    "GET",
    "/me/v1/connected-accounts/accounts",
  );
  assert.equal(request!.url.searchParams.get("connection"), CONNECTION);
  assert.equal(request!.headers.authorization, "Bearer my-account-token");
  await server.close();
});

test("Auth0: a shared email is never enough to link two identities", async () => {
  const shared = "shared-person@example.invalid";
  const auth0 = await startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [
      {
        id: "cac_first",
        connection: CONNECTION,
        subject: SUBJECT,
        scopes: ["openid"],
        loginHint: shared,
        upstreamToken: "token-first",
      },
      {
        id: "cac_second",
        connection: CONNECTION,
        subject: OTHER_SUBJECT,
        scopes: ["openid"],
        loginHint: shared,
        upstreamToken: "token-second",
      },
    ],
  });
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });

  const first = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: REFRESH_TOKEN_TYPE,
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const second = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(OTHER_SUBJECT),
        tokenType: REFRESH_TOKEN_TYPE,
        subject: OTHER_SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(OTHER_SUBJECT)),
    }),
  });
  const firstConnection = connectionRecord(binding, {
    connectionRef: "connection:auth0-first",
    externalIds: {
      connectedAccountId: "cac_first",
      auth0Connection: CONNECTION,
      auth0Subject: SUBJECT,
    },
  });
  const secondConnection = connectionRecord(binding, {
    connectionRef: "connection:auth0-second",
    ownerId: "subject-2",
    externalIds: {
      connectedAccountId: "cac_second",
      auth0Connection: CONNECTION,
      auth0Subject: OTHER_SUBJECT,
    },
  });

  const one = await first.verify!(app.context({ connection: firstConnection }));
  const two = await second.verify!(
    app.context({ connection: secondConnection }),
  );
  assert.equal(one.state, "complete");
  assert.equal(two.state, "complete");
  // Same display identity upstream, two subjects, two connected accounts.
  assert.equal(one.target?.id, "cac_first");
  assert.equal(two.target?.id, "cac_second");
  assert.notEqual(
    one.externalIds?.auth0Subject,
    two.externalIds?.auth0Subject,
  );

  // Presenting the second person's token against the first connection is
  // refused: an email in common is not an identity in common.
  const crossed = await second.verify!(
    app.context({ connection: firstConnection }),
  );
  assert.equal(crossed.state, "denied");
  assert.equal(crossed.code, "auth0.subject-changed");
  await auth0.close();
});

test("Auth0 provider fixtures stay in their own directory", async () => {
  for (const name of [
    "exchange-success.json",
    "exchange-errors.json",
    "connected-accounts.json",
  ]) {
    const recorded = fixture(name);
    assert.match(String(recorded._source), /auth0\.com\/docs/);
    assert.match(String(recorded._source), /retrieved 2026-09-18/);
  }
});
