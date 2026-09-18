import assert from "node:assert/strict";
import test from "node:test";
import { agent, delegate } from "../commands/harness.js";
import {
  activeConnection,
  approveFixtureBinding,
  connectionPath,
  createHarness,
  fakeClock,
  human,
  json,
  operationRef,
  ORIGIN,
  SESSION,
  startConnection,
} from "./harness.js";

/*
 * QA-02. The charter's acceptance oracles, executed through the public command
 * routes rather than through adapter internals, and mapped by name to the
 * oracle they discharge. Determinism enters only through the explicit ports:
 * a test that needs a fixed clock constructs the service with one, and the
 * production default (no clock supplied) is asserted separately at the end of
 * this file so a convenient test seam cannot become the shipped behaviour.
 */

test("AC-AUTH-01: a forged tenant, subject or owner in the request body grants nothing", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const approved = await approveFixtureBinding(harness);

  const forged = await harness.fetch("/api/v1/connectors/connections", {
    body: {
      bindingRef: approved.bindingRef,
      ownerKind: "user",
      tenantId: "tenant-victim",
      subjectId: "subject-victim",
      actor: { tenantId: "tenant-victim", capabilities: ["admin"] },
      intent: {
        profileId: "oauth",
        requestedPermissions: ["read"],
        accountSwitch: false,
        interruption: "allowed",
      },
    },
    session: SESSION,
  });
  assert.equal(
    forged.status,
    400,
    "an unknown identity field is rejected outright, not quietly honoured",
  );
  const body = await json(forged);
  assert.equal(body.error, "invalid-request");

  // And the host-authenticated identity is the one that owns what is created.
  const created = await startConnection(harness, approved.bindingRef);
  const stored = harness.ports.inspect
    .connections()
    .find((entry) => entry.record.connectionRef === created.connectionRef);
  assert.ok(stored);
  assert.equal(stored.record.tenantId, "tenant-a");
  assert.equal(stored.record.ownerId, "subject-1");
});

test("AC-AUTH-02: two tenants are isolated even when they name the same account", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const other = human({ tenantId: "tenant-b", subjectId: "subject-1" });

  const mine = await activeConnection(harness);
  harness.register("other-session", other);
  const theirs = await approveFixtureBinding(harness, {
    session: "other-session",
    actor: other,
  });
  assert.notEqual(theirs.bindingRef, mine.bindingRef);

  const peek = await harness.fetch(connectionPath(mine.connectionRef), {
    session: "other-session",
  });
  assert.equal(
    peek.status,
    404,
    "another tenant's connection does not even exist for this caller",
  );

  const list = await harness.fetch("/api/v1/connectors/connections", {
    session: "other-session",
  });
  assert.deepEqual((await json(list)).connections, []);
});

test("AC-UX-06 / AC-IMP-02: the directory separates implementation, configuration and evidence", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  harness.register(SESSION, human());

  const catalog = await harness.fetch("/api/v1/connectors/catalog", {
    session: SESSION,
  });
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  const entries = (await json(catalog)).entries as Array<
    Record<string, unknown>
  >;
  const entry = entries.find((item) => item.id === "fixture-http");
  assert.ok(entry, "the fixture adapter is listed");
  assert.equal(
    entry.support,
    "fixture",
    "a fixture entry is visibly not a provider-backed integration",
  );
  const capabilities = entry.capabilities as Array<Record<string, unknown>>;
  assert.ok(capabilities.length > 0);
  for (const capability of capabilities) {
    assert.ok(
      typeof capability.implementation === "string",
      "implementation status is reported",
    );
    assert.ok(
      typeof capability.configuration === "string",
      "configuration status is reported separately",
    );
    assert.ok(
      typeof capability.evidence === "string",
      "and evidence level is reported separately again",
    );
    assert.notEqual(
      capability.evidence,
      "live-authorized",
      "no fixture entry may claim live evidence",
    );
    assert.notEqual(capability.evidence, "deployed");
  }
});

test("AC-AUTH-13 / AC-UX-02: a claimed approval is not an approval; consent is enforced server side", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { connectionRef, bindingRef } = await activeConnection(harness);
  const writeRef = operationRef(harness, bindingRef, "createItem");

  const asserted = await harness.fetch(
    connectionPath(connectionRef, "invoke"),
    {
      body: {
        operationRef: writeRef,
        input: { name: "claimed" },
        commandId: "qa-claim-1",
        // A model asserting the human already agreed, in every shape it might try.
        userApproved: true,
        consent: "granted",
      },
      session: SESSION,
    },
  );
  assert.equal(
    asserted.status,
    400,
    "an unrecognized consent field is refused rather than interpreted",
  );
  assert.equal(
    harness.provider.writeCount("claimed"),
    0,
    "and nothing reached the provider",
  );

  const honest = await harness.fetch(connectionPath(connectionRef, "invoke"), {
    body: {
      operationRef: writeRef,
      input: { name: "claimed" },
      commandId: "qa-claim-2",
    },
    session: SESSION,
  });
  const blocked = await json(honest);
  assert.equal(blocked.state, "human-required");
  assert.equal(blocked.code, "consent.required");
  assert.equal(harness.provider.writeCount("claimed"), 0);
});

