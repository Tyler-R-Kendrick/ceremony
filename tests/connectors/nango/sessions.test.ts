import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentConnectorProjection,
  humanConnectionProjection,
  publicCatalogProjection,
} from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { TAG_KEYS } from "../../../src/server/connectors/providers/nango/index.js";
import {
  activeConnection,
  CONNECTION_ID,
  connectionRow,
  ENVIRONMENT,
  harness,
  INTEGRATION,
  makeConnection,
  PROVIDER,
  readOperation,
  stringsIn,
} from "./harness.js";
import { fixtureActor } from "../doubles/ports.js";

/*
 * NG-02: connect and reconnect sessions, AC-NG-01 (restricted integration
 * list, host-derived tags, private token), AC-NG-02 (webhook_url_override is
 * default-deny) and AC-NG-05 (replayed or wrong-account callbacks refused by
 * correlation plus authoritative verification). AC-AUTH-08 lives here too: a
 * broker "success" with no account evidence is not exact-account verification.
 */

const intent = {
  ownerKind: "user" as const,
  requestedPermissions: ["repo"],
  accountSwitch: false,
  interruption: "allowed" as const,
};

test("AC-NG-01: a connect session restricts allowed_integrations and derives tags from the actor", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), intent);

  assert.equal(start.kind, "handoff");
  assert.equal(start.handoff.kind, "connect-widget");
  assert.equal(start.handoff.presentation, "popup");

  const session = h.double.sessions[0];
  assert.ok(session);
  assert.equal(session.kind, "connect");
  // Only the one integration the binding names may be authorized.
  assert.deepEqual(session.allowedIntegrations, [INTEGRATION]);
  // The deprecated end_user / organization inputs are not sent at all.
  assert.equal(session.body.end_user, undefined);
  assert.equal(session.body.organization, undefined);
  assert.ok(session.tags);
  // Tags are digests of host-derived identity, never the raw subject id.
  assert.match(session.tags[TAG_KEYS.endUser]!, /^[a-f0-9]{64}$/);
  assert.equal(session.tags[TAG_KEYS.endUser]!.includes(fixtureActor.subjectId), false);
  assert.equal(session.tags[TAG_KEYS.connection], connection.connectionRef);
  assert.equal(session.tags[TAG_KEYS.generation], "0");
  assert.match(session.tags[TAG_KEYS.handoff]!, /^[A-Za-z0-9_-]{20,}$/);
});

test("AC-NG-01: the session token, link and expiry stay in private handoff material", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), intent);
  assert.equal(start.kind, "handoff");

  const token = h.double.sessions[0]!.token;
  assert.equal(start.handoff.private.token, token);
  assert.ok(start.handoff.private.connectLink);
  assert.ok(start.handoff.expiresAt > Date.now());
  // The documented 30-minute ceiling bounds a longer upstream expiry.
  assert.ok(start.handoff.expiresAt <= Date.now() + 30 * 60_000 + 1000);

  const { private: _private, ...publicPart } = start.handoff;
  assert.equal(
    stringsIn(publicPart).some((value) => value.includes(token)),
    false,
    "the token never appears outside private material",
  );

  // Neither projection of a connection carrying this handoff can disclose it.
  const summary = {
    ...connection,
    handoff: {
      handoffRef: "handoff:1",
      kind: "connect-widget" as const,
      state: "issued" as const,
      presentation: "popup" as const,
      expiresAt: new Date(start.handoff.expiresAt).toISOString(),
      generation: 0,
    },
  };
  for (const projected of [
    humanConnectionProjection(summary),
    agentConnectorProjection(summary),
  ])
    assert.equal(
      stringsIn(projected).some((value) => value.includes(token)),
      false,
    );
});

test("AC-NG-02: webhook_url_override is default-deny and cannot come from input", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  await h.adapter.authorize!(h.context({ connection }), {
    ...intent,
    // A model- or browser-shaped attempt to add policy fields is refused by
    // the strict intent schema before any request is made.
  });
  assert.equal(h.double.sessions[0]!.webhookUrlOverride, undefined);
  assert.equal("webhook_url_override" in h.double.sessions[0]!.body, false);

  await assert.rejects(
    h.adapter.authorize!(h.context({ connection }), {
      ...intent,
      webhookUrlOverride: "https://attacker.example/hook",
    } as never),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.intent.invalid",
  );
  assert.equal(h.double.sessions.length, 1, "the rejected attempt sent nothing");
});

