import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createAuth0TokenVaultAdapter } from "../../../src/server/connectors/providers/auth0/index.js";
import type { AuthorizationIntent } from "../../../src/server/connectors/adapter.js";
import { startAuth0TokenVaultDouble } from "../doubles/auth0-token-vault.js";
import { fixtureActor } from "../doubles/ports.js";
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
 * IB-03: linked-account inventory and selection through the documented
 * Connected Accounts flow of the My Account API.
 */

const intent = (
  overrides: Partial<AuthorizationIntent> = {},
): AuthorizationIntent => ({
  ownerKind: "user",
  requestedPermissions: [],
  accountSwitch: false,
  interruption: "allowed",
  ...overrides,
});

async function tenant(
  options: Parameters<typeof startAuth0TokenVaultDouble>[0] = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  },
) {
  return startAuth0TokenVaultDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...options,
  });
}

test("Auth0 linking runs the documented connect flow and keeps the ticket private", async () => {
  const auth0 = await tenant({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    connections: [{ name: CONNECTION, strategy: "google-oauth2" }],
  });
  const refresh = auth0.refreshToken(SUBJECT);
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: refresh,
        tokenType: "urn:ietf:params:oauth:token-type:refresh_token",
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  const start = await adapter.authorize!(app.context(), intent());
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") throw new Error("unreachable");

  const [connect] = auth0.received("POST", "/me/v1/connected-accounts/connect");
  assert.ok(connect);
  const body = JSON.parse(connect.body.toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(body.connection, CONNECTION);
  assert.deepEqual(body.scopes, ["openid", "profile", "offline_access"]);
  assert.equal(
    body.redirect_uri,
    "https://app.example/api/v1/connectors/auth0/return",
  );
  assert.equal(body.state, start.handoff.correlationKey);

  // The connect URI and the session identifier are protected transient
  // material; the ticket travels only inside the private handoff.
  const url = new URL(String(start.handoff.private.url));
  assert.equal(url.origin, auth0.origin);
  assert.ok(url.searchParams.get("ticket"));
  assert.ok(start.handoff.private.authSession);
  assert.equal(start.handoff.intent, "auth0.connected-account.link");

  // Completing it presents the single-use code back to the My Account API.
  const connection = connectionRecord(binding);
  const issued = await app.ports.handoffs.issue({
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: binding.bindingRef,
    generation: connection.generation,
    kind: start.handoff.kind,
    presentation: start.handoff.presentation,
    expiresAt: start.handoff.expiresAt,
    intent: start.handoff.intent,
    correlationKey: start.handoff.correlationKey!,
    private: start.handoff.private,
  });
  const record = app.ports
    .inspect.handoffs()
    .find((item) => item.handoffRef === issued.handoffRef)!;
  const code = auth0.issueConnectCode(SUBJECT);
  const completion = await adapter.complete!(
    app.context({ connection, handoff: record }),
    {
      kind: "redirect",
      url: new URL(
        `https://app.example/api/v1/connectors/auth0/return?state=${encodeURIComponent(
          start.handoff.correlationKey!,
        )}&connect_code=${code}`,
      ),
    },
  );
  assert.equal(completion.state, "complete");
  assert.equal(completion.externalIds?.auth0Connection, CONNECTION);
  assert.equal(completion.externalIds?.auth0Subject, SUBJECT);
  assert.equal(completion.target?.kind, "connected-account");
  assert.match(String(completion.externalIds?.connectedAccountId), /^cac_/);
  assert.equal(completion.claims[0]!.issuer, "external-broker");

  // A replayed callback is the earlier outcome, never a second link.
  const replay = await adapter.complete!(
    app.context({ connection, handoff: record }),
    {
      kind: "redirect",
      url: new URL(
        `https://app.example/api/v1/connectors/auth0/return?state=${encodeURIComponent(
          start.handoff.correlationKey!,
        )}&connect_code=${code}`,
      ),
    },
  );
  assert.equal(replay.code, "auth0.callback.replayed");
  assert.equal(
    auth0.received("POST", "/me/v1/connected-accounts/complete").length,
    1,
  );
  await auth0.close();
});

test("Auth0 linking refuses a callback with the wrong state or an older generation", async () => {
  const auth0 = await tenant();
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: "urn:ietf:params:oauth:token-type:refresh_token",
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  const connection = connectionRecord(binding);
  const issued = await app.ports.handoffs.issue({
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: binding.bindingRef,
    generation: connection.generation,
    kind: "provider-browser",
    presentation: "popup",
    expiresAt: Date.now() + 300_000,
    intent: "auth0.connected-account.link",
    correlationKey: "auth0:state-1",
    private: {
      url: `${auth0.origin}/connected-accounts/connect`,
      authSession: "session-1",
      redirectUri: "https://app.example/api/v1/connectors/auth0/return",
      connection: CONNECTION,
      accountSwitch: "false",
    },
  });
  const record = app.ports
    .inspect.handoffs()
    .find((item) => item.handoffRef === issued.handoffRef)!;
  const wrongState = await adapter.complete!(
    app.context({ connection, handoff: record }),
    {
      kind: "redirect",
      url: new URL(
        "https://app.example/api/v1/connectors/auth0/return?state=auth0:other&connect_code=x",
      ),
    },
  );
  assert.deepEqual(wrongState, {
    state: "denied",
    claims: [],
    code: "auth0.callback.correlation",
  });
  const stale = await adapter.complete!(
    app.context({ connection, handoff: record, generation: 9 }),
    {
      kind: "redirect",
      url: new URL(
        "https://app.example/api/v1/connectors/auth0/return?state=auth0:state-1&connect_code=x",
      ),
    },
  );
  assert.deepEqual(stale, {
    state: "denied",
    claims: [],
    code: "auth0.callback.stale",
  });
  assert.equal(
    auth0.received("POST", "/me/v1/connected-accounts/complete").length,
    0,
  );
  await auth0.close();
});

test("Auth0 account selection is explicit and checked against the host-approved targets", async () => {
  const auth0 = await tenant({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [
      {
        id: "cac_work",
        connection: CONNECTION,
        subject: SUBJECT,
        scopes: ["openid"],
        loginHint: "person@work.example",
      },
      {
        id: "cac_personal",
        connection: CONNECTION,
        subject: SUBJECT,
        scopes: ["openid"],
        loginHint: "person@home.example",
      },
    ],
  });
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: "urn:ietf:params:oauth:token-type:refresh_token",
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin, {
    permittedTargets: [{ kind: "connected-account", id: "cac_work" }],
  });
  const app = harness({ binding, domain: auth0.domain });

  const chosen = await adapter.authorize!(
    app.context(),
    intent({ target: { kind: "connected-account", id: "cac_work" } }),
  );
  assert.deepEqual(chosen, { kind: "verify" });

  // The other account exists upstream, but this binding does not permit it;
  // a heuristic must never reach for the wider one.
  await assert.rejects(
    adapter.authorize!(
      app.context(),
      intent({ target: { kind: "connected-account", id: "cac_personal" } }),
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "auth0.account.not-permitted",
  );

  // A permitted target that does not exist upstream is not found, not assumed.
  const phantom = tokenVaultBinding(auth0.origin, {
    permittedTargets: [{ kind: "connected-account", id: "cac_missing" }],
  });
  await assert.rejects(
    adapter.authorize!(
      app.context({ binding: phantom }),
      intent({ target: { kind: "connected-account", id: "cac_missing" } }),
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "not-found",
  );
  await auth0.close();
});

test("Auth0 verification requires an explicit choice when several accounts are linked", async () => {
  const auth0 = await tenant({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accounts: [
      { id: "cac_a", connection: CONNECTION, subject: SUBJECT, scopes: ["openid"] },
      { id: "cac_b", connection: CONNECTION, subject: SUBJECT, scopes: ["openid"] },
    ],
  });
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: "urn:ietf:params:oauth:token-type:refresh_token",
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  const ambiguous = await adapter.verify!(
    app.context({ connection: connectionRecord(binding) }),
  );
  assert.equal(ambiguous.state, "human-required");
  assert.equal(ambiguous.code, "auth0.account.selection-required");

  const selected = await adapter.verify!(
    app.context({
      connection: connectionRecord(binding, {
        externalIds: { connectedAccountId: "cac_b", auth0Subject: SUBJECT },
      }),
    }),
  );
  assert.equal(selected.state, "complete");
  assert.equal(selected.target?.id, "cac_b");
  await auth0.close();
});

test("Auth0 inventory lists only this subject's accounts on the bound connection", async () => {
  const auth0 = await tenant({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    connections: [
      { name: CONNECTION, strategy: "google-oauth2" },
      { name: "slack", strategy: "oauth2" },
    ],
    accounts: [
      { id: "cac_mine", connection: CONNECTION, subject: SUBJECT, scopes: ["openid"] },
      { id: "cac_slack", connection: "slack", subject: SUBJECT, scopes: [] },
      {
        id: "cac_theirs",
        connection: CONNECTION,
        subject: OTHER_SUBJECT,
        scopes: ["openid"],
      },
    ],
  });
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: "urn:ietf:params:oauth:token-type:refresh_token",
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
      operationRef: "operation:auth0.accounts",
      input: {},
      commandId: "command:list",
    },
  );
  assert.equal(result.state, "complete");
  const output = result.output as {
    accounts: Array<{ id: string; connection: string }>;
    selected: string | null;
  };
  assert.deepEqual(
    output.accounts.map((account) => account.id),
    ["cac_mine"],
  );
  assert.equal(output.selected, null);
  assert.equal(result.outputClassification, "personal");

  // Discovery reports every connection the tenant offers, with which ones
  // this person has already linked.
  const discovered = await adapter.discover!(
    app.context({ connection: connectionRecord(binding) }),
    {},
  );
  assert.deepEqual(
    discovered.items.map((item) => [
      item.identity.nativeId,
      item.provenance?.linked,
    ]),
    [
      [CONNECTION, "true"],
      ["slack", "true"],
    ],
  );
  assert.equal(discovered.items[0]!.identity.authorityNamespace, auth0.issuer());
  await auth0.close();
});

