import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import {
  PersistenceConflict,
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
  retiredSlot,
  retiredSlots,
  type AsyncCeremonyStore,
} from "../src/server/persistence/index.js";
import { postgresFixture } from "./fixtures/postgres.js";

const ring = { current: "first", keys: { first: randomBytes(32) } };
const key = (id: string) => ({ tenant: "tenant", kind: "run" as const, id });

/** Creates the record and writes it until it is at `revision`. */
async function writeUpTo(
  store: AsyncCeremonyStore,
  id: string,
  revision: number,
) {
  let at = await store.transaction((tx) => tx.put(key(id), { at: 1 }, null));
  while (at < revision) {
    const next = at;
    at = await store.transaction((tx) =>
      tx.put(key(id), { at: next + 1 }, next),
    );
  }
  return at;
}

/** An id whose key is in the slot of `id`'s key, and one whose key is not. */
function neighbours(id: string) {
  const slot = retiredSlot(key(id));
  let same: string | undefined, other: string | undefined;
  for (let n = 0; !same || !other; n++) {
    const candidate = `${id}-${n}`;
    if (retiredSlot(key(candidate)) === slot) same ??= candidate;
    else other ??= candidate;
  }
  return { same, other };
}

test("P-F1: a key in the slot of a deleted record starts above it, a key in another slot at 1", async () => {
  const store = new SQLiteCeremonyStore(":memory:", ring);
  try {
    const gone = await writeUpTo(store, "gone", 4);
    await store.transaction((tx) => tx.delete(key("gone"), gone));
    const { same, other } = neighbours("gone");
    assert.equal(
      await store.transaction((tx) => tx.put(key(same), {}, null)),
      gone + 1,
    );
    assert.equal(
      await store.transaction((tx) => tx.put(key(other), {}, null)),
      1,
    );
    // The slot rises with the next delete in it.
    await store.transaction((tx) => tx.delete(key(same), gone + 1));
    assert.equal(
      await store.transaction((tx) => tx.put(key("gone"), {}, null)),
      gone + 2,
    );
  } finally {
    await store.close();
  }
});

test("P-F1: a backup carries the retired slots into the restored store", async () => {
  const source = await postgresFixture(),
    target = await postgresFixture();
  const first = new PostgresCeremonyStore(source.config, ring);
  const restored = new PostgresCeremonyStore(target.config, ring);
  try {
    await first.migrate();
    await restored.migrate();
    const gone = await writeUpTo(first, "gone", 4);
    await first.transaction((tx) => tx.delete(key("gone"), gone));
    const kept = await writeUpTo(first, "kept", 2);
    // A key deleted and created again before the backup.
    const back = await writeUpTo(first, "back", 2);
    await first.transaction((tx) => tx.delete(key("back"), back));
    const backAgain = await first.transaction((tx) =>
      tx.put(key("back"), { at: "again" }, null),
    );
    assert.equal(backAgain, back + 1);
    const backup = await first.encryptedBackup();
    assert.equal(backup.schemaVersion, 2);
    const slots = new Map(
      [
        [retiredSlot(key("back")), back],
        [retiredSlot(key("gone")), gone],
      ].sort(([a], [b]) => a! - b!) as Array<[number, number]>,
    );
    assert.deepEqual(
      backup.schemaVersion === 2 && backup.retired,
      [...slots].map(([slot, revision]) => ({ slot, revision })),
    );
    await restored.restoreEncryptedBackup(backup);

    // The records in the backup keep their revisions.
    assert.equal(
      (await restored.transaction((tx) => tx.get(key("kept"))))?.revision,
      kept,
    );
    assert.equal(
      (await restored.transaction((tx) => tx.get(key("back"))))?.revision,
      backAgain,
    );
    for (let stale = 1; stale <= back; stale++)
      await assert.rejects(
        restored.transaction((tx) => tx.put(key("back"), {}, stale)),
        PersistenceConflict,
      );
    // The deleted record, created again after the restore, starts above
    // every revision it had in the source store.
    const again = await restored.transaction((tx) =>
      tx.put(key("gone"), { at: "again" }, null),
    );
    assert.equal(again, gone + 1);
    for (let stale = 1; stale <= gone; stale++)
      await assert.rejects(
        restored.transaction((tx) => tx.put(key("gone"), {}, stale)),
        PersistenceConflict,
      );
    // A key in a slot that saw no delete still starts at 1.
    const fresh = neighbours("gone").other;
    assert.ok(!slots.has(retiredSlot(key(fresh))));
    assert.equal(
      await restored.transaction((tx) => tx.put(key(fresh), {}, null)),
      1,
    );
    // A second backup of the restored store carries the slot on.
    await restored.transaction((tx) => tx.delete(key("gone"), again));
    const second = await restored.encryptedBackup();
    assert.ok(second.schemaVersion === 2);
    assert.ok(
      second.retired.some(
        (r) => r.slot === retiredSlot(key("gone")) && r.revision === again,
      ),
    );
  } finally {
    await first.close();
    await restored.close();
    await source.close();
    await target.close();
  }
});

