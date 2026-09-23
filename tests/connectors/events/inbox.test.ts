import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  PersistenceConflict,
  PostgresCeremonyStore,
  type AsyncCeremonyStore,
} from "../../../src/server/persistence/index.js";
import { postgresFixture } from "../../fixtures/postgres.js";
import {
  EventInbox,
  createEventDispatcher,
  createVerifiedEnvelope,
  eventDeliveryId,
  type EventDelivery,
  type ReconcileOutcome,
  type VerifiedEventEnvelopeV1,
} from "../../../src/server/connectors/events/index.js";
import type { CompletionInput } from "../../../src/server/connectors/adapter.js";
import { memoryStore, ring, scaffold } from "./helpers.js";

/*
 * EVT-04. Admission is the moment an event becomes durable: one first-writer
 * record per (tenant, authority, delivery id) and its continuation, written in
 * one transaction. Delivery reuses the outbox lease-and-fence discipline. No
 * exactly-once is claimed; ordering is labelled, never trusted, and a status
 * whose order is doubtful is reconciled with the authority instead.
 */

const RECEIVED = Date.parse("2026-09-18T12:00:00.000Z");
const envelope = (
  overrides: Partial<Parameters<typeof createVerifiedEnvelope>[0]> = {},
): VerifiedEventEnvelopeV1 =>
  createVerifiedEnvelope({
    eventId: "evt_1",
    authority: "acme-billing",
    providerEventType: "invoice.paid",
    receivedAt: RECEIVED,
    sourceTime: RECEIVED - 1000,
    verification: {
      method: "standard-webhooks",
      keyId: "primary",
      verifiedAt: RECEIVED,
    },
    connectionRef: "connection:1",
    payloadClassification: "personal",
    payload: { id: "in_1" },
    ...overrides,
  });

const collectHandler = () => {
  const seen: EventDelivery[] = [];
  return {
    seen,
    handlers: {
      "connector-event": async (delivery: EventDelivery) => {
        seen.push(delivery);
        return "applied" as const;
      },
    },
  };
};

test("EVT-04: admission writes the inbox record and its outbox continuation in one transaction", async () => {
  const store = memoryStore();
  try {
    const inbox = new EventInbox(store);
    const result = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope(),
      connectionRef: "connection:1",
      subscriptionId: "sub:1",
      generation: 3,
    });
    assert.equal(result.outcome, "admitted");
    assert.equal(result.deliveryId, eventDeliveryId("acme-billing", "evt_1"));
    const record = await inbox.get("tenant-a", result.deliveryId);
    assert.equal(record?.status, "admitted");
    assert.equal(record?.subjectId, "subject-1");
    assert.equal(record?.generation, 3);
    assert.equal(record?.envelope.eventId, "evt_1");
    // The sender's own timestamp is retained for later ordering decisions.
    assert.equal(record?.envelope.sourceTime, RECEIVED - 1000);
    // The continuation carries exactly the existing outbox shape.
    const outbox = await inbox.outbox("tenant-a", result.deliveryId);
    assert.equal(outbox?.task, "connector-event");
    assert.equal(outbox?.subjectId, "subject-1");
    assert.equal(outbox?.connectionRef, "connection:1");
    assert.equal(outbox?.status, "pending");
    assert.equal(outbox?.deliveryId, result.deliveryId);
  } finally {
    await store.close();
  }
});

test("EVT-04: delivery ids are authority-scoped and tenant-isolated", async () => {
  const store = memoryStore();
  try {
    const inbox = new EventInbox(store);
    // Two providers may legitimately mint the same delivery id.
    const first = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope({ authority: "acme-billing" }),
    });
    const second = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope({ authority: "other-provider" }),
    });
    assert.equal(first.outcome, "admitted");
    assert.equal(second.outcome, "admitted");
    assert.notEqual(first.deliveryId, second.deliveryId);
    // The same authority and id in another tenant is a different event and
    // never collides with, or reveals, the first tenant's record.
    const foreign = await inbox.admit({
      tenantId: "tenant-b",
      subjectId: "subject-2",
      envelope: envelope(),
    });
    assert.equal(foreign.outcome, "admitted");
    assert.equal(foreign.deliveryId, first.deliveryId);
    assert.equal(await inbox.get("tenant-b", second.deliveryId), undefined);
    assert.equal(
      (await inbox.get("tenant-b", foreign.deliveryId))?.subjectId,
      "subject-2",
    );
  } finally {
    await store.close();
  }
});

