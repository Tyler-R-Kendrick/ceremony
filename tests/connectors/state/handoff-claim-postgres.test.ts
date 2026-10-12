import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { PostgresCeremonyStore } from "../../../src/server/persistence/index.js";
import { postgresFixture } from "../../fixtures/postgres.js";
import {
  actorFor,
  connectionRecord,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * STATE-04: the claim on a handoff is a compare-and-set on a shared database.
 * Two server processes (separate stores with their own pools and worker
 * identities) take the same pending handoff at the same moment: with two
 * different submissions exactly one is the claimant, with the same submission
 * both are answered and exactly one of them is the one that runs.
 */

const ROUNDS = 20;
const LEASE_MS = 60_000;
const ONE = "a".repeat(64);
const TWO = "b".repeat(64);
const A1 = "attempt-one-0001";
const A2 = "attempt-two-0002";

let database: Awaited<ReturnType<typeof postgresFixture>>;
const keyring = stateKeyring();
let workerA: PostgresCeremonyStore;
let workerB: PostgresCeremonyStore;

before(async () => {
  database = await postgresFixture();
  workerA = new PostgresCeremonyStore(database.config, keyring);
  workerB = new PostgresCeremonyStore(database.config, keyring);
  await workerA.migrate();
});

after(async () => {
  await workerA.close();
  await workerB.close();
  await database.close();
});

async function pendingHandoff(
  ports: ReturnType<typeof createConnectorPorts>,
  tenant: string,
) {
  const record = connectionRecord({ tenantId: tenant });
  await ports.connections.create(record);
  const issued = await ports.handoffs.issue({
    actor: actorFor(tenant),
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    generation: 0,
    kind: "input-required",
    presentation: "in-app",
    expiresAt: Date.now() + 3_600_000,
    intent: "conformance.select",
    private: { fields: '["choice"]' },
  });
  return issued.handoffRef;
}

test("AC-STATE-08: two PostgreSQL workers claiming one handoff with different submissions leave one claimant", async () => {
  const a = createConnectorPorts(workerA, { worker: "worker-a" });
  const b = createConnectorPorts(workerB, { worker: "worker-b" });
  for (let round = 0; round < ROUNDS; round++) {
    const handoffRef = await pendingHandoff(a, `tenant-claim-${round}`);
    const [first, second] = await Promise.allSettled([
      a.handoffs.claim(handoffRef, 0, ONE, A1, LEASE_MS),
      b.handoffs.claim(handoffRef, 0, TWO, A2, LEASE_MS),
    ]);
    const claimed = [first, second].filter(
      (result) => result.status === "fulfilled",
    );
    const refused = [first, second].filter(
      (result) => result.status === "rejected",
    );
    assert.equal(claimed.length, 1, `round ${round}: one claimant`);
    assert.equal(refused.length, 1, `round ${round}: one refusal`);
    const error = (refused[0] as PromiseRejectedResult).reason;
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "conflict");
    assert.equal(error.detail, "handoff.already-claimed");
    assert.equal(
      (claimed[0] as PromiseFulfilledResult<string>).value,
      "claimed",
    );
  }
});

test("AC-STATE-08: two PostgreSQL workers claiming one handoff with the same submission share one claim", async () => {
  const a = createConnectorPorts(workerA, { worker: "worker-a" });
  const b = createConnectorPorts(workerB, { worker: "worker-b" });
  for (let round = 0; round < ROUNDS; round++) {
    const handoffRef = await pendingHandoff(a, `tenant-share-${round}`);
    const answers = await Promise.all([
      a.handoffs.claim(handoffRef, 0, ONE, A1, LEASE_MS),
      b.handoffs.claim(handoffRef, 0, ONE, A2, LEASE_MS),
    ]);
    assert.deepEqual(
      [...answers].sort(),
      ["claimed", "shared"],
      `round ${round}`,
    );
  }
});

test("AC-STATE-08: a claim made by one worker is given back and taken by the other", async () => {
  const a = createConnectorPorts(workerA, { worker: "worker-a" });
  const b = createConnectorPorts(workerB, { worker: "worker-b" });
  const handoffRef = await pendingHandoff(a, "tenant-release");
  assert.equal(
    await a.handoffs.claim(handoffRef, 0, ONE, A1, LEASE_MS),
    "claimed",
  );
  await assert.rejects(
    b.handoffs.claim(handoffRef, 0, TWO, A2, LEASE_MS),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "handoff.already-claimed",
  );
  await a.handoffs.release(handoffRef, A1);
  assert.equal(
    await b.handoffs.claim(handoffRef, 0, TWO, A2, LEASE_MS),
    "claimed",
  );
  await b.handoffs.complete(handoffRef, 0, "completed", A2);
  await assert.rejects(
    a.handoffs.claim(handoffRef, 0, ONE, A1, LEASE_MS),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "handoff.already-completed",
  );
});

test("AC-STATE-08: a run whose lease lapsed cannot release or settle for the worker that took over", async () => {
  const a = createConnectorPorts(workerA, { worker: "worker-a" });
  const b = createConnectorPorts(workerB, { worker: "worker-b" });
  const handoffRef = await pendingHandoff(a, "tenant-lapse");
  // The database's own clock decides the lease: a short one, then wait it out.
  const SHORT_MS = 200;
  assert.equal(
    await a.handoffs.claim(handoffRef, 0, ONE, A1, SHORT_MS),
    "claimed",
  );
  await delay(SHORT_MS + 100);
  assert.equal(
    await b.handoffs.claim(handoffRef, 0, ONE, A2, LEASE_MS),
    "claimed",
  );

  await a.handoffs.release(handoffRef, A1);
  await assert.rejects(
    b.handoffs.claim(handoffRef, 0, TWO, "attempt-three-003", LEASE_MS),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "handoff.already-claimed",
  );
  await assert.rejects(
    a.handoffs.complete(handoffRef, 0, "completed", A1),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "handoff.claim-lost",
  );
  assert.equal(
    (await b.handoffs.complete(handoffRef, 0, "completed", A2)).state,
    "completed",
  );
});
