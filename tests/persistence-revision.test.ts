import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
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

/*
 * A fence names one lease on a key. Three ways the store could let a fence
 * act on a lease that is not, or is no longer, its own; each is a rule of
 * verification/persistence/Fence.tla (rules 5, 6 and 7).
 */

const longest = 300_000;
const outcomeOf = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ value }) as const,
    (error: unknown) => ({ error }) as const,
  );

/** The claim row of `id`, read past the store. */
async function claimRow(pool: Pool, id: string) {
  const rows = await pool.query(
    "SELECT generation, worker, expires FROM ceremony_claims WHERE tenant=$1 AND kind=$2 AND id=$3",
    ["tenant", "run", id],
  );
  return rows.rows[0] as
    { generation: string; worker: string; expires: string } | undefined;
}

/**
 * Every statement `store` sends goes through `before` first, which may run
 * other work and returns the text to send.
 */
function beforeEachStatement(
  store: PostgresCeremonyStore,
  before: (sql: string) => Promise<string>,
) {
  const pool = (store as unknown as { pool: Pool }).pool;
  pool.on("connect", (client) => {
    const query = client.query.bind(client) as (
      sql: string,
      args?: unknown[],
    ) => Promise<unknown>;
    (client as unknown as { query: typeof query }).query = async (sql, args) =>
      query(await before(sql), args);
  });
}

test("rule 5: a heartbeat extends only its own lease, also with no row lock to keep the row still", async () => {
  const fixture = await postgresFixture();
  const holder = new PostgresCeremonyStore(fixture.config, ring);
  const other = new PostgresCeremonyStore(fixture.config, ring);
  const raw = new Pool(fixture.config);
  try {
    await other.migrate();
    const id = "heartbeat";
    let armed = false;
    let newer: Awaited<ReturnType<typeof claimRow>>;
    // The row locks of the holder's statements are taken out, so nothing but
    // the heartbeat's own UPDATE stands between the takeover and that UPDATE.
    // Right before it, the key is cancelled and claimed by a new holder with
    // the same worker string.
    beforeEachStatement(holder, async (sql) => {
      const unlocked = sql.replace(
        /\s+FOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b(?:\s+NOWAIT)?/gi,
        "",
      );
      if (armed && /^\s*UPDATE\s+ceremony_claims\b/i.test(unlocked)) {
        armed = false;
        await other.transaction((tx) => tx.cancel(key(id)));
        await other.transaction((tx) =>
          tx.claim(key(id), "same-workload", longest),
        );
        newer = await claimRow(raw, id);
      }
      return unlocked;
    });
    const fence = await holder.transaction((tx) =>
      tx.claim(key(id), "same-workload", longest),
    );
    armed = true;
    const heartbeat = await outcomeOf(
      holder.transaction((tx) => tx.heartbeat(fence, 1_000)),
    );
    assert.equal(armed, false, "the heartbeat sent no UPDATE of the claim");
    assert.ok(newer, "the new holder's claim row was not read");
    assert.deepEqual(
      await claimRow(raw, id),
      newer,
      "the old holder's heartbeat changed the new holder's lease",
    );
    assert.ok(
      "error" in heartbeat && heartbeat.error instanceof PersistenceConflict,
      "the heartbeat of a lease that was taken over did not fail with PersistenceConflict",
    );
  } finally {
    await raw.end();
    await holder.close();
    await other.close();
    await fixture.close();
  }
});

test("rule 6: a claim whose upsert waited past its duration returns no fence that has already run out", async () => {
  const fixture = await postgresFixture();
  const a = new PostgresCeremonyStore(fixture.config, ring);
  const b = new PostgresCeremonyStore(fixture.config, ring);
  try {
    await a.migrate();
    const id = "slow-claim";
    const held = await a.transaction((tx) =>
      tx.claim(key(id), "holder", longest),
    );
    let asserted!: () => void;
    const untilAsserted = new Promise<void>((done) => (asserted = done));
    let release!: () => void;
    const untilRelease = new Promise<void>((done) => (release = done));
    // The holder's fenced transaction holds the claim row, then releases the
    // key and commits.
    const fenced = a.transaction(async (tx) => {
      await tx.assertFence(held);
      asserted();
      await untilRelease;
      await tx.cancel(key(id));
    });
    await untilAsserted;
    // The claim reads the clock now, and its upsert waits on the row for
    // longer than the duration it asks for.
    const claimed = outcomeOf(
      b.transaction((tx) => tx.claim(key(id), "late", 1_000)),
    );
    await delay(1_500);
    release();
    await fenced;
    const late = await claimed;
    if ("error" in late)
      assert.ok(
        late.error instanceof PersistenceConflict,
        `the late claim failed with ${String(late.error)}, not PersistenceConflict`,
      );
    else
      await assert.doesNotReject(
        b.transaction((tx) => tx.assertFence(late.value)),
        "claim returned a fence whose lease had already run out",
      );
  } finally {
    await a.close();
    await b.close();
    await fixture.close();
  }
});

test("rule 7: a restored store refuses every fence handed out before the restore", async () => {
  const fixture = await postgresFixture();
  const raw = new Pool(fixture.config);
  await raw.query("CREATE DATABASE restored");
  const first = new PostgresCeremonyStore(fixture.config, ring);
  const restored = new PostgresCeremonyStore(
    { ...fixture.config, database: "restored" },
    ring,
  );
  try {
    await first.migrate();
    await restored.migrate();
    // "kept" has a claim row in the backup; "later" is first claimed after it.
    await first.transaction((tx) => tx.claim(key("kept"), "same-workload", 1));
    await delay(20);
    const backup = await first.encryptedBackup();
    // The workers go on using the first store after the backup.
    await first.transaction((tx) => tx.cancel(key("kept")));
    const old = {
      kept: await first.transaction((tx) =>
        tx.claim(key("kept"), "same-workload", longest),
      ),
      later: await first.transaction((tx) =>
        tx.claim(key("later"), "same-workload", longest),
      ),
    };
    await restored.restoreEncryptedBackup(backup);
    for (const id of ["kept", "later"] as const) {
      const fresh = await restored.transaction((tx) =>
        tx.claim(key(id), "same-workload", longest),
      );
      await assert.doesNotReject(
        restored.transaction((tx) => tx.assertFence(fresh)),
        `the fence the restored store handed out for ${id} is refused`,
      );
      await assert.rejects(
        restored.transaction((tx) => tx.assertFence(old[id])),
        PersistenceConflict,
        `a fence for ${id} from before the restore passes on the restored store`,
      );
      await assert.rejects(
        restored.transaction(async (tx) => {
          await tx.assertFence(old[id]);
          await tx.put(key(id), { by: "old fence" }, null);
        }),
        PersistenceConflict,
        `a fence for ${id} from before the restore commits a write`,
      );
      assert.equal(
        await restored.transaction((tx) => tx.get(key(id))),
        undefined,
      );
    }
  } finally {
    await first.close();
    await restored.close();
    await raw.end();
    await fixture.close();
  }
});