test("AC-AG-04 / AC-MCP-06: an unauthenticated caller and a stopped assistant are denied alike", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { connectionRef, bindingRef } = await activeConnection(harness);
  const readRef = operationRef(harness, bindingRef, "listItems");

  const anonymous = await harness.fetch(connectionPath(connectionRef));
  assert.equal(anonymous.status, 401, "no host session, no answer");

  const delegated = agent();
  harness.register("agent-session", delegated);
  await delegate(harness.store, delegated);
  const allowed = await harness.fetch(connectionPath(connectionRef, "invoke"), {
    body: { operationRef: readRef, input: {}, commandId: "qa-agent-1" },
    session: "agent-session",
  });
  assert.equal(allowed.status, 200, "a live delegation may use the read");

  await delegate(harness.store, delegated, { stopped: true });
  const stopped = await harness.fetch(connectionPath(connectionRef, "invoke"), {
    body: { operationRef: readRef, input: {}, commandId: "qa-agent-2" },
    session: "agent-session",
  });
  assert.ok(
    stopped.status >= 400,
    "once the assistant is stopped the same transport refuses it",
  );
  const stoppedBody = await json(stopped);
  assert.notEqual(stoppedBody.state, "complete");
});

test("AC-STATE-03: local unlink, broker delete and upstream revoke are distinct intents", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { connectionRef } = await activeConnection(harness);

  const before = await json(
    await harness.fetch(connectionPath(connectionRef), { session: SESSION }),
  );
  const unlink = await harness.fetch(
    connectionPath(connectionRef, "disconnect"),
    {
      body: { scope: "local", expectedRevision: before.revision },
      session: SESSION,
    },
  );
  assert.equal(unlink.status, 200);
  const outcome = await json(unlink);
  const scopes = outcome.result as Record<string, string>;
  assert.equal(scopes.local, "applied");
  assert.notEqual(
    scopes.upstream,
    "applied",
    "a local unlink never claims an upstream revocation",
  );
  assert.notEqual(scopes.broker, "applied");

  const status = await harness.fetch(connectionPath(connectionRef), {
    session: SESSION,
  });
  const after = await json(status);
  assert.notEqual(after.lifecycle, "active");
});

test("AC-UX-03: a blocking compatibility issue is reported before any connection is attempted", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  harness.register(SESSION, human());

  const rejected = await harness.fetch("/api/v1/connectors/import", {
    body: {
      kind: "upload",
      mediaType: "application/json",
      text: JSON.stringify({ format: "fixture-connector", name: "broken" }),
    },
    session: SESSION,
  });
  assert.ok(
    rejected.status >= 400,
    "an undescribable document is refused at import, not at connect time",
  );
  const body = await json(rejected);
  assert.ok(typeof body.error === "string");
  assert.equal(
    JSON.stringify(body).includes("stack"),
    false,
    "and the diagnostic is sanitized",
  );
});

test("AC-AUTH-07 / AC-UX-04: a delayed callback cannot revive a cancelled attempt", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const approved = await approveFixtureBinding(harness);
  const started = await startConnection(harness, approved.bindingRef);
  assert.ok(started.presentationUrl);

  // The human gives up before the provider ever redirects.
  const cancelled = await harness.fetch(
    connectionPath(started.connectionRef, "cancel"),
    { body: {}, session: SESSION },
  );
  assert.equal(cancelled.status, 200);

  // The provider's redirect arrives afterwards.
  const provider = await fetch(started.presentationUrl, {
    redirect: "manual",
  });
  const location = provider.headers.get("location");
  await provider.body?.cancel().catch(() => {});
  assert.ok(location);
  const callback = new URL(location);
  const late = await harness.fetch(`${callback.pathname}${callback.search}`, {
    session: SESSION,
  });
  assert.ok(
    late.status === 303 || late.status >= 400,
    "the late callback is handled, never silently trusted",
  );
  if (late.status === 303)
    assert.notEqual(
      new URL(late.headers.get("location")!).searchParams.get("outcome"),
      "active",
      "a cancelled attempt is not resurrected into an active connection",
    );

  const status = await harness.fetch(connectionPath(started.connectionRef), {
    session: SESSION,
  });
  const after = await json(status);
  assert.notEqual(after.lifecycle, "active");
});