test("AC-NG-02: only an administrator-approved destination in binding settings sets the override", async (t) => {
  const h = await harness({
    binding: {
      webhookUrlOverride: {
        url: "https://hooks.example.test/nango",
        approvedBy: "security-admin",
        approvedAt: "2026-03-01T00:00:00.000Z",
      },
    },
  });
  t.after(() => h.close());
  await h.adapter.authorize!(h.context({ connection: makeConnection(h.binding) }), intent);
  assert.equal(
    h.double.sessions[0]!.webhookUrlOverride,
    "https://hooks.example.test/nango",
  );
});

test("NG-02: an interruption-free policy yields human-required, never a silent fallback", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const start = await h.adapter.authorize!(
    h.context({ connection: makeConnection(h.binding) }),
    { ...intent, interruption: "none" },
  );
  assert.equal(start.kind, "human-required");
  assert.equal(h.double.sessions.length, 0);
});

test("NG-02: missing configuration reports the exact names before any request", async (t) => {
  const h = await harness({ configuration: { NANGO_SECRET_KEY: undefined } });
  t.after(() => h.close());
  const start = await h.adapter.authorize!(
    h.context({ connection: makeConnection(h.binding) }),
    intent,
  );
  assert.equal(start.kind, "configuration-required");
  assert.deepEqual(start.missing, ["NANGO_SECRET_KEY"]);
  assert.equal(h.double.requests.length, 0);
});

test("NG-02: a widget callback alone never completes; a verified creation event does", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), intent);
  assert.equal(start.kind, "handoff");
  const nonce = start.handoff.private.nonce!;
  const issued = await h.ports.handoffs.issue({
    ...start.handoff,
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: h.binding.bindingRef,
    generation: 0,
  });
  const withHandoff = { ...connection, handoff: issued.summary };

  // A redirect is not evidence of anything.
  const redirected = await h.adapter.complete!(h.context({ connection: withHandoff }), {
    kind: "redirect",
    url: new URL("https://app.example/callback?connectionId=conn-1"),
  });
  assert.equal(redirected.state, "pending");
  assert.equal(redirected.code, "nango.complete.redirect-not-evidence");

  // Polling before Nango has the connection stays pending.
  const early = await h.adapter.complete!(h.context({ connection: withHandoff }), {
    kind: "poll",
  });
  assert.equal(early.state, "pending");

  // The Connect UI finishes: Nango now holds a connection carrying our tags.
  h.double.addConnection(
    connectionRow({
      tags: {
        [TAG_KEYS.handoff]: nonce,
        [TAG_KEYS.connection]: connection.connectionRef,
        [TAG_KEYS.generation]: "0",
        [TAG_KEYS.tenant]: h.double.sessions[0]!.tags![TAG_KEYS.tenant]!,
      },
    }),
  );
  const completed = await h.adapter.complete!(h.context({ connection: withHandoff }), {
    kind: "poll",
  });
  assert.equal(completed.state, "complete");
  assert.equal(completed.externalIds?.connectionId, CONNECTION_ID);
  assert.equal(completed.externalIds?.providerConfigKey, INTEGRATION);
  assert.equal(completed.externalIds?.environment, ENVIRONMENT);
  assert.ok(completed.credentialRef);

  // The stored material is a broker reference, not a credential.
  const material = h.ports.inspect.credentialMaterial(completed.credentialRef!);
  assert.deepEqual(Object.keys(material!).sort(), [
    "authority",
    "connectionId",
    "environment",
    "providerConfigKey",
  ]);
});

test("AC-AUTH-08: broker success without account evidence is not exact-account verification", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), intent);
  assert.equal(start.kind, "handoff");
  const nonce = start.handoff.private.nonce!;
  const issued = await h.ports.handoffs.issue({
    ...start.handoff,
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: h.binding.bindingRef,
    generation: 0,
  });
  h.double.addConnection(
    connectionRow({
      tags: {
        [TAG_KEYS.handoff]: nonce,
        [TAG_KEYS.connection]: connection.connectionRef,
        [TAG_KEYS.generation]: "0",
        [TAG_KEYS.tenant]: h.double.sessions[0]!.tags![TAG_KEYS.tenant]!,
      },
    }),
  );
  const result = await h.adapter.complete!(
    h.context({ connection: { ...connection, handoff: issued.summary } }),
    { kind: "poll" },
  );

  assert.equal(result.state, "complete");
  // The only claim is that the broker holds a connection: no account identity.
  assert.deepEqual(result.claims.map((claim) => claim.kind), ["credential-accepted"]);
  assert.equal(result.claims[0]!.issuer, "external-broker");
  assert.equal(result.claims[0]!.target.kind, "nango-connection");
  assert.ok(
    result.claims[0]!.limitations.some((text) =>
      text.includes("does not report the provider account identity"),
    ),
  );
  // Requested permissions are recorded as requested, never as granted.
  assert.deepEqual(result.claims[0]!.permissions?.requested, ["repo"]);
  assert.deepEqual(result.claims[0]!.permissions?.reported, []);
  assert.deepEqual(result.claims[0]!.permissions?.observed, []);
  assert.equal(result.claims[0]!.permissions?.semantics, "unknown");
  assert.equal(result.target?.kind, "nango-connection");
});

