import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { sweepDroppedCredentials } from "../../../src/server/connectors/state/custody-sweep.js";
import {
  connectionKey,
  handoffKey,
} from "../../../src/server/connectors/state/keys.js";
import type { StoredConnectionValue } from "../../../src/server/connectors/state/schemas.js";
import type { AsyncCeremonyStore } from "../../../src/server/persistence/index.js";
import {
  connectionRecord,
  credentialScope,
  sqliteFixture,
} from "../fixtures/state/records.js";

/*
 * What the custody sweep costs and what it says. It lists a tenant's
 * connections and opens only the ones that can hold a sign-in for a choice
 * (one that names a waiting sign-in, or waits on an input a person owes): a
 * tenant's idle connections cost the listing and nothing more. A failure on
 * one connection is counted and does not stop the others. A waiting sign-in
 * that custody no longer holds is let go of on the connection once, so it is
 * not looked at again on every call.
 */

const TENANT = "tenant-sweep";
const AT = 1_700_000_000_000;
const clock = () => AT;
const NEWER = "credential:newer-0123456789abcd";

/** The store, counting the transactions run through it. */
function counting(store: AsyncCeremonyStore) {
  const seen = { transactions: 0 };
  return {
    seen,
    store: {
      close: () => store.close(),
      transaction: (work) => {
        seen.transactions++;
        return store.transaction(work);
      },
    } as AsyncCeremonyStore,
  };
}

async function setup(t: TestContext) {
  const fixture = await sqliteFixture();
  t.after(() => fixture.close());
  const { store } = fixture;
  return { store, ports: createConnectorPorts(store, { now: clock }) };
}

test("a sweep of connections that wait on nothing makes no transaction beyond the listing", async (t) => {
  const { store, ports } = await setup(t);
  for (let n = 0; n < 121; n++)
    await ports.connections.create(connectionRecord({ tenantId: TENANT }));
  const watched = counting(store);
  const report = await sweepDroppedCredentials(watched.store, TENANT, {
    now: clock,
  });
  // Two pages of 100 and nothing for the 121 connections themselves.
  assert.ok(
    watched.seen.transactions <= 3,
    `${watched.seen.transactions} transactions for 121 idle connections`,
  );
  assert.deepEqual(report, { swept: 0, failed: 0 });
});

/** A connection that names a waiting sign-in custody does not hold, and has no open choice. */
async function staleWaiting(ports: ReturnType<typeof createConnectorPorts>) {
  const record = connectionRecord({
    tenantId: TENANT,
    state: { pendingSession: "credential:gone-0123456789abcdef" },
  });
  await ports.connections.create(record);
  return record;
}

const stateOf = async (store: AsyncCeremonyStore, connectionRef: string) =>
  (
    await store.transaction((tx) =>
      tx.get<StoredConnectionValue>(connectionKey(TENANT, connectionRef)),
    )
  )?.value.record.state;

test("a waiting sign-in that custody no longer holds is cleared from the connection, and not looked at again", async (t) => {
  const { store, ports } = await setup(t);
  const record = await staleWaiting(ports);
  const idle = connectionRecord({ tenantId: TENANT });
  await ports.connections.create(idle);

  const first = await sweepDroppedCredentials(store, TENANT, { now: clock });
  const state = await stateOf(store, record.connectionRef);
  assert.equal(state?.["pendingSession"], null, "the stale entry is cleared");
  assert.equal(
    state?.["droppedCredentials"],
    undefined,
    "nothing is noted: there is nothing to drop",
  );

  assert.deepEqual(first, { swept: 0, failed: 0 });

  const watched = counting(store);
  await sweepDroppedCredentials(watched.store, TENANT, { now: clock });
  assert.ok(
    watched.seen.transactions <= 3,
    `${watched.seen.transactions} transactions on the second sweep: the connection is opened again`,
  );
});

test("a write that lands between the look and the clearing decides instead", async (t) => {
  const { store, ports } = await setup(t);
  const record = await staleWaiting(ports);
  // The record is rewritten (a reconnect, a cancel) right after the sweep listed it.
  let listed = false;
  const writing = {
    close: () => store.close(),
    transaction: async (work) => {
      const result = await store.transaction(work);
      if (!listed) {
        listed = true;
        await store.transaction(async (tx) => {
          const key = connectionKey(TENANT, record.connectionRef);
          const stored = await tx.get<StoredConnectionValue>(key);
          await tx.put(
            key,
            {
              ...stored!.value,
              record: {
                ...stored!.value.record,
                state: { pendingSession: NEWER },
                revision: stored!.revision + 1,
              },
            },
            stored!.revision,
          );
        });
      }
      return result;
    },
  } as AsyncCeremonyStore;
  await sweepDroppedCredentials(writing, TENANT, { now: clock });
  assert.equal(
    (await stateOf(store, record.connectionRef))?.["pendingSession"],
    NEWER,
    "the newer write stands",
  );
});

test("a failure on one connection is counted and the others are still swept", async (t) => {
  const { store, ports } = await setup(t);
  const noted = connectionRecord({ tenantId: TENANT });
  const ref = await ports.credentials.store(
    credentialScope(TENANT, { connectionRef: noted.connectionRef }),
    { token: "vtok_dummy_marker_0123456789abcdef" },
  );
  await ports.connections.create({
    ...noted,
    state: { droppedCredentials: [ref] },
  });
  // A connection that waits on an input whose handoff cannot be read.
  const broken = connectionRecord({
    tenantId: TENANT,
    lifecycle: "human-required",
    handoff: {
      handoffRef: "handoff:unreadable-0123456789abcdef",
      kind: "input-required",
      state: "issued",
      presentation: "in-app",
      generation: 0,
      expiresAt: new Date(AT + 600_000).toISOString(),
    },
  } as Parameters<typeof connectionRecord>[0]);
  await ports.connections.create(broken);
  await store.transaction((tx) =>
    tx.put(
      handoffKey(TENANT, "handoff:unreadable-0123456789abcdef"),
      { not: "a handoff" },
      null,
    ),
  );

  assert.deepEqual(
    await sweepDroppedCredentials(store, TENANT, { now: clock }),
    { swept: 1, failed: 1 },
  );
});