test("Auth0 refuses to act without a My Account token rather than working around it", async () => {
  const auth0 = await tenant();
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: "urn:ietf:params:oauth:token-type:refresh_token",
        subject: SUBJECT,
      }),
    }),
  });
  const binding = tokenVaultBinding(auth0.origin);
  const app = harness({ binding, domain: auth0.domain });
  await assert.rejects(
    adapter.authorize!(app.context(), intent()),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "auth0.my-account.unavailable",
  );
  assert.equal(auth0.requests.length, 0);
  await auth0.close();
});

test("Auth0 pins the tenant destination to configuration, not to the binding", async () => {
  const auth0 = await tenant();
  const other = await tenant();
  const adapter = createAuth0TokenVaultAdapter({
    identity: identityPort({
      subject: subjectToken({
        value: auth0.refreshToken(SUBJECT),
        tokenType: "urn:ietf:params:oauth:token-type:refresh_token",
        subject: SUBJECT,
      }),
      myAccount: heldToken(await auth0.myAccountToken(SUBJECT)),
    }),
  });
  // The binding points at a second tenant while configuration names the first:
  // the exchange never starts.
  const binding = tokenVaultBinding(other.origin);
  const app = harness({ binding, domain: auth0.domain });
  await assert.rejects(
    adapter.verify!(app.context({ connection: connectionRecord(binding) })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "auth0.destination.mismatch",
  );
  assert.equal(auth0.requests.length, 0);
  assert.equal(other.requests.length, 0);
  await auth0.close();
  await other.close();
});