test("EVT-04: a repeated delivery is deduplicated first-writer-wins and enqueues nothing new", async () => {
  const store = memoryStore();
  try {
    const inbox = new EventInbox(store);
    const first = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope({ payload: { attempt: 1 } }),
    });
    // The provider retries with the same id but a different payload and a
    // later receipt time; the first admission remains authoritative.
    const repeat = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope({
        payload: { attempt: 2 },
        receivedAt: RECEIVED + 60_000,
      }),
    });
    assert.equal(repeat.outcome, "duplicate");
    assert.equal(repeat.deliveryId, first.deliveryId);
    assert.equal(repeat.admittedAt, first.admittedAt);
    const record = await inbox.get("tenant-a", first.deliveryId);
    assert.deepEqual(record?.envelope.payload, { attempt: 1 });
    // One continuation only: a duplicate never doubles the work.
    const { handlers, seen } = collectHandler();
    const report = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(report.delivered, 1);
    assert.equal(seen.length, 1);
  } finally {
    await store.close();
  }
});

test("EVT-04: drain claims each entry under a fence and records its outcome", async () => {
  const store = memoryStore();
  try {
    const inbox = new EventInbox(store);
    for (const id of ["evt_1", "evt_2", "evt_3"])
      await inbox.admit({
        tenantId: "tenant-a",
        subjectId: "subject-1",
        envelope: envelope({ eventId: id }),
      });
    const { handlers, seen } = collectHandler();
    const report = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(report.delivered, 3);
    assert.equal(report.failed, 0);
    assert.deepEqual(seen.map((delivery) => delivery.envelope.eventId).sort(), [
      "evt_1",
      "evt_2",
      "evt_3",
    ]);
    for (const delivery of seen) assert.equal(delivery.attempt, 1);
    // A second drain finds nothing pending: delivered entries stay delivered.
    const again = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(again.delivered, 0);
    assert.equal(seen.length, 3);
    const delivered = await inbox.get(
      "tenant-a",
      eventDeliveryId("acme-billing", "evt_1"),
    );
    assert.equal(delivered?.status, "delivered");
    assert.equal(delivered?.outcome, "applied");
    assert.equal(delivered?.attempts, 1);
  } finally {
    await store.close();
  }
});

test("EVT-04: a failing handler keeps the delivery pending with its stable id for retry", async () => {
  const store = memoryStore();
  try {
    const inbox = new EventInbox(store);
    const admitted = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope(),
    });
    let attempts = 0;
    const handlers = {
      "connector-event": async (delivery: EventDelivery) => {
        attempts++;
        assert.equal(delivery.deliveryId, admitted.deliveryId);
        if (attempts === 1) throw new Error("consumer unavailable");
        return "applied" as const;
      },
    };
    const first = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(first.failed, 1);
    assert.equal(first.delivered, 0);
    assert.equal(first.outcomes[0]?.outcome, "failed");
    assert.equal(
      (await inbox.outbox("tenant-a", admitted.deliveryId))?.status,
      "pending",
    );
    const second = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(second.delivered, 1);
    assert.equal(attempts, 2);
    // The consumer saw the same delivery id twice: deduplication is its job,
    // because nothing here claims exactly-once delivery.
    const record = await inbox.get("tenant-a", admitted.deliveryId);
    assert.equal(record?.status, "delivered");
    assert.equal(record?.attempts, 2);
  } finally {
    await store.close();
  }
});

/**
 * A store whose delivery commit loses its race on the shared ordering
 * watermark the first `failures` times, the way concurrent workers delivering
 * different events for one connection collide on that row. PostgreSQL reports
 * such a collision either as a revision conflict or, for a deadlock or
 * serialization failure, as an opaque persistence error, so both are raised.
 */
function contendedWatermark(
  inner: AsyncCeremonyStore,
  failures: number,
): AsyncCeremonyStore {
  let remaining = failures;
  return {
    transaction: (work) =>
      inner.transaction((tx) =>
        work({
          ...tx,
          put: async (key, value, expectedRevision) => {
            if (remaining > 0 && key.id.startsWith("watermark:")) {
              remaining--;
              throw remaining % 2
                ? new PersistenceConflict()
                : new Error("Persistence operation unavailable");
            }
            return tx.put(key, value, expectedRevision);
          },
        }),
      ),
    close: () => inner.close(),
  };
}

