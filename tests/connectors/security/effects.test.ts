import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import {
  beginAuthorizationCode,
  completeAuthorizationCode,
  issueHandoff,
  refreshAccessToken,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  expandPathTemplate,
  rejectOverrideAttempt,
} from "../../../src/server/connectors/providers/nango/invoke.js";
import type { HandoffRecord } from "../../../src/server/connectors/index.js";
import { authHarness, type AuthHarness } from "../auth/harness.js";
import {
  activeConnection,
  harness as nangoHarness,
  makeConnection,
  readOperation,
  writeOperation,
  CONNECTION_ID,
  INTEGRATION,
  SIGNING_KEY,
} from "../nango/harness.js";
import { signNangoWebhook } from "../doubles/nango.js";

/*
 * SEC-04. Effect and credential attacks: a replayed authorization code, a
 * stale callback, a refresh race, a cancelled handoff that still comes back
 * with tokens, a custody switch, proxy URL and header injection, a duplicate
 * broker delivery and a mutation whose response was lost. Every case runs
 * against the real modules and the real loopback doubles.
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

async function authorized(
  t: TestContext,
  options: Parameters<typeof authHarness>[1] = {},
): Promise<{
  harness: AuthHarness;
  ctx: ReturnType<AuthHarness["ctx"]>;
  record: HandoffRecord;
  callback: URL;
}> {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    ...options,
  });
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
    .find((item) => item.handoffRef === issued.handoffRef) as HandoffRecord;
  const callback = new URL(
    await harness.server.authorize(start.handoff.private["authorizationUrl"]!),
  );
  return { harness, ctx, record, callback };
}

test("an authorization code is spent once even when the issuer would accept it twice", async (t) => {
  const { harness, ctx, record, callback } = await authorized(t, {
    server: { misbehave: { reusableCode: true } },
  });
  const first = await completeAuthorizationCode(ctx, {
    url: callback,
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(first.state, "complete");
  const tokenCalls = harness.server.counts.token;
  const current = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === record.handoffRef) as HandoffRecord;
  const replay = await refused(() =>
    completeAuthorizationCode(ctx, {
      url: callback,
      handoff: current,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
  );
  assert.equal(replay.code, "conflict");
  assert.equal(
    harness.server.counts.token,
    tokenCalls,
    "the replay must not reach the token endpoint again",
  );
  assert.equal(harness.ports.inspect.credentialRefs().length, 1);

  // Presenting the same code under a freshly issued handoff is caught too:
  // the journal digest covers issuer, client, redirect URI and the code.
  const second = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["openid"],
  });
  if (second.kind !== "handoff") throw new Error("unreachable");
  const reissued = await issueHandoff(ctx, second.handoff);
  const fresh = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === reissued.handoffRef) as HandoffRecord;
  const smuggled = new URL(callback.href);
  smuggled.searchParams.set("state", second.handoff.private["state"]!);
  const again = await refused(() =>
    completeAuthorizationCode(ctx, {
      url: smuggled,
      handoff: fresh,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
  );
  assert.ok(again.detail?.startsWith("oauth.code.duplicate"), again.detail);
  assert.equal(harness.server.counts.token, tokenCalls);
  assert.equal(harness.ports.inspect.credentialRefs().length, 1);
});

test("a callback for an older generation, or a cancelled handoff, stores nothing", async (t) => {
  const stale = await authorized(t);
  const moved = stale.harness.ctx({
    connection: { ...stale.harness.connection, generation: 1 },
    generation: 1,
  });
  const generation = await refused(() =>
    completeAuthorizationCode(moved, {
      url: stale.callback,
      handoff: stale.record,
      server: stale.harness.resolved,
      client: stale.harness.client,
      policy: stale.harness.policy,
    }),
  );
  assert.equal(generation.code, "conflict");
  assert.equal(generation.detail, "oauth.handoff.stale-generation");
  assert.deepEqual(stale.harness.ports.inspect.credentialRefs(), []);

  const cancelledFlow = await authorized(t);
  await cancelledFlow.harness.ports.handoffs.cancelAll(
    cancelledFlow.record.connectionRef,
    "unlinked",
  );
  const cancelled = cancelledFlow.harness.ports.inspect
    .handoffs()
    .find(
      (item) => item.handoffRef === cancelledFlow.record.handoffRef,
    ) as HandoffRecord;
  const error = await refused(() =>
    completeAuthorizationCode(cancelledFlow.ctx, {
      url: cancelledFlow.callback,
      handoff: cancelled,
      server: cancelledFlow.harness.resolved,
      client: cancelledFlow.harness.client,
      policy: cancelledFlow.harness.policy,
    }),
  );
  assert.equal(error.code, "cancelled");
  assert.deepEqual(cancelledFlow.harness.ports.inspect.credentialRefs(), []);
});

test("a handoff cannot be completed by another tenant's actor", async (t) => {
  const { harness, record, callback } = await authorized(t);
  const intruder: ActorContext = {
    tenantId: "tenant-b",
    subjectId: "subject-1",
    sessionId: "session-1",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const error = await refused(() =>
    completeAuthorizationCode(harness.ctx({ actor: intruder }), {
      url: callback,
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
  );
  assert.equal(error.code, "denied");
  assert.equal(error.detail, "oauth.handoff.foreign");
  assert.deepEqual(harness.ports.inspect.credentialRefs(), []);
});

test("concurrent refreshes make one upstream request, and custody is not transferable", async (t) => {
  const { harness, ctx, record, callback } = await authorized(t, {
    server: { scopes: ["openid", "offline_access"] },
  });
  const completed = await completeAuthorizationCode(ctx, {
    url: callback,
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(completed.state, "complete");
  const credentialRef = completed.credentialRef!;
  const scope = {
    tenantId: harness.connection.tenantId,
    ownerKind: "user" as const,
    ownerId: harness.connection.ownerId,
    connectionRef: harness.connection.connectionRef,
    bindingRef: harness.connection.bindingRef,
    custody: "host-owned" as const,
  };
  const before = harness.server.counts.token;
  const results = await Promise.all(
    [0, 1, 2].map(() =>
      refreshAccessToken(ctx, {
        server: harness.resolved,
        client: harness.client,
        policy: harness.policy,
        credentialRef,
        scope,
      }),
    ),
  );
  assert.equal(
    harness.server.counts.token - before,
    1,
    "single-flight: one refresh reached the issuer",
  );
  assert.equal(
    results.filter((outcome) => outcome.shared).length,
    2,
    "two callers joined the in-flight refresh instead of starting their own",
  );

  // Custody is scoped: another connection, another owner, another tenant and
  // another custody mode are four different scopes, and none of them can
  // read or refresh this credential.
  for (const foreign of [
    { ...scope, connectionRef: "connection:other" },
    { ...scope, ownerId: "subject-2" },
    { ...scope, tenantId: "tenant-b" },
    { ...scope, bindingRef: "binding:other" },
    { ...scope, custody: "external-credential-broker" as const },
  ])
    await assert.rejects(
      () =>
        harness.ports.credentials.use(foreign, credentialRef, async () => {
          throw new Error("the callback must never run");
        }),
      JSON.stringify(foreign),
    );
  // `describe` is the only cross-check a caller gets, and it is scoped too.
  assert.equal(
    await harness.ports.credentials.describe(
      { ...scope, tenantId: "tenant-b" },
      credentialRef,
    ),
    undefined,
  );
});

test("a proxy call cannot carry a caller's URL, header, connection or operation", async (t) => {
  const harness = await nangoHarness({
    binding: { contracts: { [readOperation.operationRef]: {} } },
  });
  t.after(() => harness.close());
  const connection = await activeConnection(harness.ports, harness.binding);
  const ctx = harness.context({ connection });
  for (const input of [
    { baseUrlOverride: "https://evil.example" },
    { "Base-Url-Override": "https://evil.example" },
    { headers: { authorization: "Bearer stolen" } },
    { connectionId: "conn-2" },
    { provider_config_key: "github-sandbox" },
    { retries: 5 },
    { query: { url: "https://evil.example" } },
    { path: { authorization: "x" } },
    { credentials: { access_token: "x" } },
  ])
    assert.throws(
      () => rejectOverrideAttempt(input),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "nango.input.override-rejected",
      JSON.stringify(input),
    );
  // An unapproved operation is denied before any credential is touched, and
  // the broker double records no request at all.
  const before = harness.double.requests.length;
  const unapproved = await refused(() =>
    harness.adapter.invoke!(ctx, {
      operationRef: "github.admin.delete-org",
      input: {},
      commandId: "cmd:1",
    }),
  );
  assert.equal(unapproved.code, "denied");
  assert.equal(unapproved.detail, "nango.operation.unapproved");
  assert.equal(harness.double.requests.length, before);
  // The path template can only produce a proxy path, and a parameter value
  // cannot add a segment or climb out of it.
  assert.equal(
    expandPathTemplate("/proxy/repos/{owner}/{repo}/issues", {
      owner: "a/../../admin",
      repo: "r",
    }),
    "/proxy/repos/a%2F..%2F..%2Fadmin/r/issues",
  );
  assert.throws(
    () => expandPathTemplate("/admin/{x}", { x: "1" }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.operation.path",
  );
  assert.throws(
    () => expandPathTemplate("/proxy/{x}", { x: "1", extra: "2" }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.input.path.unknown",
  );
});

test("a mutation whose response was lost is indeterminate, never retried blindly", async (t) => {
  let attempts = 0;
  const harness = await nangoHarness({
    binding: {
      operations: [readOperation, writeOperation],
      contracts: {
        [writeOperation.operationRef]: {
          path: {
            owner: { type: "string", required: true },
            repo: { type: "string", required: true },
          },
          body: { type: "object", properties: { title: { type: "string" } } },
        },
      },
    },
    double: {
      proxy: () => {
        attempts++;
        // The gateway accepted the request and then the answer was lost.
        return { status: 502, body: { error: "bad gateway" } };
      },
    },
  });
  t.after(() => harness.close());
  const connection = await activeConnection(harness.ports, harness.binding);
  const ctx = harness.context({ connection });
  const request = {
    operationRef: writeOperation.operationRef,
    input: { path: { owner: "octocat", repo: "hello" }, body: { title: "x" } },
    commandId: "cmd:lost",
  };
  const first = await harness.adapter.invoke!(ctx, request);
  assert.equal(first.state, "indeterminate");
  assert.equal(attempts, 1);
  const second = await harness.adapter.invoke!(ctx, request);
  assert.equal(second.state, "indeterminate");
  assert.equal(
    attempts,
    1,
    "an uncertain write is never re-sent without replay evidence",
  );
  assert.equal(second.code, "nango.effect.indeterminate");
});

test("a duplicate, misattributed or unverified broker delivery changes nothing", async (t) => {
  const harness = await nangoHarness();
  t.after(() => harness.close());
  const connection = await activeConnection(harness.ports, harness.binding);
  const ctx = harness.context({ connection });
  const payload = {
    type: "auth",
    operation: "refresh",
    connectionId: CONNECTION_ID,
    providerConfigKey: INTEGRATION,
    environment: "dev",
    success: true,
  };
  const raw = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(raw);
  const verified = await harness.adapter.events!.verify(ctx, {
    headers: new Headers({
      "content-type": "application/json",
      "x-nango-hmac-sha256": signNangoWebhook(SIGNING_KEY, raw),
    }),
    body: bytes,
    receivedAt: Date.now(),
  });
  assert.ok(verified, "a correctly signed delivery verifies");
  const first = await harness.adapter.reconcileEvent(ctx, verified);
  assert.equal(first.duplicate, false);
  const second = await harness.adapter.reconcileEvent(ctx, verified);
  assert.equal(second.duplicate, true);
  assert.equal(second.code, "nango.event.duplicate");
  assert.equal(second.lifecycle, undefined, "a duplicate changes no state");
  // An event attributed to another authority instance cannot reconcile this
  // connection: one environment's delivery is not another's.
  const foreign = await harness.adapter.reconcileEvent(ctx, {
    ...verified,
    authority: "nango:other:https://api.nango.dev",
    eventId: `${verified.eventId}-other`,
  });
  assert.equal(foreign.code, "nango.event.authority");
  assert.equal(foreign.lifecycle, undefined);
  // Only the vendor signature this adapter itself checked is evidence: a
  // delivery labelled with another verification method is not reconciled.
  const unverified = await harness.adapter.reconcileEvent(ctx, {
    ...verified,
    eventId: `${verified.eventId}-unverified`,
    verification: { method: "forwarder-signature" },
  });
  assert.equal(unverified.code, "nango.event.unverified");
  assert.equal(unverified.lifecycle, undefined);
  // The signature covers the exact bytes and the exact key.
  const edited = new TextEncoder().encode(
    JSON.stringify({ ...payload, connectionId: "conn-9" }),
  );
  assert.equal(
    await harness.adapter.events!.verify(ctx, {
      headers: new Headers({
        "x-nango-hmac-sha256": signNangoWebhook(SIGNING_KEY, raw),
      }),
      body: edited,
      receivedAt: Date.now(),
    }),
    undefined,
  );
  assert.equal(
    await harness.adapter.events!.verify(ctx, {
      headers: new Headers({
        "x-nango-hmac-sha256": createHmac("sha256", "not-the-signing-key")
          .update(bytes)
          .digest("hex"),
      }),
      body: bytes,
      receivedAt: Date.now(),
    }),
    undefined,
  );
  // A delivery that names a connection in another integration is refused
  // rather than applied to whatever connection the context happens to hold.
  const otherIntegration = JSON.stringify({
    ...payload,
    providerConfigKey: "github-sandbox",
  });
  const crossed = await harness.adapter.events!.verify(ctx, {
    headers: new Headers({
      "x-nango-hmac-sha256": signNangoWebhook(SIGNING_KEY, otherIntegration),
    }),
    body: new TextEncoder().encode(otherIntegration),
    receivedAt: Date.now(),
  });
  assert.ok(crossed);
  const mismatch = await harness.adapter.reconcileEvent(
    harness.context({ connection: makeConnection(harness.binding) }),
    crossed,
  );
  assert.notEqual(mismatch.lifecycle, "active");
});
