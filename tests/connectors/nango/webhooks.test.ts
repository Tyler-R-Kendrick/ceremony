import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  BoundedEventInbox,
  NANGO_CONFIGURATION_NAMES,
  TAG_KEYS,
  verifyNangoSignature,
} from "../../../src/server/connectors/providers/nango/index.js";
import { legacyNangoSignature, signNangoWebhook } from "../doubles/nango.js";
import { fixtureActor } from "../doubles/ports.js";
import {
  activeConnection,
  CONNECTION_ID,
  connectionRow,
  ENVIRONMENT,
  harness,
  INTEGRATION,
  makeConnection,
  PROVIDER,
  SECRET_KEY,
  SIGNING_KEY,
  stringsIn,
} from "./harness.js";

/*
 * NG-06 lifecycle and AC-NG-07: signature verification over raw bytes,
 * mapping auth webhooks to lifecycle, and reconciling duplicate or
 * out-of-order deliveries against Nango's current state rather than trusting
 * the event's own ordering.
 */

const authBody = (overrides: Record<string, unknown> = {}) => ({
  type: "auth",
  operation: "creation",
  connectionId: CONNECTION_ID,
  providerConfigKey: INTEGRATION,
  provider: PROVIDER,
  authMode: "OAUTH2",
  environment: ENVIRONMENT.toUpperCase(),
  success: true,
  tags: {},
  ...overrides,
});

const syncBody = (overrides: Record<string, unknown> = {}) => ({
  type: "sync",
  connectionId: CONNECTION_ID,
  providerConfigKey: INTEGRATION,
  syncName: "github-issues",
  model: "GithubIssue",
  success: true,
  modifiedAfter: "2026-03-02T00:00:00.000Z",
  responseResults: { added: 2, updated: 1, deleted: 0 },
  checkpoints: { from: { page: 1 }, to: { page: 2 } },
  ...overrides,
});

function delivery(
  body: unknown,
  options: { signingKey?: string; header?: string } = {},
) {
  const raw = JSON.stringify(body);
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ "content-type": "application/json" });
  const signature =
    options.header ?? signNangoWebhook(options.signingKey ?? SIGNING_KEY, raw);
  headers.set("x-nango-hmac-sha256", signature);
  return { headers, body: bytes, receivedAt: Date.now(), raw };
}

test("NG-06: the documented HMAC-SHA256 header is verified over the exact bytes", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const body = authBody();
  const verified = await h.adapter.events!.verify(
    h.context({ connection: makeConnection(h.binding) }),
    delivery(body),
  );
  assert.ok(verified);
  assert.equal(verified.providerEventType, "nango.auth.creation");
  assert.equal(verified.verification.method, "vendor-signature");
  assert.equal(verified.authority, `nango:${ENVIRONMENT}:${h.double.origin}`);

  // The helper matches the documented construction exactly.
  assert.equal(
    verifyNangoSignature(
      SIGNING_KEY,
      new TextEncoder().encode(JSON.stringify(body)),
      signNangoWebhook(SIGNING_KEY, JSON.stringify(body)),
    ),
    true,
  );
});

test("NG-06: a forged, absent or re-signed-body signature is refused", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const ctx = h.context({ connection: makeConnection(h.binding) });
  const body = authBody();

  for (const bad of [
    delivery(body, { header: "0".repeat(64) }),
    delivery(body, { signingKey: "another-environments-signing-key" }),
    // The API key is not the signing key; using it must fail.
    delivery(body, { signingKey: SECRET_KEY }),
    delivery(body, { header: "not-hex" }),
  ])
    assert.equal(await h.adapter.events!.verify(ctx, bad), undefined);

  const unsigned = delivery(body);
  unsigned.headers.delete("x-nango-hmac-sha256");
  assert.equal(await h.adapter.events!.verify(ctx, unsigned), undefined);

  // A body altered after signing no longer matches its signature.
  const tampered = delivery(body);
  tampered.body = new TextEncoder().encode(
    JSON.stringify({ ...body, connectionId: "someone-elses" }),
  );
  assert.equal(await h.adapter.events!.verify(ctx, tampered), undefined);
});

test("NG-06: the legacy X-Nango-Signature header alone is not accepted", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const raw = JSON.stringify(authBody());
  const headers = new Headers({ "content-type": "application/json" });
  // The docs say this legacy plain-SHA-256 header is sent for compatibility
  // but "should not be used"; it must not authenticate a delivery on its own.
  headers.set("x-nango-signature", legacyNangoSignature(SECRET_KEY, raw));
  const result = await h.adapter.events!.verify(
    h.context({ connection: makeConnection(h.binding) }),
    { headers, body: new TextEncoder().encode(raw), receivedAt: Date.now() },
  );
  assert.equal(result, undefined);
});

