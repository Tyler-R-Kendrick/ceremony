import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  PersistenceConflict,
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
  type AsyncCeremonyStore,
} from "../src/server/persistence/index.js";
import { postgresFixture } from "./fixtures/postgres.js";

const ring = { current: "first", keys: { first: randomBytes(32) } };
const key = (id: string) => ({ tenant: "tenant", kind: "run" as const, id });

/**
 * A revision names the version of a record a caller read. A caller that read
 * a record and holds the revision across transactions must never write or
 * delete through it once the record was deleted and created again: the
 * version it read is gone. So a key never takes a revision it had before.
 */

/** Creates the record, reads it at revision 1, deletes it, creates it again. */
async function recreated(store: AsyncCeremonyStore, id: string) {
  await store.transaction((tx) => tx.put(key(id), { version: "first" }, null));
  const read = (await store.transaction((tx) => tx.get(key(id))))!;
  assert.equal(read.revision, 1);
  await store.transaction((tx) => tx.delete(key(id), read.revision));
  const again = await store.transaction((tx) =>
    tx.put(key(id), { version: "second" }, null),
  );
  return { read, again };
}

async function revisionsNeverRepeat(t: TestContext, store: AsyncCeremonyStore) {
  await t.test(
    "a put with the revision read before the delete is refused",
    async () => {
      const { read, again } = await recreated(store, "stale-put");
      await assert.rejects(
        store.transaction((tx) =>
          tx.put(
            key("stale-put"),
            { version: "based on first" },
            read.revision,
          ),
        ),
        PersistenceConflict,
      );
      assert.deepEqual(
        await store.transaction((tx) => tx.get(key("stale-put"))),
        {
          revision: again,
          value: { version: "second" },
        },
      );
    },
  );

  await t.test(
    "a delete with the revision read before the delete is refused",
    async () => {
      const { read, again } = await recreated(store, "stale-delete");
      await assert.rejects(
        store.transaction((tx) =>
          tx.delete(key("stale-delete"), read.revision),
        ),
        PersistenceConflict,
      );
      assert.deepEqual(
        await store.transaction((tx) => tx.get(key("stale-delete"))),
        { revision: again, value: { version: "second" } },
      );
    },
  );

  await t.test(
    "no revision of an earlier life of the key comes back",
    async () => {
      const id = "lives";
      const seen: number[] = [];
      const { read, again } = await recreated(store, id);
      seen.push(read.revision);
      assert.ok(
        !seen.includes(again),
        `the record created again took revision ${again}, which it had before`,
      );
      seen.push(again);
      // The current revision still writes, and the revision it gives is new.
      const updated = await store.transaction((tx) =>
        tx.put(key(id), { version: "third" }, again),
      );
      assert.ok(!seen.includes(updated), `revision ${updated} was used before`);
      seen.push(updated);
      await store.transaction((tx) => tx.delete(key(id), updated));
      const last = await store.transaction((tx) =>
        tx.put(key(id), { version: "fourth" }, null),
      );
      assert.ok(!seen.includes(last), `revision ${last} was used before`);
      for (const stale of seen) {
        await assert.rejects(
          store.transaction((tx) =>
            tx.put(key(id), { version: "stale" }, stale),
          ),
          PersistenceConflict,
          `put with revision ${stale} after the record was created again`,
        );
        await assert.rejects(
          store.transaction((tx) => tx.delete(key(id), stale)),
          PersistenceConflict,
          `delete with revision ${stale} after the record was created again`,
        );
      }
      assert.deepEqual(await store.transaction((tx) => tx.get(key(id))), {
        revision: last,
        value: { version: "fourth" },
      });
    },
  );
}

test("P-F1: SQLite never gives a deleted and re-created record an old revision", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", ring);
  try {
    await revisionsNeverRepeat(t, store);
  } finally {
    await store.close();
  }
});

test("P-F1: PostgreSQL never gives a deleted and re-created record an old revision", async (t) => {
  const fixture = await postgresFixture();
  const store = new PostgresCeremonyStore(fixture.config, ring);
  try {
    await store.migrate();
    await revisionsNeverRepeat(t, store);
  } finally {
    await store.close();
    await fixture.close();
  }
});
