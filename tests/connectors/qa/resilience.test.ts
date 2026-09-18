import assert from "node:assert/strict";
import test from "node:test";
import {
  createVerifiedEnvelope,
  EventInbox,
  eventDeliveryId,
  type EventDelivery,
  type VerifiedEventEnvelopeV1,
} from "../../../src/server/connectors/events/index.js";
import { memoryStore } from "../events/helpers.js";
import {
  activeConnection,
  approveFixtureBinding,
  connectionPath,
  createHarness,
  json,
  operationRef,
  SESSION,
  startConnection,
  completeOauthCallback,
} from "./harness.js";

/*
 * QA-03. Operational reality: a lost response, a repeated command, concurrent
 * workers, an unreachable provider, a cancelled attempt, a provider that comes
 * back as a different account, duplicated and out-of-order deliveries, and
 * source drift under an approved binding.
 *
 * Every assertion is on an observed state or effect — how many writes actually
 * reached the provider, what the effect journal holds, what the connection
 * lifecycle became, whether a second admission happened — and never on an HTTP
 * status alone.
 */

const RECEIVED = Date.parse("2026-09-18T12:00:00.000Z");

async function confirmedWrite(
  harness: Awaited<ReturnType<typeof createHarness>>,
  connectionRef: string,
  writeRef: string,
  name: string,
  commandId: string,
): Promise<Record<string, unknown>> {
  const response = await harness.fetch(
    connectionPath(connectionRef, "invoke"),
    {
      body: {
        operationRef: writeRef,
        input: { name },
        commandId,
        confirm: true,
      },
      session: SESSION,
    },
  );
  return json(response);
}

test("AC-MCP-03 / AC-STATE-02: a lost response leaves an uncertain effect, and the repeat does not re-apply it", async (t) => {
  const harness = await createHarness({ provider: { dropWriteResponse: true } });
  t.after(() => harness.close());
  const { connectionRef, bindingRef } = await activeConnection(harness);
  const writeRef = operationRef(harness, bindingRef, "createItem");

  const first = await confirmedWrite(
    harness,
    connectionRef,
    writeRef,
    "lost-response",
    "qa-lost-1",
  );
  assert.equal(
    first.error,
    "indeterminate",
    "a truncated answer is uncertain, not a failure and not a success",
  );
  assert.equal(
    harness.provider.received("POST", "/v1/items").length,
    1,
    "the effect really did happen upstream",
  );
  const journal = harness.ports.inspect
    .effects()
    .filter(
      (entry) =>
        entry.intent.operation === "connector.invoke" &&
        entry.intent.commandId === "qa-lost-1",
    );
  assert.equal(journal.length, 1, "intent was journaled before the call");
  assert.equal(journal[0]!.outcome?.status, "indeterminate");

  // The same command replayed: the journal answers, the provider is untouched.
  const repeat = await confirmedWrite(
    harness,
    connectionRef,
    writeRef,
    "lost-response",
    "qa-lost-1",
  );
  assert.equal(
    harness.provider.received("POST", "/v1/items").length,
    1,
    "no blind replay of a mutation whose outcome is unknown",
  );
  assert.notEqual(repeat.state, "complete");
  assert.equal(
    harness.ports.inspect
      .effects()
      .filter(
        (entry) =>
          entry.intent.operation === "connector.invoke" &&
          entry.intent.commandId === "qa-lost-1",
      ).length,
    1,
    "and no second effect was journaled",
  );
});

test("AC-STATE-01: two concurrent workers issuing one command produce one upstream effect", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { connectionRef, bindingRef } = await activeConnection(harness);
  const writeRef = operationRef(harness, bindingRef, "createItem");

  const [a, b] = await Promise.all([
    confirmedWrite(harness, connectionRef, writeRef, "once", "qa-race-1"),
    confirmedWrite(harness, connectionRef, writeRef, "once", "qa-race-1"),
  ]);
  assert.equal(
    harness.provider.received("POST", "/v1/items").length,
    1,
    "the effect journal collapses the duplicate command into one upstream write",
  );
  const completed = [a, b].filter((result) => result.state === "complete");
  assert.equal(completed.length, 1, "exactly one caller applied the effect");
  const loser = [a, b].find((result) => result.state !== "complete");
  assert.ok(loser, "the other caller did not also report success");
  assert.equal(loser.replayed, true, "it was told the command was a replay");
  const journal = harness.ports.inspect
    .effects()
    .filter(
      (entry) =>
        entry.intent.operation === "connector.invoke" &&
        entry.intent.commandId === "qa-race-1",
    );
  assert.equal(journal.length, 1, "one journal entry, not two");
});