test("EVT-04: a delivery commit lost to contention is retried, not counted as a failed attempt", async () => {
  const maxAttempts = 3;
  // More lost commits than maxAttempts: counting them as attempts would park
  // an event whose handler already succeeded.
  const store = contendedWatermark(memoryStore(), maxAttempts * 4);
  try {
    const inbox = new EventInbox(store);
    const admitted = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope(),
      connectionRef: "connection:1",
    });
    const { handlers, seen } = collectHandler();
    let contended = 0;
    let delivered = false;
    for (let pass = 0; pass < 20 && !delivered; pass++) {
      const report = await inbox.drain({
        tenantId: "tenant-a",
        handlers,
        maxAttempts,
      });
      assert.equal(report.failed, 0, "a lost commit is not a handler failure");
      if (report.delivered === 1) {
        delivered = true;
        continue;
      }
      contended++;
      assert.equal(report.retried, 1);
      assert.equal(report.outcomes.length, 1);
      assert.equal(report.outcomes[0]?.outcome, "retry");
      assert.ok(
        ["conflict", "upstream-unavailable"].includes(
          report.outcomes[0]?.code ?? "",
        ),
      );
      const record = await inbox.get("tenant-a", admitted.deliveryId);
      assert.equal(record?.status, "admitted");
      assert.equal(record?.attempts, 0);
      const outbox = await inbox.outbox("tenant-a", admitted.deliveryId);
      assert.equal(outbox?.status, "pending");
      assert.equal(outbox?.attempts, 0);
    }
    assert.ok(delivered, "the event is delivered once the contention clears");
    assert.ok(
      contended > maxAttempts,
      "more contended passes than maxAttempts were survived",
    );
    // Every redelivery carried the same id and attempt number: the consumer
    // deduplicates on the id, and the attempt count is the handler's own.
    assert.equal(seen.length, contended + 1);
    for (const delivery of seen) {
      assert.equal(delivery.deliveryId, admitted.deliveryId);
      assert.equal(delivery.attempt, 1);
    }
    const record = await inbox.get("tenant-a", admitted.deliveryId);
    assert.equal(record?.status, "delivered");
    assert.equal(record?.attempts, 1);
    // A later pass finds nothing to redeliver.
    const after = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(after.delivered + after.retried + after.failed, 0);
  } finally {
    await store.close();
  }
});

test("EVT-04: a handler that keeps failing is parked after maxAttempts", async () => {
  const store = memoryStore();
  try {
    const inbox = new EventInbox(store);
    const admitted = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope(),
      connectionRef: "connection:1",
    });
    const attempts: number[] = [];
    const handlers = {
      "connector-event": async (delivery: EventDelivery) => {
        attempts.push(delivery.attempt);
        throw new Error("consumer unavailable");
      },
    };
    const first = await inbox.drain({
      tenantId: "tenant-a",
      handlers,
      maxAttempts: 2,
    });
    assert.equal(first.failed, 1);
    assert.equal(first.retried, 0);
    assert.equal(
      (await inbox.outbox("tenant-a", admitted.deliveryId))?.status,
      "pending",
    );
    const second = await inbox.drain({
      tenantId: "tenant-a",
      handlers,
      maxAttempts: 2,
    });
    assert.equal(second.failed, 1);
    const record = await inbox.get("tenant-a", admitted.deliveryId);
    assert.equal(record?.status, "failed");
    assert.equal(record?.attempts, 2);
    assert.equal(
      (await inbox.outbox("tenant-a", admitted.deliveryId))?.status,
      "failed",
    );
    // A parked entry is left for an operator, not retried.
    await inbox.drain({ tenantId: "tenant-a", handlers, maxAttempts: 2 });
    assert.deepEqual(attempts, [1, 2]);
  } finally {
    await store.close();
  }
});