test("NG-06: without a configured signing key no delivery is ever accepted", async (t) => {
  const h = await harness({
    configuration: { [NANGO_CONFIGURATION_NAMES.webhookSigningKey]: undefined },
  });
  t.after(() => h.close());
  assert.equal(
    await h.adapter.events!.verify(
      h.context({ connection: makeConnection(h.binding) }),
      delivery(authBody()),
    ),
    undefined,
  );
  const events = h.adapter
    .capabilities(new Set(["NANGO_SECRET_KEY", "NANGO_ENVIRONMENT"]))
    .find((status) => status.dimension === "events");
  assert.equal(events?.configuration, "missing");
});

test("NG-06: an event for another environment is refused even when correctly signed", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const result = await h.adapter.events!.verify(
    h.context({ connection: makeConnection(h.binding) }),
    delivery(authBody({ environment: "PROD" })),
  );
  assert.equal(result, undefined);
});

test("NG-06: a creation event correlates through the handoff nonce, not through its tags", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
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
  const tenantTag = h.double.sessions[0]!.tags![TAG_KEYS.tenant]!;
  h.double.addConnection(
    connectionRow({
      tags: {
        [TAG_KEYS.handoff]: nonce,
        [TAG_KEYS.connection]: connection.connectionRef,
        [TAG_KEYS.generation]: "0",
        [TAG_KEYS.tenant]: tenantTag,
      },
    }),
  );
  const withHandoff = { ...connection, handoff: issued.summary };
  const ctx = h.context({ connection: withHandoff });
  const event = await h.adapter.events!.verify(
    ctx,
    delivery(
      authBody({
        tags: {
          [TAG_KEYS.handoff]: nonce,
          [TAG_KEYS.connection]: connection.connectionRef,
          [TAG_KEYS.tenant]: tenantTag,
        },
      }),
    ),
  );
  assert.ok(event);
  assert.equal(event.connectionRef, connection.connectionRef);

  const completed = await h.adapter.complete!(ctx, { kind: "event", event });
  assert.equal(completed.state, "complete");
  assert.equal(completed.externalIds?.connectionId, CONNECTION_ID);
});

test("AC-AUTH-01: spoofed ownership tags cannot establish ownership without the host mapping", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = makeConnection(h.binding);
  const start = await h.adapter.authorize!(h.context({ connection }), {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
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
  const ctx = h.context({
    connection: { ...connection, handoff: issued.summary },
  });

  // The event correlates (it carries our nonce) but claims a different local
  // connection and tenant in its tags. Tags are correlation aids, never
  // authority: the mismatch is refused.
  const event = await h.adapter.events!.verify(
    ctx,
    delivery(
      authBody({
        tags: {
          [TAG_KEYS.handoff]: nonce,
          [TAG_KEYS.connection]: "conn:someone-elses",
          [TAG_KEYS.tenant]: "tenant-b-digest",
        },
      }),
    ),
  );
  assert.ok(event);
  const result = await h.adapter.complete!(ctx, { kind: "event", event });
  assert.equal(result.state, "denied");
  assert.equal(result.code, "nango.event.tag-mismatch");
  assert.equal(h.ports.inspect.credentialRefs().length, 0);
});

test("NG-06: an event naming another integration is refused", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });
  const event = await h.adapter.events!.verify(
    ctx,
    delivery(
      authBody({ operation: "override", providerConfigKey: "github-sandbox" }),
    ),
  );
  assert.ok(event);
  const result = await h.adapter.complete!(ctx, { kind: "event", event });
  assert.equal(result.state, "denied");
  assert.equal(result.code, "nango.event.integration-mismatch");
});