test("AC-STATE-06: an unreachable provider preserves state and reports a sanitized error", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { connectionRef, bindingRef } = await activeConnection(harness);
  const readRef = operationRef(harness, bindingRef, "listItems");

  const before = await json(
    await harness.fetch(connectionPath(connectionRef), { session: SESSION }),
  );
  await harness.provider.close();

  const response = await harness.fetch(connectionPath(connectionRef, "invoke"), {
    body: { operationRef: readRef, input: {}, commandId: "qa-down-1" },
    session: SESSION,
  });
  const body = await json(response);
  const text = JSON.stringify(body);
  assert.equal(
    /ECONNREFUSED|stack|at Object\.|node:internal/.test(text),
    false,
    "no transport internals or stack frames reach the caller",
  );
  assert.notEqual(body.state, "complete");

  const after = await json(
    await harness.fetch(connectionPath(connectionRef), { session: SESSION }),
  );
  assert.equal(
    after.lifecycle,
    before.lifecycle,
    "an outage does not change the connection's lifecycle",
  );
});

test("AC-UX-04: cancelling a pending attempt is observable in state, not just in a status code", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const approved = await approveFixtureBinding(harness);
  const started = await startConnection(harness, approved.bindingRef);
  assert.ok(started.presentationUrl);

  const handoffsBefore = harness.ports.inspect.handoffs();
  assert.equal(handoffsBefore.at(-1)?.state, "issued");

  await harness.fetch(connectionPath(started.connectionRef, "cancel"), {
    body: {},
    session: SESSION,
  });

  const handoffsAfter = harness.ports.inspect.handoffs();
  assert.notEqual(
    handoffsAfter.at(-1)?.state,
    "issued",
    "the pending handoff is closed, not left open",
  );
  const status = await json(
    await harness.fetch(connectionPath(started.connectionRef), {
      session: SESSION,
    }),
  );
  assert.notEqual(status.lifecycle, "active");
});

test("AC-AUTH-09: a reconnect that returns a different account cannot silently replace the verified one", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { connectionRef } = await activeConnection(harness);

  const before = await json(
    await harness.fetch(connectionPath(connectionRef), { session: SESSION }),
  );
  assert.deepEqual(before.target, { kind: "account", id: "acct-primary" });

  // The provider now authenticates a different account.
  harness.provider.state.account = "acct-somebody-else";

  const reconnect = await harness.fetch(
    connectionPath(connectionRef, "reconnect"),
    {
      body: {
        expectedRevision: before.revision,
        intent: {
          profileId: "oauth",
          requestedPermissions: ["read", "write"],
          accountSwitch: false,
          interruption: "allowed",
        },
      },
      session: SESSION,
    },
  );
  const started = await json(reconnect);
  const presentation = started.presentation as { url?: string } | undefined;
  if (presentation?.url) {
    const callback = await completeOauthCallback(
      harness,
      SESSION,
      presentation.url,
    );
    assert.ok(callback.status === 303 || callback.status >= 400);
  }

  const after = await json(
    await harness.fetch(connectionPath(connectionRef), { session: SESSION }),
  );
  assert.notDeepEqual(
    after.target,
    { kind: "account", id: "acct-somebody-else" },
    "no account switch happened without an explicit account-switch intent",
  );
  const stored = harness.ports.inspect
    .connections()
    .find((entry) => entry.record.connectionRef === connectionRef);
  assert.ok(stored);
  assert.notEqual(
    stored.record.externalIds["account"],
    "acct-somebody-else",
    "and the stored external identity was not overwritten",
  );
});

test("AC-AUTH-07: a callback for a superseded generation cannot reactivate the connection", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const approved = await approveFixtureBinding(harness);
  const started = await startConnection(harness, approved.bindingRef);
  assert.ok(started.presentationUrl);

  // Ask the provider for its redirect, but hold it.
  const provider = await fetch(started.presentationUrl, { redirect: "manual" });
  const location = provider.headers.get("location")!;
  await provider.body?.cancel().catch(() => {});

  // Meanwhile the human cancels, which advances the generation.
  await harness.fetch(connectionPath(started.connectionRef, "cancel"), {
    body: {},
    session: SESSION,
  });
  const generationAfterCancel = harness.ports.inspect
    .connections()
    .find((entry) => entry.record.connectionRef === started.connectionRef)!
    .record.generation;

  const callback = new URL(location);
  await harness.fetch(`${callback.pathname}${callback.search}`, {
    session: SESSION,
  });

  const stored = harness.ports.inspect
    .connections()
    .find((entry) => entry.record.connectionRef === started.connectionRef)!;
  assert.notEqual(stored.record.lifecycle, "active");
  assert.equal(
    stored.record.generation,
    generationAfterCancel,
    "the stale callback did not advance or rebind the connection",
  );
});

/* ------------------------------------------------ deliveries and ordering */

function envelope(
  overrides: Partial<Parameters<typeof createVerifiedEnvelope>[0]> = {},
): VerifiedEventEnvelopeV1 {
  return createVerifiedEnvelope({
    eventId: "evt-qa-1",
    authority: "qa-authority",
    providerEventType: "connection.updated",
    receivedAt: RECEIVED,
    sourceTime: RECEIVED - 1000,
    verification: {
      method: "standard-webhooks",
      keyId: "primary",
      verifiedAt: RECEIVED,
    },
    connectionRef: "connection:qa",
    payloadClassification: "personal",
    payload: { sequence: 1 },
    ...overrides,
  });
}