test("AC-AUTH-08: an exact-account intent is denied when no account evidence exists", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), {
    ...intent,
    target: { kind: "github-account", id: "octocat" },
  });
  assert.equal(start.kind, "handoff");
  const nonce = start.handoff.private.nonce!;
  const issued = await h.ports.handoffs.issue({
    ...start.handoff,
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: h.binding.bindingRef,
    generation: 0,
  });
  h.double.addConnection(
    connectionRow({
      tags: {
        [TAG_KEYS.handoff]: nonce,
        [TAG_KEYS.connection]: connection.connectionRef,
        [TAG_KEYS.generation]: "0",
        [TAG_KEYS.tenant]: h.double.sessions[0]!.tags![TAG_KEYS.tenant]!,
      },
    }),
  );
  const result = await h.adapter.complete!(
    h.context({ connection: { ...connection, handoff: issued.summary } }),
    { kind: "poll" },
  );
  assert.equal(result.state, "denied");
  assert.equal(result.code, "nango.verify.account-evidence-insufficient");
  assert.equal(h.ports.inspect.credentialRefs().length, 0);
});

test("AC-NG-05: a replayed completion cannot complete the handoff twice", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), intent);
  assert.equal(start.kind, "handoff");
  const nonce = start.handoff.private.nonce!;
  const issued = await h.ports.handoffs.issue({
    ...start.handoff,
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: h.binding.bindingRef,
    generation: 0,
  });
  h.double.addConnection(
    connectionRow({
      tags: {
        [TAG_KEYS.handoff]: nonce,
        [TAG_KEYS.connection]: connection.connectionRef,
        [TAG_KEYS.generation]: "0",
        [TAG_KEYS.tenant]: h.double.sessions[0]!.tags![TAG_KEYS.tenant]!,
      },
    }),
  );
  const withHandoff = { ...connection, handoff: issued.summary };
  const first = await h.adapter.complete!(h.context({ connection: withHandoff }), {
    kind: "poll",
  });
  assert.equal(first.state, "complete");

  const record = h.ports.inspect.handoffs()[0]!;
  assert.equal(record.state, "completed");
  // The one-use handoff is consumed: a replay produces no second credential.
  const before = h.ports.inspect.credentialRefs().length;
  const replay = await h.adapter.complete!(
    h.context({ connection: { ...withHandoff, handoff: { ...issued.summary, state: "completed" } } }),
    { kind: "poll" },
  );
  assert.equal(replay.state, "complete");
  assert.equal(replay.code, "nango.complete.already");
  assert.equal(h.ports.inspect.credentialRefs().length, before);
});

test("AC-NG-05: a completion naming another account's connection is refused by correlation", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), intent);
  assert.equal(start.kind, "handoff");
  const issued = await h.ports.handoffs.issue({
    ...start.handoff,
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: h.binding.bindingRef,
    generation: 0,
  });

  // Somebody else's connection exists in the same integration, tagged for a
  // different local connection. It must not satisfy our handoff.
  h.double.addConnection(
    connectionRow({
      id: 99,
      connection_id: "someone-elses",
      tags: {
        [TAG_KEYS.handoff]: "a-different-nonce",
        [TAG_KEYS.connection]: "conn:nango-local-other",
        [TAG_KEYS.generation]: "0",
      },
    }),
  );
  const result = await h.adapter.complete!(
    h.context({ connection: { ...connection, handoff: issued.summary } }),
    { kind: "poll" },
  );
  assert.equal(result.state, "pending");
  assert.equal(h.ports.inspect.credentialRefs().length, 0);
});