test("AC-NG-07: a duplicate delivery is reconciled once and changes nothing the second time", async (t) => {
  const h = await harness({ double: { connections: [connectionRow()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });
  const event = await h.adapter.events!.verify(ctx, delivery(syncBody()));
  assert.ok(event);

  const first = await h.adapter.reconcileEvent(ctx, event);
  assert.equal(first.duplicate, false);
  assert.equal(first.code, "nango.sync.completed");

  const second = await h.adapter.reconcileEvent(ctx, event);
  assert.equal(second.duplicate, true);
  assert.equal(second.code, "nango.event.duplicate");
  assert.equal(second.adapterState, undefined);
});

test("AC-NG-07: an out-of-order sync event is marked stale and invents no checkpoint", async (t) => {
  const h = await harness({
    double: {
      connections: [connectionRow()],
      syncStatus: [
        {
          connection_id: CONNECTION_ID,
          name: "github-issues",
          status: "SUCCESS",
          finishedAt: "2026-03-02T00:00:00.000Z",
          checkpoint: { page: 2 },
        },
      ],
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding, {
    state: {
      nangoSync: {
        "github-issues::GithubIssue": {
          modifiedAfter: "2026-03-02T00:00:00.000Z",
          success: true,
          checkpoints: { from: { page: 1 }, to: { page: 2 } },
          at: "2026-03-02T00:00:00.000Z",
        },
      },
    },
  });
  const ctx = h.context({ connection });

  // An older run's webhook arrives late.
  const late = await h.adapter.events!.verify(
    ctx,
    delivery(
      syncBody({
        modifiedAfter: "2026-03-01T00:00:00.000Z",
        checkpoints: { from: null, to: { page: 1 } },
      }),
    ),
  );
  assert.ok(late);
  const result = await h.adapter.reconcileEvent(ctx, late);
  assert.equal(result.ordering, "stale");
  assert.equal(result.code, "nango.sync.stale-event");
  // No adapter state is written back, so the newer checkpoint stands.
  assert.equal(result.adapterState, undefined);
  // The authoritative status is reported verbatim from Nango.
  assert.deepEqual(result.syncStatus?.[0]?.checkpoint, { page: 2 });
});

test("AC-NG-07: sync checkpoints travel exactly as Nango sent them", async (t) => {
  const h = await harness({ double: { connections: [connectionRow()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });

  // A full sync reports `checkpoints.from === null`; that null is preserved,
  // never turned into an invented starting point.
  const event = await h.adapter.events!.verify(
    ctx,
    delivery(syncBody({ checkpoints: { from: null, to: { page: 1 } } })),
  );
  assert.ok(event);
  const result = await h.adapter.reconcileEvent(ctx, event);
  const state = result.adapterState?.nangoSync as Record<
    string,
    { checkpoints: unknown }
  >;
  assert.deepEqual(state["github-issues::GithubIssue"]!.checkpoints, {
    from: null,
    to: { page: 1 },
  });

  // A sync with no checkpoints at all keeps the field absent.
  const h2 = await harness({ double: { connections: [connectionRow()] } });
  t.after(() => h2.close());
  const connection2 = await activeConnection(h2.ports, h2.binding);
  const ctx2 = h2.context({ connection: connection2 });
  const noCheckpoints = { ...syncBody() } as Record<string, unknown>;
  delete noCheckpoints.checkpoints;
  const event2 = await h2.adapter.events!.verify(ctx2, delivery(noCheckpoints));
  assert.ok(event2);
  const result2 = await h2.adapter.reconcileEvent(ctx2, event2);
  const state2 = result2.adapterState?.nangoSync as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal("checkpoints" in state2["github-issues::GithubIssue"]!, false);
});

test("AC-NG-07: a refresh failure maps to lifecycle only after checking current state", async (t) => {
  const h = await harness({
    double: {
      connections: [
        connectionRow({ errors: [{ type: "auth", log_id: "log-9" }] }),
      ],
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });
  const event = await h.adapter.events!.verify(
    ctx,
    delivery(
      authBody({
        operation: "refresh",
        success: false,
        error: { type: "refresh_token_expired", description: "expired" },
      }),
    ),
  );
  assert.ok(event);
  const result = await h.adapter.reconcileEvent(ctx, event);
  assert.equal(result.lifecycle, "reconnect-required");
  assert.equal(result.code, "nango.connection.auth-error");
});

test("AC-NG-07: a transient refresh failure that Nango has already recovered is degraded, not broken", async (t) => {
  const h = await harness({
    double: { connections: [connectionRow({ errors: [] })] },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });
  const event = await h.adapter.events!.verify(
    ctx,
    delivery(authBody({ operation: "refresh", success: false })),
  );
  assert.ok(event);
  const result = await h.adapter.reconcileEvent(ctx, event);
  // Nango retries refreshes on its own cycle; the current state has no auth
  // error, so this is not a reconnect-required connection.
  assert.equal(result.lifecycle, "degraded");
});

test("AC-NG-07: a deletion event is checked against Nango before unbinding", async (t) => {
  const gone = await harness({ double: { connections: [] } });
  const connection = await activeConnection(gone.ports, gone.binding);
  const ctx = gone.context({ connection });
  const event = await gone.adapter.events!.verify(
    ctx,
    delivery(authBody({ operation: "deletion" })),
  );
  assert.ok(event);
  const result = await gone.adapter.reconcileEvent(ctx, event);
  assert.equal(result.code, "nango.connection.deleted");
  assert.equal(result.lifecycle, "authorization-required");
  await gone.close();

  // The same event, when the connection still exists, is stale rather than
  // authoritative: a replayed deletion cannot unbind a live connection.
  const live = await harness({ double: { connections: [connectionRow()] } });
  const liveConnection = await activeConnection(live.ports, live.binding);
  const liveCtx = live.context({ connection: liveConnection });
  const liveEvent = await live.adapter.events!.verify(
    liveCtx,
    delivery(authBody({ operation: "deletion" })),
  );
  assert.ok(liveEvent);
  const liveResult = await live.adapter.reconcileEvent(liveCtx, liveEvent);
  assert.equal(liveResult.ordering, "stale");
  assert.equal(liveResult.lifecycle, "active");
  await live.close();
});

test("AC-NG-07: dedupe is scoped to the authority and bounded", async () => {
  const inbox = new BoundedEventInbox(2, 1000);
  assert.equal(await inbox.seen("nango:dev:a", "e1", 0), false);
  assert.equal(await inbox.seen("nango:dev:a", "e1", 0), true);
  // The same event id from another Nango environment is a different event.
  assert.equal(await inbox.seen("nango:prod:a", "e1", 0), false);
  // Entries age out of the window.
  assert.equal(await inbox.seen("nango:dev:a", "e1", 5000), false);
});

test("NG-06: forwarded provider payloads are classified secret and attributed by connection", async (t) => {
  const h = await harness({ double: { connections: [connectionRow()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });
  const event = await h.adapter.events!.verify(
    ctx,
    delivery({
      from: "github",
      type: "forward",
      connectionId: CONNECTION_ID,
      providerConfigKey: INTEGRATION,
      payload: { action: "opened", secretish: "provider-payload" },
    }),
  );
  assert.ok(event);
  assert.equal(event.providerEventType, "nango.forward");
  // A raw provider payload has not been reviewed for disclosure.
  assert.equal(event.payloadClassification, "secret");

  const result = await h.adapter.reconcileEvent(ctx, event);
  assert.equal(result.code, "nango.event.forwarded");

  const mismatched = await h.adapter.events!.verify(
    ctx,
    delivery({
      from: "github",
      type: "forward",
      connectionId: "someone-elses",
      providerConfigKey: INTEGRATION,
      payload: {},
    }),
  );
  assert.ok(mismatched);
  const mismatchResult = await h.adapter.reconcileEvent(ctx, mismatched);
  assert.equal(mismatchResult.code, "nango.event.connection-mismatch");
});

test("NG-06: an unknown future webhook type is ignored rather than mishandled", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const ctx = h.context({ connection: makeConnection(h.binding) });
  const event = await h.adapter.events!.verify(
    ctx,
    delivery({ type: "some-future-type", whatever: true }),
  );
  assert.ok(event);
  assert.equal(event.providerEventType, "nango.ignored");
  const result = await h.adapter.reconcileEvent(ctx, event);
  assert.equal(result.code, "nango.event.ignored");
});

test("NG-06: an oversized or prototype-polluting body is refused before parsing into state", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const ctx = h.context({ connection: makeConnection(h.binding) });

  const polluting = `{"type":"auth","operation":"creation","connectionId":"${CONNECTION_ID}","providerConfigKey":"${INTEGRATION}","success":true,"__proto__":{"admin":true}}`;
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-nango-hmac-sha256", signNangoWebhook(SIGNING_KEY, polluting));
  assert.equal(
    await h.adapter.events!.verify(ctx, {
      headers,
      body: new TextEncoder().encode(polluting),
      receivedAt: Date.now(),
    }),
    undefined,
  );
  assert.equal(({} as Record<string, unknown>).admin, undefined);

  const huge = JSON.stringify({
    type: "auth",
    blob: "x".repeat(2 * 1024 * 1024),
  });
  const bigHeaders = new Headers({ "content-type": "application/json" });
  bigHeaders.set("x-nango-hmac-sha256", signNangoWebhook(SIGNING_KEY, huge));
  assert.equal(
    await h.adapter.events!.verify(ctx, {
      headers: bigHeaders,
      body: new TextEncoder().encode(huge),
      receivedAt: Date.now(),
    }),
    undefined,
  );
});

test("NG-06: an event from another Nango authority is never reconciled", async (t) => {
  const h = await harness({ double: { connections: [connectionRow()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });
  const event = await h.adapter.events!.verify(ctx, delivery(syncBody()));
  assert.ok(event);
  const result = await h.adapter.reconcileEvent(ctx, {
    ...event,
    authority: "nango:prod:https://api.nango.dev",
  });
  assert.equal(result.code, "nango.event.authority");
  assert.equal(result.lifecycle, undefined);
});

test("NG-06: verified event payloads never carry the signing key or API key", async (t) => {
  const h = await harness({ double: { connections: [connectionRow()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });
  const event = await h.adapter.events!.verify(ctx, delivery(syncBody()));
  assert.ok(event);
  const strings = stringsIn(event);
  assert.equal(strings.includes(SIGNING_KEY), false);
  assert.equal(strings.includes(SECRET_KEY), false);
});