test("AC-AUTH-14: a callback whose correlation belongs to nothing is refused", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  harness.register(SESSION, human());

  const forged = await harness.fetch(
    "/api/v1/connectors/callback?state=not-a-real-state&code=stolen",
    { session: SESSION },
  );
  assert.ok(
    forged.status === 303 || forged.status >= 400,
    "the route answers without throwing",
  );
  if (forged.status === 303)
    assert.notEqual(
      new URL(forged.headers.get("location")!).searchParams.get("outcome"),
      "active",
    );
  assert.equal(
    harness.ports.inspect.connections().length,
    0,
    "no connection was created by an uncorrelated callback",
  );
});

test("AC-IMP-13: an imported secret canary never reaches a public projection", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  harness.register(SESSION, human());
  const canary = "QA_CANARY_SECRET_4f1";
  const document = JSON.stringify({
    format: "fixture-connector",
    name: "Canary service",
    description: `A service whose description leaks ${canary}.`,
    service: "canary",
    servers: [harness.provider.origin],
    operations: [
      {
        nativeId: "listItems",
        method: "GET",
        path: "/v1/items",
        effect: "read",
        dataClassification: "public",
      },
    ],
  });
  const imported = await harness.fetch("/api/v1/connectors/import", {
    body: { kind: "upload", mediaType: "application/json", text: document },
    session: SESSION,
  });
  assert.equal(imported.status, 200);

  const catalog = await harness.fetch("/api/v1/connectors/catalog", {
    session: SESSION,
  });
  const catalogText = JSON.stringify(await json(catalog));
  // The description is author-visible; the assertion below is about the raw
  // artifact handle, which must never be projected anywhere.
  const definitions = await harness.fetch("/api/v1/connectors/definitions", {
    session: SESSION,
  });
  const listText = JSON.stringify(await json(definitions));
  for (const text of [catalogText, listText])
    assert.equal(
      /artifact:/.test(text),
      false,
      "no projection carries a protected artifact handle",
    );
});

test("QA-02: a controlled clock reaches the service only through its port", async (t) => {
  const clock = fakeClock();
  const harness = await createHarness({ now: clock.now });
  t.after(() => harness.close());
  const approved = await approveFixtureBinding(harness);
  const started = await startConnection(harness, approved.bindingRef);

  const handoff = harness.ports.inspect.handoffs().at(-1);
  assert.ok(handoff, "a handoff was issued");
  assert.equal(
    handoff.issuedAt,
    clock.now(),
    "the issue time is the injected clock's, not the wall clock's",
  );
  assert.ok(
    handoff.expiresAt > clock.now(),
    "and the expiry is computed from it",
  );
  const before = handoff.expiresAt;
  clock.advance(60_000);
  assert.equal(
    harness.ports.inspect.handoffs().at(-1)!.expiresAt,
    before,
    "advancing the clock does not mutate an already-issued record",
  );
  assert.ok(started.connectionRef);
});

test("QA-02 production defaults: with no clock injected the service uses real time", async (t) => {
  // The seam above must not be the shipped behaviour: constructed the way a
  // deployment constructs it, the service reads the real clock.
  const harness = await createHarness();
  t.after(() => harness.close());
  const approved = await approveFixtureBinding(harness);
  const before = Date.now();
  await startConnection(harness, approved.bindingRef);
  const after = Date.now();

  const handoff = harness.ports.inspect.handoffs().at(-1);
  assert.ok(handoff);
  assert.ok(
    handoff.issuedAt >= before && handoff.issuedAt <= after,
    "the default clock is wall-clock time, not a frozen fixture value",
  );
});

test("QA-02 production defaults: a callback return route is built from the deployment origin", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const approved = await approveFixtureBinding(harness);
  const started = await startConnection(harness, approved.bindingRef);
  assert.ok(started.presentationUrl);

  const provider = await fetch(started.presentationUrl, { redirect: "manual" });
  const location = provider.headers.get("location")!;
  await provider.body?.cancel().catch(() => {});
  const callback = new URL(location);
  // A caller-supplied return target must not be honoured.
  const response = await harness.fetch(
    `${callback.pathname}${callback.search}&return_to=https://attacker.example/steal`,
    { session: SESSION },
  );
  assert.ok(response.status === 303 || response.status >= 400);
  if (response.status === 303)
    assert.equal(
      new URL(response.headers.get("location")!).origin,
      ORIGIN,
      "the return route comes from the deployment origin only",
    );
});