test("AC-NG-05: an expired session cannot be completed", async (t) => {
  let now = Date.UTC(2026, 2, 1, 12, 0, 0);
  const h = await harness({ now: () => now });
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), intent);
  assert.equal(start.kind, "handoff");
  const nonce = start.handoff.private.nonce!;
  const issued = await h.ports.handoffs.issue({
    ...start.handoff,
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: h.binding.bindingRef,
    generation: 0,
  });
  h.double.addConnection(
    connectionRow({
      tags: {
        [TAG_KEYS.handoff]: nonce,
        [TAG_KEYS.connection]: connection.connectionRef,
        [TAG_KEYS.generation]: "0",
      },
    }),
  );

  now += 31 * 60_000;
  const result = await h.adapter.complete!(
    h.context({ connection: { ...connection, handoff: issued.summary } }),
    { kind: "poll" },
  );
  assert.equal(result.state, "expired");
  assert.equal(result.code, "nango.session.expired");
  assert.equal(h.ports.inspect.credentialRefs().length, 0);
});

test("AC-AUTH-01/AC-NG-05: a stale generation cannot complete a newer connection", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), intent);
  assert.equal(start.kind, "handoff");
  const issued = await h.ports.handoffs.issue({
    ...start.handoff,
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: h.binding.bindingRef,
    generation: 0,
  });

  // The connection was reconnected meanwhile: generation 1 is current.
  const newer = { ...connection, generation: 1, handoff: issued.summary };
  const result = await h.adapter.complete!(
    h.context({ connection: newer, generation: 1 }),
    { kind: "poll" },
  );
  assert.equal(result.state, "expired");
  assert.equal(result.code, "nango.handoff.stale");
});