test("EVT-04: out-of-order and ambiguous deliveries are reconciled, not applied", async () => {
  const store = memoryStore();
  const reconciled: string[] = [];
  try {
    const inbox = new EventInbox(store, {
      reconcile: async (input) => {
        reconciled.push(input.reason);
        return "reconciled" as ReconcileOutcome;
      },
    });
    const admit = (eventId: string, sourceTime: number) =>
      inbox.admit({
        tenantId: "tenant-a",
        subjectId: "subject-1",
        envelope: envelope({ eventId, sourceTime }),
        connectionRef: "connection:1",
        lifecycle: { kind: "revoked" },
      });
    await admit("evt_new", RECEIVED);
    const applied: string[] = [];
    const dispatcher = createEventDispatcher({
      complete: async (delivery, input: CompletionInput) => {
        assert.equal(input.kind, "event");
        applied.push(delivery.envelope.eventId);
        return "applied" as const;
      },
    });
    const handlers = { "connector-event": dispatcher };
    const first = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(first.outcomes[0]?.ordering, "in-order");
    assert.deepEqual(applied, ["evt_new"]);
    // A revocation stamped earlier than what was already applied arrives late.
    await admit("evt_old", RECEIVED - 30_000);
    const second = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(second.outcomes[0]?.ordering, "out-of-order");
    assert.equal(second.outcomes[0]?.outcome, "reconciled");
    // It was never applied to the connection; the authority was asked instead.
    assert.deepEqual(applied, ["evt_new"]);
    assert.deepEqual(reconciled, ["out-of-order"]);
    // Two events sharing a timestamp are ambiguous, which is also reconciled.
    await admit("evt_tie", RECEIVED);
    const third = await inbox.drain({ tenantId: "tenant-a", handlers });
    assert.equal(third.outcomes[0]?.ordering, "ambiguous");
    assert.deepEqual(reconciled, ["out-of-order", "ambiguous"]);
    assert.deepEqual(applied, ["evt_new"]);
  } finally {
    await store.close();
  }
});

test("EVT-04: an unreconcilable ordering is indeterminate rather than silently applied", async () => {
  const store = memoryStore();
  try {
    const inbox = new EventInbox(store, {
      reconcile: async () => "unavailable" as ReconcileOutcome,
    });
    await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope({ eventId: "evt_a", sourceTime: RECEIVED }),
      connectionRef: "connection:1",
      lifecycle: { kind: "revoked" },
    });
    const dispatcher = createEventDispatcher({
      complete: async () => "applied",
    });
    await inbox.drain({
      tenantId: "tenant-a",
      handlers: { "connector-event": dispatcher },
    });
    await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope({ eventId: "evt_b", sourceTime: RECEIVED - 5000 }),
      connectionRef: "connection:1",
      lifecycle: { kind: "reconnected" },
    });
    const report = await inbox.drain({
      tenantId: "tenant-a",
      handlers: { "connector-event": dispatcher },
    });
    assert.equal(report.outcomes[0]?.outcome, "indeterminate");
  } finally {
    await store.close();
  }
});

test("AC-STATE-07/EVT-04: cancellation fences a callback already in the inbox", async () => {
  const store = memoryStore();
  try {
    const context = await scaffold({ store, generation: 4 });
    let live = 4;
    const inbox = new EventInbox(store, {
      subscriptions: context.registry,
      generation: async () => live,
    });
    const admitted = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: context.actor.subjectId,
      envelope: envelope(),
      connectionRef: "connection:1",
      subscriptionId: context.subscription.subscriptionId,
      generation: 4,
      lifecycle: { kind: "revoked" },
    });
    assert.equal(admitted.outcome, "admitted");
    // The person cancels: the connection generation advances and every
    // subscription approved under the older generation is retired.
    live = 5;
    const retired = await context.registry.fence("tenant-a", "connection:1", 5);
    assert.equal(retired, 1);
    const applied: string[] = [];
    const observed: string[] = [];
    const dispatcher = createEventDispatcher({
      complete: async (delivery) => {
        applied.push(delivery.envelope.eventId);
        return "applied" as const;
      },
      observe: (event) => observed.push(`${event.outcome}:${event.reason}`),
    });
    const report = await inbox.drain({
      tenantId: "tenant-a",
      handlers: { "connector-event": dispatcher },
    });
    // The delivery is surfaced as stale and the dispatch hook ignores it: a
    // delayed callback cannot reactivate or revoke the newer connection.
    assert.equal(report.stale, 1);
    assert.equal(report.delivered, 0);
    assert.equal(report.outcomes[0]?.stale, true);
    assert.equal(report.outcomes[0]?.outcome, "ignored");
    assert.deepEqual(applied, []);
    assert.deepEqual(observed, ["ignored:stale"]);
    const record = await inbox.get("tenant-a", admitted.deliveryId);
    assert.equal(record?.status, "stale");
    assert.equal(record?.outcome, "ignored");
  } finally {
    await store.close();
  }
});

test("EVT-04: an invalid envelope or tenant never reaches the inbox", async () => {
  const store = memoryStore();
  try {
    const inbox = new EventInbox(store);
    await assert.rejects(() =>
      inbox.admit({
        tenantId: "tenant-a",
        subjectId: "subject-1",
        envelope: { eventId: "x" } as unknown as VerifiedEventEnvelopeV1,
      }),
    );
    await assert.rejects(() =>
      inbox.admit({
        tenantId: "tenant a/../b?",
        subjectId: "subject-1",
        envelope: envelope(),
      }),
    );
  } finally {
    await store.close();
  }
});

