import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { connectionKey } from "../../../src/server/connectors/state/keys.js";
import type { StoredConnectionValue } from "../../../src/server/connectors/state/schemas.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
} from "../../../src/server/persistence/index.js";
import type { CeremonyBackend } from "../doubles/ceremony-backend.js";
import { awsSetup, connectAndApprove, handoffRefOf } from "./harness.js";

/*
 * Reading a connection takes no lock on its handoff. PostgreSQL's `get` is a
 * `SELECT ... FOR UPDATE`, and a claim locks the handoff row and then the
 * connection row; a status read that locked the connection row and then the
 * handoff row would be the opposite order, and the two deadlock: the database
 * kills one after its deadlock timeout and the caller sees a failed request.
 * The status read of a connection that waits on an input a person owes is the
 * hottest path there is, and a joined waiter polls beside its own repeated
 * claims, so the order is held on every read (the first test, on any store)
 * and under real contention (the second, on PostgreSQL and SQLite).
 */

/** Writes the connection back as the code before `pendingSession` wrote it. */
async function withoutPendingSession(
  store: AsyncCeremonyStore,
  tenantId: string,
  connectionRef: string,
) {
  await store.transaction(async (tx) => {
    const key = connectionKey(tenantId, connectionRef);
    const stored = await tx.get<StoredConnectionValue>(key);
    if (!stored) throw new Error("no such connection");
    const { pendingSession, ...state } = stored.value.record.state;
    assert.equal(typeof pendingSession, "string", "the choice was recorded");
    await tx.put(
      key,
      {
        ...stored.value,
        record: {
          ...stored.value.record,
          state,
          revision: stored.revision + 1,
        },
      },
      stored.revision,
    );
  });
}

/** The same store, noting the kind of every record any transaction reads. */
function recording(store: AsyncCeremonyStore) {
  const reads: string[] = [];
  const watched = (tx: AsyncTransaction): AsyncTransaction =>
    new Proxy(tx, {
      get(target, property) {
        if (property === "get")
          return (key: Parameters<AsyncTransaction["get"]>[0]) => {
            reads.push(key.kind);
            return target.get(key);
          };
        const member = Reflect.get(target, property) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  return {
    reads,
    store: {
      close: () => store.close(),
      transaction: (work) => store.transaction((tx) => work(watched(tx))),
    } as AsyncCeremonyStore,
  };
}

test("reading a connection that waits on a person's input reads no handoff", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndApprove(setup);
  await withoutPendingSession(
    setup.store,
    setup.person.tenantId,
    connectionRef,
  );
  const watch = recording(setup.store);
  const ports = createConnectorPorts(watch.store, { now: setup.clock });
  const found = await ports.connections.get(setup.person, connectionRef);
  assert.equal(found?.record.handoff?.kind, "input-required");
  assert.ok(watch.reads.includes("connector-connection"), "it read the record");
  assert.deepEqual(
    watch.reads.filter((kind) => kind === "connector-handoff"),
    [],
    "a status read never locks the handoff row",
  );
});

const RUN_MS = 5_000;

for (const backend of ["postgres", "sqlite"] as CeremonyBackend[])
  test(`status reads and claims of one handoff run side by side without a failed request (${backend})`, async (t) => {
    const setup = await awsSetup(t, { backend });
    const { connectionRef, polled } = await connectAndApprove(setup);
    await withoutPendingSession(
      setup.store,
      setup.person.tenantId,
      connectionRef,
    );
    const handoffRef = handoffRefOf(polled);
    const { generation } = await setup.record(connectionRef);
    const failures = new Map<string, number>();
    let polls = 0;
    let turn = 0;
    const note = (error: unknown) => {
      const detail = String(
        (error as { detail?: unknown })?.detail ??
          (error as Error | undefined)?.message ??
          error,
      );
      failures.set(detail, (failures.get(detail) ?? 0) + 1);
    };
    const until = Date.now() + RUN_MS;
    const poller = async () => {
      while (Date.now() < until)
        try {
          await setup.ports.connections.get(setup.person, connectionRef);
          polls++;
        } catch (error) {
          note(error);
        }
    };
    const claimer = async () => {
      while (Date.now() < until) {
        const attempt = `attempt-${++turn}`.padEnd(12, "x");
        const digest = String(turn).padStart(64, "0");
        try {
          const outcome = await setup.ports.handoffs.claim(
            handoffRef,
            generation,
            digest,
            attempt,
            60_000,
          );
          if (outcome === "claimed")
            await setup.ports.handoffs.release(handoffRef, attempt);
        } catch (error) {
          note(error);
        }
      }
    };
    await Promise.all([
      poller(),
      poller(),
      poller(),
      poller(),
      claimer(),
      claimer(),
      claimer(),
    ]);
    // A claim that meets another's is refused by name; anything else is a failed request.
    failures.delete("handoff.already-claimed");
    assert.deepEqual([...failures], [], "no read or claim failed");
    assert.ok(polls > 0, "the status reads were answered");
  });
