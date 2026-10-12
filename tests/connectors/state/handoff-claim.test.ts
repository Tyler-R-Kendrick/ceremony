import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  ConnectionStorePort,
  HandoffPort,
} from "../../../src/server/connectors/ports.js";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import { memoryPorts } from "../doubles/ports.js";
import {
  actorFor,
  connectionRecord,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * STATE-01/02: a handoff is claimed by exactly one submission. A submission
 * is named by a digest the caller computes (never the values); the claim is a
 * compare-and-set on the handoff itself, held for a lease, given back when the
 * attempt fails, and gone once the handoff settles. One scenario, run
 * unchanged against the persistent ports and the in-memory double.
 */

const LEASE_MS = 60_000;
const ONE = "a".repeat(64);
const TWO = "b".repeat(64);
// Attempts are random tokens in production; these are fixed for readable failures.
const A1 = "attempt-one-0001";
const A2 = "attempt-two-0002";
const A3 = "attempt-three-003";

type Ports = { handoffs: HandoffPort; connections: ConnectionStorePort };
type Clock = { now: () => number; advance: (ms: number) => void };

const clock = (): Clock => {
  let at = 1_700_000_000_000;
  return { now: () => at, advance: (ms) => void (at += ms) };
};

const refuses =
  (detail: string, code = "conflict") =>
  (error: unknown) =>
    error instanceof ConnectorError &&
    error.code === code &&
    error.detail === detail;

async function issueInputHandoff(ports: Ports, time: Clock) {
  const actor = actorFor("tenant-a");
  const record = connectionRecord({ tenantId: "tenant-a" });
  await ports.connections.create(record);
  const issued = await ports.handoffs.issue({
    actor,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    generation: 0,
    kind: "input-required",
    presentation: "in-app",
    expiresAt: time.now() + 3_600_000,
    intent: "conformance.select",
    private: { fields: '["choice"]' },
  });
  return { actor, record, handoffRef: issued.handoffRef };
}

async function scenario(ports: Ports, time: Clock) {
  const { actor, handoffRef } = await issueInputHandoff(ports, time);
  const claim = (submission: string, attempt: string, generation = 0) =>
    ports.handoffs.claim(handoffRef, generation, submission, attempt, LEASE_MS);

  // The first submission claims; the same one again shares it; another is refused.
  assert.equal(await claim(ONE, A1), "claimed");
  assert.equal(await claim(ONE, A2), "shared");
  await assert.rejects(claim(TWO, A3), refuses("handoff.already-claimed"));
  // A stale generation is refused whoever asks, and so is a malformed claim.
  await assert.rejects(claim(ONE, A2, 7), refuses("handoff.stale-generation"));
  await assert.rejects(
    claim("not-a-digest", A2),
    refuses("handoff.claim", "invalid-request"),
  );
  await assert.rejects(
    claim(ONE, "no"),
    refuses("handoff.claim", "invalid-request"),
  );
  await assert.rejects(
    ports.handoffs.claim("handoff:unknown", 0, ONE, A1, LEASE_MS),
    refuses("handoff.unknown", "not-found"),
  );

  // Only the attempt that holds the claim can give it back; then another may take it.
  await ports.handoffs.release(handoffRef, A2);
  await assert.rejects(claim(TWO, A3), refuses("handoff.already-claimed"));
  await ports.handoffs.release(handoffRef, A1);
  assert.equal(await claim(TWO, A3), "claimed");

  // A claim nobody finished stops holding the handoff once its lease is over.
  time.advance(LEASE_MS - 1);
  await assert.rejects(claim(ONE, A1), refuses("handoff.already-claimed"));
  time.advance(1);
  assert.equal(await claim(ONE, A1), "claimed");
  await assert.rejects(claim(TWO, A3), refuses("handoff.already-claimed"));

  // The claim names no value and is not part of what a record shows.
  const shown = await ports.handoffs.present(actor, handoffRef);
  assert.ok(shown);
  assert.equal(shown.state, "issued");
  assert.equal(JSON.stringify(shown).includes(ONE), false);
  assert.equal(JSON.stringify(shown).includes(A1), false);
  assert.equal("claim" in shown, false);

  // Settling the handoff ends the claim: nothing can claim a finished handoff.
  await ports.handoffs.complete(handoffRef, 0, "completed", A1);
  await assert.rejects(claim(ONE, A1), refuses("handoff.already-completed"));
  await assert.rejects(claim(TWO, A3), refuses("handoff.already-completed"));
  // Giving a claim back after that is not an error.
  await ports.handoffs.release(handoffRef, A1);
}

/*
 * A run that outlives its lease is not the holder any more. The attempt that
 * took the handoff over is, and the run it replaced can neither give the
 * claim back nor settle the handoff: both would act on its successor's work.
 */
async function lapsedHolder(ports: Ports, time: Clock) {
  const { handoffRef } = await issueInputHandoff(ports, time);
  const claim = (submission: string, attempt: string) =>
    ports.handoffs.claim(handoffRef, 0, submission, attempt, LEASE_MS);
  assert.equal(await claim(ONE, A1), "claimed");
  time.advance(LEASE_MS + 1);
  // An identical submission takes over: it is a different attempt.
  assert.equal(await claim(ONE, A2), "claimed");

  // The lapsed run ends and gives "its" claim back: it is the successor's, so nothing changes.
  await ports.handoffs.release(handoffRef, A1);
  await assert.rejects(claim(TWO, A3), refuses("handoff.already-claimed"));
  assert.equal(await claim(ONE, A3), "shared");

  // The lapsed run tries to settle the handoff its successor is working: refused.
  await assert.rejects(
    ports.handoffs.complete(handoffRef, 0, "completed", A1),
    refuses("handoff.claim-lost"),
  );
  // A settlement that names no attempt (an adapter settling for itself) is not fenced by claims.
  // The holder settles; its claim goes with the handoff.
  await ports.handoffs.complete(handoffRef, 0, "completed", A2);
  await assert.rejects(claim(TWO, A3), refuses("handoff.already-completed"));
}

/** Without a live claim anyone may settle, and a claim that lapsed fences no one. */
async function unfencedSettlement(ports: Ports, time: Clock) {
  const first = await issueInputHandoff(ports, time);
  // Nobody holds it: an attempt that lost its claim by release can still settle.
  assert.equal(
    await ports.handoffs.claim(first.handoffRef, 0, ONE, A1, LEASE_MS),
    "claimed",
  );
  await ports.handoffs.release(first.handoffRef, A1);
  await ports.handoffs.complete(first.handoffRef, 0, "completed", A2);

  // A claim that lapsed with no successor fences no one.
  const second = await issueInputHandoff(ports, time);
  assert.equal(
    await ports.handoffs.claim(second.handoffRef, 0, ONE, A1, LEASE_MS),
    "claimed",
  );
  time.advance(LEASE_MS + 1);
  await ports.handoffs.complete(second.handoffRef, 0, "completed", A2);

  // A live claim by another attempt is respected, and a call with no attempt is not fenced.
  const third = await issueInputHandoff(ports, time);
  assert.equal(
    await ports.handoffs.claim(third.handoffRef, 0, ONE, A1, LEASE_MS),
    "claimed",
  );
  await assert.rejects(
    ports.handoffs.complete(third.handoffRef, 0, "completed", A2),
    refuses("handoff.claim-lost"),
  );
  await ports.handoffs.complete(third.handoffRef, 0, "completed");
}

async function cancelledAndExpired(ports: Ports, time: Clock) {
  // Cancelling every pending handoff of a connection takes the claim with it.
  const cancelled = await issueInputHandoff(ports, time);
  assert.equal(
    await ports.handoffs.claim(cancelled.handoffRef, 0, ONE, A1, LEASE_MS),
    "claimed",
  );
  assert.equal(
    await ports.handoffs.cancelAll(cancelled.record.connectionRef, "cancelled"),
    1,
  );
  await assert.rejects(
    ports.handoffs.claim(cancelled.handoffRef, 0, ONE, A2, LEASE_MS),
    refuses("handoff.already-completed"),
  );

  // A claim does not keep a handoff alive past its expiry.
  const expiring = await issueInputHandoff(ports, time);
  assert.equal(
    await ports.handoffs.claim(expiring.handoffRef, 0, ONE, A1, LEASE_MS),
    "claimed",
  );
  time.advance(2 * 3_600_000);
  await assert.rejects(
    ports.handoffs.claim(expiring.handoffRef, 0, ONE, A2, LEASE_MS),
    refuses("handoff.expired", "expired"),
  );
}

async function fenced(ports: Ports, time: Clock) {
  // A connection that moved on since the handoff was issued fences the claim.
  const { actor, record, handoffRef } = await issueInputHandoff(ports, time);
  const current = await ports.connections.get(actor, record.connectionRef);
  await ports.connections.advanceGeneration(
    actor,
    record.connectionRef,
    current!.revision,
  );
  // The persistent store supersedes the connection's pending handoffs in the
  // advance itself; either way the claim is refused as a conflict.
  await assert.rejects(
    ports.handoffs.claim(handoffRef, 0, ONE, A1, LEASE_MS),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "conflict" &&
      /^handoff\.(stale-generation|already-completed)$/.test(
        error.detail ?? "",
      ),
  );
}

for (const [name, build] of [
  [
    "the persistent ports",
    async (time: Clock) => {
      const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
      return {
        ports: createConnectorPorts(store, { now: time.now }),
        close: () => store.close(),
      };
    },
  ],
  [
    "the in-memory double",
    async (time: Clock) => ({
      ports: memoryPorts({ now: time.now }),
      close: async () => {},
    }),
  ],
] as const) {
  for (const [label, run] of [
    ["claim, share, refuse, release, lease, settle", scenario],
    [
      "a lapsed holder cannot release or settle for its successor",
      lapsedHolder,
    ],
    [
      "settling is fenced only by a live claim of another attempt",
      unfencedSettlement,
    ],
    ["cancel and expiry end a claim", cancelledAndExpired],
    ["a moved generation fences a claim", fenced],
  ] as const)
    test(`STATE-01: a handoff is claimed by one submission (${label}) on ${name}`, async () => {
      const time = clock();
      const { ports, close } = await build(time);
      try {
        await run(ports, time);
      } finally {
        await close();
      }
    });
}