/*
 * The same contract against real PostgreSQL, which is where duplicates and
 * concurrent workers actually have to hold: a unique primary key decides the
 * first writer, and a claim decides the single delivering worker.
 */
async function postgresContract(store: AsyncCeremonyStore): Promise<void> {
  const inbox = new EventInbox(store);
  // Twenty concurrent admissions of the same provider event.
  const racers = await Promise.all(
    Array.from({ length: 20 }, () =>
      inbox.admit({
        tenantId: "tenant-a",
        subjectId: "subject-1",
        envelope: envelope({ eventId: "evt_race" }),
        connectionRef: "connection:1",
      }),
    ),
  );
  const admitted = racers.filter((result) => result.outcome === "admitted");
  assert.equal(admitted.length, 1, "exactly one writer admits the event");
  assert.equal(
    new Set(racers.map((result) => result.deliveryId)).size,
    1,
    "every caller learns the same delivery id",
  );
  const record = await inbox.get("tenant-a", admitted[0]!.deliveryId);
  assert.equal(record?.status, "admitted");

  // Concurrent drains: the claim keeps one worker per entry.
  for (const id of ["evt_p1", "evt_p2", "evt_p3", "evt_p4"])
    await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope({ eventId: id }),
    });
  const deliveredIds: string[] = [];
  // Entries a handler is running for right now, and any entry that was
  // handed to a second worker while the first still held it.
  const holding = new Set<string>();
  const overlapping: string[] = [];
  const handlers = {
    "connector-event": async (delivery: EventDelivery) => {
      if (holding.has(delivery.deliveryId))
        overlapping.push(delivery.deliveryId);
      holding.add(delivery.deliveryId);
      deliveredIds.push(delivery.deliveryId);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
      } finally {
        holding.delete(delivery.deliveryId);
      }
      return "applied" as const;
    },
  };
  // Three workers race over the same five entries. A contended lease is not a
  // delivery, and neither is a handler whose commit lost to another worker's
  // (every event here advances one shared ordering watermark): both leave the
  // entry pending, unharmed, for a later pass. So the loop runs until the
  // queue is drained, with a bound generous enough for a loaded runner,
  // rather than assuming a fixed number of passes suffices.
  let delivered = 0;
  let failed = 0;
  for (let pass = 0; pass < 50 && delivered < 5; pass++) {
    const reports = await Promise.all([
      inbox.drain({ tenantId: "tenant-a", handlers, worker: "worker-a" }),
      inbox.drain({ tenantId: "tenant-a", handlers, worker: "worker-b" }),
      inbox.drain({ tenantId: "tenant-a", handlers, worker: "worker-c" }),
    ]);
    delivered += reports.reduce((total, report) => total + report.delivered, 0);
    failed += reports.reduce((total, report) => total + report.failed, 0);
  }
  assert.ok(delivered >= 5, "every admitted event is eventually delivered");
  assert.equal(failed, 0, "contention is never counted as a failed delivery");
  assert.equal(
    new Set(deliveredIds).size,
    5,
    "all five events reach a handler",
  );
  for (const id of new Set(deliveredIds)) {
    const entry = await inbox.get("tenant-a", id);
    assert.equal(entry?.status, "delivered");
    assert.equal(entry?.attempts, 1, "no lost commit consumed an attempt");
  }
  // Nothing here claims exactly-once: a worker whose handler succeeded but
  // whose commit lost, or whose fence was superseded, leaves the entry
  // pending, so a consumer may legitimately see the same delivery again. What
  // must hold is that the repeat carries the same authority-scoped delivery
  // id, which is what lets the consumer deduplicate, and that no two workers
  // hold one entry at once.
  assert.deepEqual(
    overlapping,
    [],
    "no entry is handed to a second worker while the first holds it",
  );
  for (const id of deliveredIds)
    assert.match(id, /^connector-event:[0-9a-f]{64}$/);
  // Cross-tenant isolation holds in the shared database.
  const other = await inbox.admit({
    tenantId: "tenant-b",
    subjectId: "subject-9",
    envelope: envelope({ eventId: "evt_race" }),
  });
  assert.equal(other.outcome, "admitted");
  assert.equal(await inbox.get("tenant-b", "nonexistent"), undefined);
  const drained = await inbox.drain({ tenantId: "tenant-b", handlers });
  assert.equal(drained.delivered, 1);
  // Tenant A's entries were untouched by tenant B's drain.
  assert.equal(
    (await inbox.get("tenant-a", admitted[0]!.deliveryId))?.status,
    "delivered",
  );
}

