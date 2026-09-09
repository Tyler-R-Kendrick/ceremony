import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  SQLiteCeremonyStore,
  PersistenceConflict,
} from "../../src/server/persistence/index.js";

test("AC-28: a restarted worker with the same workload identity cannot commit its old generation", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const key = { tenant: "tenant", kind: "run" as const, id: "run" };
  const previous = await store.transaction((tx) =>
    tx.claim(key, "same-workload", 60000),
  );
  await store.transaction((tx) => tx.cancel(key));
  const current = await store.transaction((tx) =>
    tx.claim(key, "same-workload", 60000),
  );
  assert.equal(current.worker, previous.worker);
  assert.ok(current.generation > previous.generation);
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.assertFence(previous);
      await tx.put(key, { forbidden: true }, null);
    }),
    PersistenceConflict,
  );
  assert.equal(await store.transaction((tx) => tx.get(key)), undefined);
  await store.transaction(async (tx) => {
    await tx.assertFence(current);
    await tx.put(key, { accepted: true }, null);
  });
  assert.deepEqual((await store.transaction((tx) => tx.get(key)))!.value, {
    accepted: true,
  });
});
