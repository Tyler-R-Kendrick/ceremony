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
  const claim = (submission: string, generation = 0) =>
    ports.handoffs.claim(handoffRef, generation, submission, LEASE_MS);

  // The first submission claims; the same one again shares it; another is refused.
  assert.equal(await claim(ONE), "claimed");
  assert.equal(await claim(ONE), "shared");
  await assert.rejects(claim(TWO), refuses("handoff.already-claimed"));
  // A stale generation is refused whoever asks, and so is a malformed claim.
  await assert.rejects(claim(ONE, 7), refuses("handoff.stale-generation"));
  await assert.rejects(
    claim("not-a-digest"),
    refuses("handoff.claim", "invalid-request"),
  );
  await assert.rejects(
    ports.handoffs.claim("handoff:unknown", 0, ONE, LEASE_MS),
    refuses("handoff.unknown", "not-found"),
  );

  // Only the holder can give the claim back; then another may take it.
  await ports.handoffs.release(handoffRef, TWO);
  await assert.rejects(claim(TWO), refuses("handoff.already-claimed"));
  await ports.handoffs.release(handoffRef, ONE);
  assert.equal(await claim(TWO), "claimed");

  // A claim nobody finished stops holding the handoff once its lease is over.
  time.advance(LEASE_MS - 1);
  await assert.rejects(claim(ONE), refuses("handoff.already-claimed"));
  time.advance(1);
  assert.equal(await claim(ONE), "claimed");
  await assert.rejects(claim(TWO), refuses("handoff.already-claimed"));

  // The claim names no value and is not part of what a record shows.
  const shown = await ports.handoffs.present(actor, handoffRef);
  assert.ok(shown);
  assert.equal(shown.state, "issued");
  assert.equal(JSON.stringify(shown).includes(ONE), false);
  assert.equal("claim" in shown, false);

  // Settling the handoff ends the claim: nothing can claim a finished handoff.
  await ports.handoffs.complete(handoffRef, 0, "completed");
  await assert.rejects(claim(ONE), refuses("handoff.already-completed"));
  await assert.rejects(claim(TWO), refuses("handoff.already-completed"));
  // Giving a claim back after that is not an error.
  await ports.handoffs.release(handoffRef, ONE);
}

async function cancelledAndExpired(ports: Ports, time: Clock) {
  // Cancelling every pending handoff of a connection takes the claim with it.
  const cancelled = await issueInputHandoff(ports, time);
  assert.equal(
    await ports.handoffs.claim(cancelled.handoffRef, 0, ONE, LEASE_MS),
    "claimed",
  );
  assert.equal(
    await ports.handoffs.cancelAll(cancelled.record.connectionRef, "cancelled"),
    1,
  );
  await assert.rejects(
    ports.handoffs.claim(cancelled.handoffRef, 0, ONE, LEASE_MS),
    refuses("handoff.already-completed"),
  );

  // A claim does not keep a handoff alive past its expiry.
  const expiring = await issueInputHandoff(ports, time);
  assert.equal(
    await ports.handoffs.claim(expiring.handoffRef, 0, ONE, LEASE_MS),
    "claimed",
  );
  time.advance(2 * 3_600_000);
  await assert.rejects(
    ports.handoffs.claim(expiring.handoffRef, 0, ONE, LEASE_MS),
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
    ports.handoffs.claim(handoffRef, 0, ONE, LEASE_MS),
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