test("AC-STATE-07/EVT-04: dedupe and single-worker delivery hold on real PostgreSQL", async () => {
  const database = await postgresFixture();
  const store = new PostgresCeremonyStore(database.config, ring());
  try {
    await store.migrate();
    await postgresContract(store);
  } finally {
    await store.close();
    await database.close();
  }
});

test("AC-STATE-07/EVT-04: recording a delivery takes its locks in claim order on PostgreSQL", async () => {
  const database = await postgresFixture();
  const inner = new PostgresCeremonyStore(database.config, ring());
  // Counts the delivery commits that reach their outbox write.
  let commits = 0;
  const store: AsyncCeremonyStore = {
    transaction: (work) =>
      inner.transaction((tx) =>
        work({
          ...tx,
          put: async (key, value, expectedRevision) => {
            if (
              key.kind === "outbox" &&
              (value as { status?: string }).status === "delivered"
            )
              commits++;
            return tx.put(key, value, expectedRevision);
          },
        }),
      ),
    close: () => inner.close(),
  };
  try {
    await inner.migrate();
    const inbox = new EventInbox(store);
    const admitted = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: "subject-1",
      envelope: envelope({ eventId: "evt_lock_order" }),
      connectionRef: "connection:1",
    });
    const outboxKey = {
      tenant: "tenant-a",
      kind: "outbox" as const,
      id: admitted.deliveryId,
    };
    // A second worker trying to take the entry reads its outbox record, then
    // claims it. It reaches the outbox record while the first worker's handler
    // runs, and reaches the claim while that worker is recording the outcome.
    let rival: Promise<unknown> | undefined;
    const report = await inbox.drain({
      tenantId: "tenant-a",
      handlers: {
        "connector-event": async () => {
          let locked!: () => void;
          const holding = new Promise<void>((resolve) => (locked = resolve));
          rival = inner
            .transaction(async (tx) => {
              await tx.get(outboxKey);
              locked();
              await new Promise((resolve) => setTimeout(resolve, 200));
              await tx.claim(outboxKey, "worker-rival", 30_000);
            })
            .then(
              () => "claimed",
              (error: unknown) => error,
            );
          await holding;
          return "applied" as const;
        },
      },
    });
    // The rival is refused because the lease is held, not chosen as a
    // deadlock victim, and the delivery is recorded on its first commit.
    assert.ok(
      (await rival) instanceof PersistenceConflict,
      "the rival is refused the lease",
    );
    assert.equal(report.delivered, 1);
    assert.equal(report.retried, 0);
    assert.equal(commits, 1, "the delivery commit was not a deadlock victim");
    assert.equal(
      (await inbox.get("tenant-a", admitted.deliveryId))?.status,
      "delivered",
    );
  } finally {
    await store.close();
    await database.close();
  }
});

test("AC-STATE-07/EVT-04: a fenced subscription makes an admitted delivery stale on PostgreSQL", async () => {
  const database = await postgresFixture();
  const store = new PostgresCeremonyStore(database.config, ring());
  try {
    await store.migrate();
    const context = await scaffold({ store, generation: 2 });
    const inbox = new EventInbox(store, { subscriptions: context.registry });
    const admitted = await inbox.admit({
      tenantId: "tenant-a",
      subjectId: context.actor.subjectId,
      envelope: envelope({ eventId: "evt_pg_stale" }),
      connectionRef: "connection:1",
      subscriptionId: context.subscription.subscriptionId,
      generation: 2,
      lifecycle: { kind: "revoked" },
    });
    await context.registry.fence("tenant-a", "connection:1", 3);
    const applied: string[] = [];
    const report = await inbox.drain({
      tenantId: "tenant-a",
      handlers: {
        "connector-event": createEventDispatcher({
          complete: async (delivery) => {
            applied.push(delivery.deliveryId);
            return "applied" as const;
          },
        }),
      },
    });
    assert.equal(report.stale, 1);
    assert.deepEqual(applied, []);
    assert.equal(
      (await inbox.get("tenant-a", admitted.deliveryId))?.status,
      "stale",
    );
  } finally {
    await store.close();
    await database.close();
  }
});