test("AC-STATE-07: a duplicated delivery is admitted once and dispatched once", async (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const inbox = new EventInbox(store);
  const input = {
    tenantId: "tenant-a",
    subjectId: "subject-1",
    envelope: envelope(),
    connectionRef: "connection:qa",
  };

  const first = await inbox.admit(input);
  const second = await inbox.admit(input);
  assert.equal(first.outcome, "admitted");
  assert.equal(second.outcome, "duplicate");
  assert.equal(
    second.deliveryId,
    eventDeliveryId("qa-authority", "evt-qa-1"),
    "the duplicate is identified by the first admission",
  );
  assert.equal(second.admittedAt, first.admittedAt);

  const seen: EventDelivery[] = [];
  const report = await inbox.drain({
    tenantId: "tenant-a",
    handlers: {
      "connector-event": async (delivery) => {
        seen.push(delivery);
        return "applied" as const;
      },
    },
  });
  assert.equal(report.delivered, 1);
  assert.equal(seen.length, 1, "one continuation, not two");
});

test("AC-STATE-07: dedupe is scoped by tenant, so one tenant cannot suppress another's event", async (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const inbox = new EventInbox(store);
  const shared = envelope();

  const a = await inbox.admit({
    tenantId: "tenant-a",
    subjectId: "subject-1",
    envelope: shared,
    connectionRef: "connection:qa",
  });
  const b = await inbox.admit({
    tenantId: "tenant-b",
    subjectId: "subject-1",
    envelope: shared,
    connectionRef: "connection:qa",
  });
  assert.equal(a.outcome, "admitted");
  assert.equal(
    b.outcome,
    "admitted",
    "the same provider event id in another tenant is a separate delivery",
  );
});

test("AC-STATE-07: an out-of-order delivery is labelled, not trusted", async (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const inbox = new EventInbox(store);
  const base = {
    tenantId: "tenant-a",
    subjectId: "subject-1",
    connectionRef: "connection:qa",
  };

  await inbox.admit({
    ...base,
    envelope: envelope({
      eventId: "evt-newer",
      sourceTime: RECEIVED + 10_000,
      payload: { sequence: 2 },
    }),
  });
  await inbox.drain({
    tenantId: "tenant-a",
    handlers: { "connector-event": async () => "applied" as const },
  });

  await inbox.admit({
    ...base,
    envelope: envelope({
      eventId: "evt-older",
      sourceTime: RECEIVED - 10_000,
      payload: { sequence: 1 },
    }),
  });
  const report = await inbox.drain({
    tenantId: "tenant-a",
    handlers: { "connector-event": async () => "applied" as const },
  });

  assert.equal(report.outcomes.length, 1);
  const outcome = report.outcomes[0]!;
  assert.notEqual(
    outcome.ordering,
    "in-order",
    "the late delivery is not presented as if it were the newest state",
  );
});

/* ------------------------------------------------------------------ drift */

test("AC-IMP-16 / AC-STATE-05: re-importing a changed source does not silently move an approved binding", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { connectionRef, bindingRef, definitionRef } =
    await activeConnection(harness);

  const bindingsBefore = harness.definitions
    .bindings()
    .filter((binding) => binding.bindingRef === bindingRef);
  const approvedDestinations = bindingsBefore
    .at(-1)!
    .destinations.map((destination) => destination.origin);

  // The same connector, re-described with a different server and an extra
  // operation: a refresh, not an approval.
  const changed = JSON.stringify({
    format: "fixture-connector",
    name: "Fixture service",
    description: "A loopback service used to exercise connector commands.",
    service: "fixture",
    servers: ["https://moved.example"],
    operations: [
      {
        nativeId: "listItems",
        method: "GET",
        path: "/v1/items",
        effect: "read",
        dataClassification: "public",
      },
      {
        nativeId: "deleteEverything",
        method: "POST",
        path: "/v1/purge",
        effect: "write",
        dataClassification: "personal",
      },
    ],
  });
  const reimported = await harness.fetch("/api/v1/connectors/import", {
    body: { kind: "upload", mediaType: "application/json", text: changed },
    session: SESSION,
  });
  assert.equal(reimported.status, 200);

  const bindingsAfter = harness.definitions
    .bindings()
    .filter((binding) => binding.bindingRef === bindingRef);
  assert.deepEqual(
    bindingsAfter.at(-1)!.destinations.map((d) => d.origin),
    approvedDestinations,
    "the approved binding still points at the destination that was reviewed",
  );
  assert.equal(
    bindingsAfter
      .at(-1)!
      .operations.some((operation) => operation.nativeId === "deleteEverything"),
    false,
    "an operation nobody approved cannot appear inside an approved binding",
  );

  // And the live connection still refuses the new operation by name.
  const attempt = await harness.fetch(connectionPath(connectionRef, "invoke"), {
    body: {
      operationRef: `${definitionRef}#deleteEverything`,
      input: {},
      commandId: "qa-drift-1",
      confirm: true,
    },
    session: SESSION,
  });
  assert.ok(attempt.status >= 400 || (await json(attempt)).state !== "complete");
});
