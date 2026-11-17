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
    const backup = await first.encryptedBackup();
    assert.equal(backup.schemaVersion, 2);
    assert.deepEqual(backup.schemaVersion === 2 && backup.retired, [
      { ...key("gone"), revision: gone },
    ]);
    await restored.restoreEncryptedBackup(backup);

    // The record that was in the backup keeps its revision.
    assert.equal(
      (await restored.transaction((tx) => tx.get(key("kept"))))?.revision,
      kept,
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

test("P-F1: a restore refuses a backup that gives a key both a record and a retired revision, and takes a version 1 backup", async () => {
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
    // The create read the key's revision before the delete committed, and
    // its INSERT waits for the deleting transaction.
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
