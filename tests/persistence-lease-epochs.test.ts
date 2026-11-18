import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import {
  LeaseGenerationsExhausted,
  PersistenceConflict,
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
  type Fence,
} from "../src/server/persistence/index.js";
import { postgresFixture } from "./fixtures/postgres.js";

const ring = { current: "first", keys: { first: randomBytes(32) } };
const key = (id: string) => ({ tenant: "tenant", kind: "run" as const, id });
const longest = 300_000;
const span = 2 ** 22;

/**
 * A store's claim generations lie in the span of its lease epoch: 0 for a
 * store that was never restored, and for a restored store the second of the
 * database clock its restore ran in. These tests hold the workers of one
 * restored store to it when they reach another store.
 */

/** Creates databases `names` on the fixture and a migrated store on each. */
async function stores(
  config: Awaited<ReturnType<typeof postgresFixture>>["config"],
  names: string[],
) {
  const raw = new Pool(config);
  raw.on("error", () => {});
  try {
    for (const name of names) await raw.query(`CREATE DATABASE ${name}`);
  } finally {
    await raw.end();
  }
  const opened = names.map(
    (database) => new PostgresCeremonyStore({ ...config, database }, ring),
  );
  for (const store of opened) await store.migrate();
  return opened;
}

async function refuses(store: PostgresCeremonyStore, fence: Fence) {
  await assert.rejects(
    store.transaction((tx) => tx.assertFence(fence)),
    PersistenceConflict,
    `a fence of generation ${fence.generation} from another store passes`,
  );
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.assertFence(fence);
      await tx.put(key(fence.id), { by: "foreign fence" }, null);
    }),
    PersistenceConflict,
  );
  assert.equal(
    await store.transaction((tx) => tx.get(key(fence.id))),
    undefined,
  );
}

test("two restores of one backup, a second apart, hand out no generation in common", async () => {
  const fixture = await postgresFixture();
  const source = new PostgresCeremonyStore(fixture.config, ring);
  const opened: PostgresCeremonyStore[] = [];
  try {
    await source.migrate();
    opened.push(
      ...(await stores(fixture.config, ["first_restore", "second_restore"])),
    );
    const [first, second] = opened as [
      PostgresCeremonyStore,
      PostgresCeremonyStore,
    ];
    await source.transaction((tx) => tx.claim(key("kept"), "same-workload", 1));
    await delay(20);
    const backup = await source.encryptedBackup();
    await first.restoreEncryptedBackup(backup);
    // The workers move to the first restored store and claim there.
    const held = {
      kept: await first.transaction((tx) =>
        tx.claim(key("kept"), "same-workload", longest),
      ),
      later: await first.transaction((tx) =>
        tx.claim(key("later"), "same-workload", longest),
      ),
    };
    // That store is lost; the same backup is restored again, a second later.
    await delay(1_100);
    await second.restoreEncryptedBackup(backup);
    for (const id of ["kept", "later"] as const) {
      const fresh = await second.transaction((tx) =>
        tx.claim(key(id), "same-workload", longest),
      );
      assert.notEqual(fresh.generation, held[id].generation);
      await refuses(second, held[id]);
    }
  } finally {
    await source.close();
    for (const store of opened) await store.close();
    await fixture.close();
  }
});

test("a backup of a restored store, restored at once, refuses the restored store's fences", async () => {
  const fixture = await postgresFixture();
  const source = new PostgresCeremonyStore(fixture.config, ring);
  const opened: PostgresCeremonyStore[] = [];
  try {
    await source.migrate();
    opened.push(...(await stores(fixture.config, ["restored", "again"])));
    const [restored, again] = opened as [
      PostgresCeremonyStore,
      PostgresCeremonyStore,
    ];
    await restored.restoreEncryptedBackup(await source.encryptedBackup());
    await restored.transaction((tx) =>
      tx.claim(key("kept"), "same-workload", 1),
    );
    await delay(20);
    const backup = await restored.encryptedBackup();
    assert.equal(backup.schemaVersion, 3);
    await restored.transaction((tx) => tx.cancel(key("kept")));
    const held = {
      kept: await restored.transaction((tx) =>
        tx.claim(key("kept"), "same-workload", longest),
      ),
      later: await restored.transaction((tx) =>
        tx.claim(key("later"), "same-workload", longest),
      ),
    };
    // Within the second of the first restore: the restore waits for the next.
    await again.restoreEncryptedBackup(backup);
    for (const id of ["kept", "later"] as const) {
      const fresh = await again.transaction((tx) =>
        tx.claim(key(id), "same-workload", longest),
      );
      assert.ok(fresh.generation > held[id].generation);
      await refuses(again, held[id]);
    }
  } finally {
    await source.close();
    for (const store of opened) await store.close();
    await fixture.close();
  }
});

test("SQLite: a heartbeat of a lease that was taken over fails and leaves the new lease", async () => {
  const store = new SQLiteCeremonyStore(":memory:", ring);
  try {
    const old = await store.transaction((tx) =>
      tx.claim(key("beat"), "same-workload", longest),
    );
    await store.transaction((tx) => tx.cancel(key("beat")));
    const fresh = await store.transaction((tx) =>
      tx.claim(key("beat"), "same-workload", 1_000),
    );
    await assert.rejects(
      store.transaction((tx) => tx.heartbeat(old, longest)),
      PersistenceConflict,
    );
    await store.transaction((tx) => tx.heartbeat(fresh, 2_000));
    await store.transaction((tx) => tx.assertFence(fresh));
  } finally {
    await store.close();
  }
});

test("SQLite: a key at the end of its epoch's span is refused a claim, and its cancel refuses every fence", async () => {
  const store = new SQLiteCeremonyStore(":memory:", ring);
  const db = (store as unknown as { db: DatabaseSync }).db;
  try {
    await store.transaction((tx) => tx.cancel(key("full")));
    db.prepare(
      "UPDATE ceremony_claims SET generation=? WHERE tenant='tenant' AND kind='run' AND id='full'",
    ).run(span - 2);
    const last = await store.transaction((tx) =>
      tx.claim(key("full"), "same-workload", longest),
    );
    assert.equal(last.generation, span - 1);
    await store.transaction((tx) => tx.cancel(key("full")));
    await assert.rejects(
      store.transaction((tx) => tx.assertFence(last)),
      PersistenceConflict,
    );
    await assert.rejects(
      store.transaction((tx) =>
        tx.claim(key("full"), "same-workload", longest),
      ),
      LeaseGenerationsExhausted,
    );
    assert.equal(
      Number(
        (
          db
            .prepare("SELECT generation FROM ceremony_claims WHERE id='full'")
            .get() as { generation: number }
        ).generation,
      ),
      span - 1,
    );
  } finally {
    await store.close();
  }
});
