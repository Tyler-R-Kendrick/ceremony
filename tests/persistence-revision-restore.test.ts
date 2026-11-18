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

test("P-F1: the delete of one key does not raise the first revision of another", async () => {
  const store = new SQLiteCeremonyStore(":memory:", ring);
  try {
    const gone = await writeUpTo(store, "gone", 4);
    await store.transaction((tx) => tx.delete(key("gone"), gone));
    for (const id of ["fresh-1", "fresh-2", "fresh-3"])
      assert.equal(
        await store.transaction((tx) => tx.put(key(id), {}, null)),
        1,
      );
    assert.equal(
      await store.transaction((tx) => tx.put(key("gone"), {}, null)),
      gone + 1,
    );
  } finally {
    await store.close();
  }
});

test("P-F1: a key keeps its own last revision whatever other keys are deleted", async () => {
  const store = new SQLiteCeremonyStore(":memory:", ring);
  try {
    const lowAt = await writeUpTo(store, "low", 1);
    const highAt = await writeUpTo(store, "high", 5);
    await store.transaction((tx) => tx.delete(key("high"), highAt));
    await store.transaction((tx) => tx.delete(key("low"), lowAt));
    assert.equal(
      await store.transaction((tx) => tx.put(key("low"), {}, null)),
      lowAt + 1,
    );
    const again = await store.transaction((tx) =>
      tx.put(key("high"), {}, null),
    );
    assert.equal(again, highAt + 1);
    for (let stale = 1; stale <= highAt; stale++)
      await assert.rejects(
        store.transaction((tx) => tx.put(key("high"), {}, stale)),
        PersistenceConflict,
      );
  } finally {
    await store.close();
  }
});

test("P-F1: a key deleted, created and deleted again keeps its higher revision", async () => {
  const store = new SQLiteCeremonyStore(":memory:", ring);
  try {
    const first = await writeUpTo(store, "cycled", 3);
    await store.transaction((tx) => tx.delete(key("cycled"), first));
    const second = await store.transaction((tx) =>
      tx.put(key("cycled"), {}, null),
    );
    assert.equal(second, first + 1);
    // Deleted at a revision above the earlier one, the key keeps the higher.
    await store.transaction((tx) => tx.delete(key("cycled"), second));
    assert.equal(
      await store.transaction((tx) => tx.put(key("cycled"), {}, null)),
      second + 1,
    );
  } finally {
    await store.close();
  }
});

test("P-F1: a backup carries the revisions of deleted records into the restored store", async () => {
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
    // A key deleted and created again before the backup has no retired row.
    const back = await writeUpTo(first, "back", 2);
    await first.transaction((tx) => tx.delete(key("back"), back));
    const backAgain = await first.transaction((tx) =>
      tx.put(key("back"), { at: "again" }, null),
    );
    assert.equal(backAgain, back + 1);
    const backup = await first.encryptedBackup();
    assert.equal(backup.schemaVersion, 2);
    assert.deepEqual(backup.schemaVersion === 2 && backup.retired, [
      { ...key("gone"), revision: gone },
    ]);
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
    // A key that was never in the source store still starts at 1.
    assert.equal(
      await restored.transaction((tx) => tx.put(key("new"), {}, null)),
      1,
    );
    // A second backup of the restored store carries the revision on.
    await restored.transaction((tx) => tx.delete(key("gone"), again));
    const second = await restored.encryptedBackup();
    assert.deepEqual(second.schemaVersion === 2 && second.retired, [
      { ...key("gone"), revision: again },
    ]);
  } finally {
    await first.close();
    await restored.close();
    await source.close();
    await target.close();
  }
});

test("P-F1: a backup holds at most 50,000 retired revisions and no more than a restore takes", async () => {
  const fixture = await postgresFixture();
  const store = new PostgresCeremonyStore(fixture.config, ring);
  const admin = new Pool(fixture.config);
  admin.on("error", () => {});
  try {
    await store.migrate();
    await admin.query(
      "INSERT INTO ceremony_retired(tenant,kind,id,revision) SELECT 'tenant','run','gone-'||g,3 FROM generate_series(1,50001) g",
    );
    await assert.rejects(store.encryptedBackup(), /maintenance refused/);
    // Creating a deleted key again removes its retired row.
    assert.equal(
      await store.transaction((tx) => tx.put(key("gone-1"), {}, null)),
      4,
    );
    const backup = await store.encryptedBackup();
    assert.ok(backup.schemaVersion === 2);
    assert.equal(backup.retired.length, 50000);
    // Retired revisions with long ids and records near the byte limit fit
    // the schema but not the length a restore takes, so the backup is
    // refused.
    await admin.query(
      "UPDATE ceremony_retired SET id = id || '-' || repeat('x', 120)",
    );
    await admin.query(
      "INSERT INTO ceremony_records(tenant,kind,id,revision,value) SELECT 'tenant','run','large-'||g,1,decode(repeat('00',1450000),'hex') FROM generate_series(1,10) g",
    );
    await assert.rejects(store.encryptedBackup(), /maintenance refused/);
  } finally {
    await store.close();
    await admin.end();
    await fixture.close();
  }
});

test("P-F1: a restore refuses a backup that gives a key both a record and a retired revision, or one key two retired revisions, and takes a version 1 backup", async () => {
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
        retired: [{ ...key("kept"), revision: kept + 5 }],
      }),
      /maintenance refused/,
    );
    await assert.rejects(
      restored.restoreEncryptedBackup({
        ...backup,
        retired: [
          { ...key("twice"), revision: 2 },
          { ...key("twice"), revision: 5 },
        ],
      }),
      /maintenance refused/,
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

test("P-F1: a SQLite store made before revisions were kept gains the table and keeps its records", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ceremony-revision-"));
  const path = join(folder, "store.db");
  try {
    // A store with the tables of the earlier schema only.
    const before = new SQLiteCeremonyStore(path, ring);
    const top = await writeUpTo(before, "kept", 5);
    await before.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE ceremony_retired");
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

/**
 * On PostgreSQL, deletes the key at `revision` while a create of the same key
 * waits for the delete to commit, and checks the create starts above it.
 */
async function createWaitsForDelete(revision: number) {
  const fixture = await postgresFixture();
  const a = new PostgresCeremonyStore(fixture.config, ring);
  const b = new PostgresCeremonyStore(fixture.config, ring);
  const admin = new Pool(fixture.config);
  // The fixture's server stops after this pool ends, and pg emits `error` on
  // the pool for the idle backend it ends; with no listener that is an
  // uncaught exception. Losing this connection proves nothing either way.
  admin.on("error", () => {});
  try {
    await a.migrate();
    const last = await writeUpTo(a, "raced", revision);
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
    // The create read the key's retired revision before the delete
    // committed, and its INSERT waits for the deleting transaction.
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
}

test("P-F1: on PostgreSQL a create that waited for a delete of the key starts above it", async () => {
  await createWaitsForDelete(3);
});

test("P-F1: on PostgreSQL a create that waited for a delete of the key at revision 1 starts above it", async () => {
  await createWaitsForDelete(1);
});