test("NG-02: reconnect advances through its own correlation and needs a prior auth error to clear", async (t) => {
  const h = await harness({
    double: { connections: [connectionRow({ errors: [{ type: "auth", log_id: "log-1" }] })] },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding, {
    generation: 1,
    lifecycle: "reconnect-required",
  });
  const start = await h.adapter.reconnect!(h.context({ connection, generation: 1 }), intent);
  assert.equal(start.kind, "handoff");
  assert.equal(start.handoff.private.mode, "reconnect");
  assert.equal(start.handoff.private.priorAuthError, "true");
  assert.equal(
    start.handoff.correlationKey,
    `nango-reconnect:${connection.connectionRef}:1`,
  );

  const session = h.double.sessions[0]!;
  assert.equal(session.kind, "reconnect");
  assert.equal(session.body.connection_id, CONNECTION_ID);
  assert.equal(session.body.integration_id, INTEGRATION);

  const issued = await h.ports.handoffs.issue({
    ...start.handoff,
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: h.binding.bindingRef,
    generation: 1,
  });
  const withHandoff = { ...connection, handoff: issued.summary };

  // While the auth error stands, the reconnect is not finished.
  const pending = await h.adapter.complete!(
    h.context({ connection: withHandoff, generation: 1 }),
    { kind: "poll" },
  );
  assert.equal(pending.state, "pending");

  // Nango clears the error once the user re-authorizes.
  h.double.setConnectionErrors(CONNECTION_ID, []);
  const done = await h.adapter.complete!(
    h.context({ connection: withHandoff, generation: 1 }),
    { kind: "poll" },
  );
  assert.equal(done.state, "complete");
  // Reconnect preserves the existing credential reference rather than adding one.
  assert.equal(done.credentialRef, connection.credentialRef);
});

test("NG-02: verify reports the broker's own view and flags auth errors as human-required", async (t) => {
  const h = await harness({ double: { connections: [connectionRow()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ok = await h.adapter.verify!(h.context({ connection }));
  assert.equal(ok.state, "complete");
  assert.equal(ok.externalIds?.connectionId, CONNECTION_ID);

  h.double.setConnectionErrors(CONNECTION_ID, [{ type: "auth", log_id: "log-2" }]);
  const broken = await h.adapter.verify!(h.context({ connection }));
  assert.equal(broken.state, "human-required");
  assert.equal(broken.code, "nango.connection.auth-error");
});

test("NG-02: an approved verification operation supplies real account evidence", async (t) => {
  const h = await harness({
    double: {
      connections: [connectionRow()],
      proxy: ({ path }) =>
        path === "/user" ? { status: 200, body: { login: "octocat", id: 583231 } } : undefined,
    },
    binding: {
      operations: [readOperation],
      verification: {
        operationRef: readOperation.operationRef,
        identityPointer: "/login",
        targetKind: "github-account",
      },
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.verify!(h.context({ connection }));

  assert.equal(result.state, "complete");
  assert.deepEqual(result.claims.map((claim) => claim.kind), [
    "credential-accepted",
    "account-identity",
  ]);
  const account = result.claims[1]!;
  assert.equal(account.issuer, "provider");
  assert.deepEqual(account.target, { kind: "github-account", id: "octocat" });
  assert.deepEqual(result.target, { kind: "github-account", id: "octocat" });
});

test("AC-AUTH-09: a reconnect returning a different account requires explicit account-switch intent", async (t) => {
  const h = await harness({
    double: {
      connections: [connectionRow()],
      proxy: ({ path }) =>
        path === "/user" ? { status: 200, body: { login: "someone-else" } } : undefined,
    },
    binding: {
      operations: [readOperation],
      verification: {
        operationRef: readOperation.operationRef,
        identityPointer: "/login",
        targetKind: "github-account",
      },
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding, {
    target: { kind: "github-account", id: "octocat" },
  });
  const result = await h.adapter.verify!(h.context({ connection }));
  assert.equal(result.state, "denied");
  assert.equal(result.code, "nango.verify.account-switch-required");
});

test("AC-AUTH-01: a foreign binding or tenant is refused before any Nango request", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);

  await assert.rejects(
    h.adapter.authorize!(
      h.context({
        connection,
        actor: { ...fixtureActor, tenantId: "tenant-b" },
      }),
      intent,
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.binding.tenant",
  );

  await assert.rejects(
    h.adapter.authorize!(
      h.context({ connection: { ...connection, bindingRef: "binding:other" } }),
      intent,
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.connection.binding",
  );
  assert.equal(h.double.requests.length, 0);
});

test("NG-02: a workload owner is reported unsupported rather than mapped to a user grant", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding, { ownerKind: "workload" });
  const start = await h.adapter.authorize!(h.context({ connection }), {
    ...intent,
    ownerKind: "workload",
  });
  assert.equal(start.kind, "unsupported");
  assert.equal(h.double.sessions.length, 0);
});

test("NG-02: an organization grant requires the host owner mapping, not a tag", async (t) => {
  const h = await harness({
    adapter: {
      ownerMapping: (actor, ownerKind) =>
        ownerKind === "organization"
          ? { ownerId: "org-42", organizationId: "org-42" }
          : { ownerId: actor.subjectId },
    },
  });
  t.after(() => h.close());
  const connection = makeConnection(h.binding, { ownerKind: "organization" });
  await h.adapter.authorize!(h.context({ connection }), {
    ...intent,
    ownerKind: "organization",
  });
  const tags = h.double.sessions[0]!.tags!;
  assert.match(tags[TAG_KEYS.organization]!, /^[a-f0-9]{64}$/);

  // Without a mapping for that owner kind, the flow is denied outright.
  const plain = await harness();
  t.after(() => plain.close());
  await assert.rejects(
    plain.adapter.authorize!(
      plain.context({ connection: makeConnection(plain.binding, { ownerKind: "organization" }) }),
      { ...intent, ownerKind: "organization" },
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.owner.mapping-required",
  );
});

test("NG-02: the public catalog projection of the adapter carries no private material", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const [entry] = await h.adapter.catalogEntries(
    h.context(),
    new Set(["NANGO_SECRET_KEY", "NANGO_ENVIRONMENT"]),
  );
  const projected = publicCatalogProjection(entry!);
  const strings = stringsIn(projected);
  assert.equal(strings.some((value) => value.includes("nango-secret-key-fixture")), false);
  assert.equal(strings.some((value) => value.includes(h.double.origin)), false);
  assert.equal(projected.ecosystem, "nango");
  assert.deepEqual(projected.custody, [
    "external-credential-broker",
    "external-execution-broker",
  ]);
});

test("NG-02: a connection bound to another integration or environment is refused", async (t) => {
  const h = await harness({ double: { connections: [connectionRow()] } });
  t.after(() => h.close());

  const wrongIntegration = await activeConnection(h.ports, h.binding, {
    externalIds: {
      connectionId: CONNECTION_ID,
      providerConfigKey: "github-sandbox",
      provider: PROVIDER,
      environment: ENVIRONMENT,
    },
  });
  await assert.rejects(
    h.adapter.verify!(h.context({ connection: wrongIntegration })),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.connection.integration",
  );

  const wrongEnvironment = await activeConnection(h.ports, h.binding, {
    externalIds: {
      connectionId: CONNECTION_ID,
      providerConfigKey: INTEGRATION,
      provider: PROVIDER,
      environment: "prod",
    },
  });
  await assert.rejects(
    h.adapter.verify!(h.context({ connection: wrongEnvironment })),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.connection.environment",
  );
});