test("P-F1: deletes of more keys than there are slots keep the store backed up", async () => {
  const source = await postgresFixture();
  const store = new PostgresCeremonyStore(source.config, ring);
  const admin = new Pool(source.config);
  try {
    await store.migrate();
    const count = retiredSlots + 500;
    await store.transaction(async (tx) => {
      for (let n = 0; n < count; n++) {
        const id = `many-${n}`;
        const revision = await tx.put(key(id), {}, null);
        await tx.delete(key(id), revision);
      }
    });
    const rows = await admin.query(
      "SELECT COUNT(*)::int AS count FROM ceremony_retired_slots",
    );
    assert.ok(rows.rows[0].count <= retiredSlots);
    const backup = await store.encryptedBackup();
    assert.ok(backup.schemaVersion === 2);
    assert.equal(backup.retired.length, rows.rows[0].count);
  } finally {
    await store.close();
    await admin.end();
    await source.close();
  }
});

test("P-F1: a restore refuses a slot given twice and takes a version 1 backup", async () => {
  const source = await postgresFixture(),
    target = await postgresFixture();
  const first = new PostgresCeremonyStore(source.config, ring);
  const restored = new PostgresCeremonyStore(target.config, ring);
  try {
    await first.migrate();
    await restored.migrate();
    const kept = await writeUpTo(first, "kept", 3);
    const backup = await first.encryptedBackup();
    assert.ok(backup.schemaVersion === 2);
    await assert.rejects(
      restored.restoreEncryptedBackup({
        ...backup,
        retired: [
          { slot: 7, revision: 2 },
          { slot: 7, revision: 5 },
        ],
      }),
      /maintenance refused/,
    );
    await assert.rejects(
      restored.restoreEncryptedBackup({
        ...backup,
        retired: [{ slot: retiredSlots, revision: 2 }],
      }),
      /invalid or unavailable/,
    );
    await restored.restoreEncryptedBackup({
      schemaVersion: 1,
      records: backup.records,
      claims: backup.claims,
    });
    assert.equal(
      (await restored.transaction((tx) => tx.get(key("kept"))))?.revision,
      kept,
    );
    assert.equal(
      await restored.transaction((tx) => tx.put(key("new"), {}, null)),
      1,
    );
  } finally {
    await first.close();
    await restored.close();
    await source.close();
    await target.close();
  }
});

test("P-F1: a SQLite store made before slots were kept gains the table and keeps its records", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ceremony-revision-"));
  const path = join(folder, "store.db");
  try {
    // A store with the tables of the earlier schema only.
    const before = new SQLiteCeremonyStore(path, ring);
    const top = await writeUpTo(before, "kept", 5);
    await before.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE ceremony_retired_slots");
    raw.close();

    const after = new SQLiteCeremonyStore(path, ring);
    try {
      assert.equal(
        await after.transaction((tx) => tx.put(key("kept"), {}, top)),
        top + 1,
      );
      await after.transaction((tx) => tx.delete(key("kept"), top + 1));
      assert.equal(
        await after.transaction((tx) => tx.put(key("kept"), {}, null)),
        top + 2,
      );
    } finally {
      await after.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("P-F1: on PostgreSQL a create that waited for a delete of the key starts above it", async () => {
  const fixture = await postgresFixture();
  const a = new PostgresCeremonyStore(fixture.config, ring);
  const b = new PostgresCeremonyStore(fixture.config, ring);
  const admin = new Pool(fixture.config);
  try {
    await a.migrate();
    const last = await writeUpTo(a, "raced", 3);
    let commit!: () => void;
    const untilCommit = new Promise<void>((done) => (commit = done));
    let deleted!: () => void;
    const untilDeleted = new Promise<void>((done) => (deleted = done));
    const deleting = a.transaction(async (tx) => {
      await tx.delete(key("raced"), last);
      deleted();
      await untilCommit;
    });
    await untilDeleted;
    let done = false;
    const creating = b
      .transaction((tx) => tx.put(key("raced"), { at: "again" }, null))
      .finally(() => (done = true));
    await delay(300);
    // The create read the key's slot before the delete committed, and its
    // INSERT waits for the deleting transaction.
    assert.equal(done, false);
    const waiting = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
    );
    assert.ok(waiting.rowCount! > 0);
    commit();
    await deleting;
    const created = await creating;
    assert.ok(created > last, `revision ${created} was used before`);
    assert.deepEqual(await a.transaction((tx) => tx.get(key("raced"))), {
      revision: created,
      value: { at: "again" },
    });
    await assert.rejects(
      a.transaction((tx) => tx.put(key("raced"), {}, last)),
      PersistenceConflict,
    );
  } finally {
    await a.close();
    await b.close();
    await admin.end();
    await fixture.close();
  }
});
