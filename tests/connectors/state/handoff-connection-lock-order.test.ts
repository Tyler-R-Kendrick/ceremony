import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import {
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
  type AsyncCeremonyStore,
} from "../../../src/server/persistence/index.js";
import { postgresFixture } from "../../fixtures/postgres.js";
import {
  actorFor,
  connectionRecord,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * One lock order for a connection and its handoffs: the handoff rows first,
 * then the connection row (state/handoff-settle.ts says why). On PostgreSQL
 * every read of a row locks it, and a claim reads the handoff and then the
 * connection; a writer that fenced the connection (a disconnect, a revoke or a
 * reconnect advance the generation, a drift invalidation, a recorded
 * disconnect) and then settled the connection's handoffs took the two rows the
 * other way round, and the database killed one of the two after its deadlock
 * timeout: the caller saw "Persistence operation unavailable". Here three
 * claimers work a handoff while four writers fence its connection, round after
 * round, for a bounded time: a claim that meets a fence is refused by name, and
 * nothing else may fail.
 */

const TENANT = "tenant-lock-order";
const LEASE_MS = 60_000;
const actor = actorFor(TENANT);

/** The refusals a claim and a fence give each other; a failed request is anything else. */
const failedRequest = (error: unknown) => !(error instanceof ConnectorError);

async function stores(backend: "postgres" | "sqlite", t: test.TestContext) {
  const keyring = stateKeyring();
  if (backend === "sqlite") {
    const store: AsyncCeremonyStore = new SQLiteCeremonyStore(
      ":memory:",
      keyring,
    );
    t.after(() => store.close());
    return store;
  }
  const database = await postgresFixture();
  const store = new PostgresCeremonyStore(database.config, keyring);
  await store.migrate();
  t.after(async () => {
    await store.close();
    await database.close();
  });
  return store;
}

type Ports = ReturnType<typeof createConnectorPorts>;
type Fence = (ports: Ports, ref: string, revision: number) => Promise<unknown>;

/** The writers that fence a connection and then settle its handoffs. */
const WRITERS: Record<string, Fence> = {
  "advanceGeneration (a disconnect, a revoke or a reconnect fences with it)": (
    ports,
    ref,
    revision,
  ) =>
    ports.connections.advanceGeneration(actor, ref, revision, "revoke.closing"),
  recordDisconnect: (ports, ref, revision) =>
    ports.connections.recordDisconnect(actor, ref, revision, {
      scope: "local",
      local: "applied",
      broker: "not-attempted",
      upstream: "not-attempted",
    }),
  invalidateForDrift: (ports, ref) =>
    ports.drift.invalidateForDrift(actor, ref, { sourceDigestChanged: true }),
};

/** Three claimers against `fences` writers, round after round, for `ms`; the failed requests, by message. */
async function contend(
  ports: Ports,
  fences: Fence[],
  ms: number,
): Promise<{ rounds: number; failures: [string, number][] }> {
  const failures = new Map<string, number>();
  const note = (error: unknown) => {
    if (!failedRequest(error)) return;
    const what = String((error as Error)?.message ?? error);
    failures.set(what, (failures.get(what) ?? 0) + 1);
  };
  let rounds = 0;
  let turn = 0;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    rounds++;
    const record = connectionRecord({ tenantId: TENANT });
    const ref = record.connectionRef;
    await ports.connections.create(record);
    const { handoffRef } = await ports.handoffs.issue({
      actor,
      connectionRef: ref,
      bindingRef: record.bindingRef,
      generation: 0,
      kind: "input-required",
      presentation: "in-app",
      expiresAt: Date.now() + 3_600_000,
      intent: "conformance.select",
      private: { fields: '["choice"]' },
    });
    let fencing = fences.length;
    const fenced = (fence: Fence) => async () => {
      try {
        const found = await ports.connections.get(actor, ref);
        await fence(ports, ref, found!.revision);
      } catch (error) {
        note(error);
      } finally {
        fencing--;
      }
    };
    const claimer = async () => {
      for (let n = 0; fencing > 0 && n < 100; n++) {
        const attempt = `attempt-${++turn}`.padEnd(12, "x");
        try {
          const outcome = await ports.handoffs.claim(
            handoffRef,
            0,
            String(turn).padStart(64, "0"),
            attempt,
            LEASE_MS,
          );
          if (outcome === "claimed")
            await ports.handoffs.release(handoffRef, attempt);
        } catch (error) {
          note(error);
        }
      }
    };
    await Promise.all([
      claimer(),
      claimer(),
      claimer(),
      ...fences.map((f) => fenced(f)()),
    ]);
  }
  return { rounds, failures: [...failures] };
}

for (const backend of ["postgres", "sqlite"] as const) {
  for (const [name, fence] of Object.entries(WRITERS))
    test(`claims of a handoff and ${name} of its connection run side by side without a failed request (${backend})`, async (t) => {
      const ports = createConnectorPorts(await stores(backend, t));
      const { rounds, failures } = await contend(
        ports,
        [fence, fence, fence],
        2_500,
      );
      t.diagnostic(`${rounds} rounds`);
      assert.deepEqual(failures, [], `${rounds} rounds`);
    });

  test(`claims of a handoff and every writer that fences its connection at once run without a failed request (${backend})`, async (t) => {
    const ports = createConnectorPorts(await stores(backend, t));
    const { rounds, failures } = await contend(
      ports,
      [...Object.values(WRITERS), WRITERS["recordDisconnect"]!],
      4_000,
    );
    t.diagnostic(`${rounds} rounds`);
    assert.deepEqual(failures, [], `${rounds} rounds`);
  });
}
