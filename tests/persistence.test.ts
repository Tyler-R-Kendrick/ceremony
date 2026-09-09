import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import {
  SQLiteCeremonyStore,
  PostgresCeremonyStore,
  PersistenceConflict,
  rotateRecords,
  type AsyncCeremonyStore,
  type AsyncTransaction,
} from "../src/server/persistence/index.js";
import { postgresFixture } from "./fixtures/postgres.js";

const key = { tenant: "tenant", kind: "run", id: "run-1" } as const;
const ring = { current: "first", keys: { first: randomBytes(32) } };

async function contract(store: AsyncCeremonyStore) {
  let escaped: AsyncTransaction | undefined;
  await assert.rejects(
    store.transaction(async (tx) => {
      escaped = tx;
      await tx.put(key, { state: "pending" }, null);
      await delay(1);
      await tx.put({ ...key, kind: "event" }, { type: "transition" }, null);
      throw new Error("injected rollback");
    }),
  );
  await store.transaction(async (tx) => {
    assert.equal(await tx.get(key), undefined);
    assert.deepEqual(await tx.list("tenant", "event"), []);
    assert.ok((await tx.now()) > 0);
  });
  await assert.rejects(async () => escaped!.get(key), /closed/);
  await store.transaction(async (tx) => {
    assert.equal(await tx.put(key, { state: "pending" }, null), 1);
    await tx.put({ ...key, kind: "outbox" }, { event: "transition" }, null);
  });
  await assert.rejects(
    store.transaction((tx) => tx.put(key, {}, null)),
    PersistenceConflict,
  );
  await assert.rejects(
    store.transaction((tx) => tx.put(key, {}, 2)),
    PersistenceConflict,
  );
  await store.transaction(async (tx) => {
    assert.equal(await tx.get({ ...key, tenant: "other" }), undefined);
    assert.equal(await tx.put(key, { state: "done" }, 1), 2);
  });
  assert.deepEqual(await store.transaction((tx) => tx.get(key)), {
    revision: 2,
    value: { state: "done" },
  });
  await assert.rejects(
    store.transaction((tx) => tx.delete(key, 1)),
    PersistenceConflict,
  );
  await store.transaction((tx) => tx.delete(key, 2));
  await assert.rejects(
    store.transaction((tx) => tx.put({ ...key, id: "" }, {}, null)),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) => tx.list("tenant", "run", 1001)),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) => tx.claim(key, "worker", 0)),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) => tx.claim(key, "worker", 300001)),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) => tx.claim(key, "", 100)),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) => tx.put(key, {}, 0)),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) => tx.put(key, {}, 1.5)),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) => tx.list("tenant", "run", 0)),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) => tx.list("tenant", "run", 1, "?")),
    /Invalid/,
  );
  await assert.rejects(
    store.transaction((tx) =>
      tx.assertFence({ ...key, generation: 1, worker: "missing" }),
    ),
    PersistenceConflict,
  );
  const fence = await store.transaction((tx) => tx.claim(key, "worker", 1000));
  await store.transaction((tx) => tx.heartbeat(fence, 1000));
  await assert.rejects(
    store.transaction((tx) => tx.assertFence({ ...fence, worker: "wrong" })),
    PersistenceConflict,
  );
  await assert.rejects(
    store.transaction((tx) => tx.claim(key, "second", 1000)),
    PersistenceConflict,
  );
  await store.transaction((tx) => tx.cancel(key));
  await assert.rejects(
    store.transaction((tx) => tx.assertFence(fence)),
    PersistenceConflict,
  );
  const next = await store.transaction((tx) => tx.claim(key, "second", 1000));
  assert.ok(next.generation > fence.generation);
  await store.transaction(async (tx) => {
    await tx.put({ ...key, id: "page-a" }, { page: 1 }, null);
    await tx.put({ ...key, id: "page-b" }, { page: 2 }, null);
    assert.deepEqual(
      (await tx.list("tenant", "run", 1)).map((row) => row.id),
      ["page-a"],
    );
    assert.deepEqual(
      (await tx.list("tenant", "run", 1, "page-a")).map((row) => row.id),
      ["page-b"],
    );
  });
}

test("STO-03: invalid key configurations fail before store creation", () => {
  assert.throws(
    () => new SQLiteCeremonyStore(":memory:", { current: "missing", keys: {} }),
    /Invalid/,
  );
  assert.throws(
    () =>
      new SQLiteCeremonyStore(":memory:", {
        current: "bad",
        keys: { bad: randomBytes(31) },
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      new SQLiteCeremonyStore(":memory:", {
        current: "?",
        keys: { "?": randomBytes(32) },
      }),
    /Invalid/,
  );
});

test("STO-01/05: local async transaction contract, rollback, CAS and atomic outbox", async () => {
  const store = new SQLiteCeremonyStore(":memory:", ring);
  try {
    await contract(store);
  } finally {
    await store.close();
  }
});

test("AC-27/28: independent SQLite workers fence expired attempts and race command admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ceremony-store-"));
  const a = new SQLiteCeremonyStore(join(directory, "state.sqlite"), ring);
  const b = new SQLiteCeremonyStore(join(directory, "state.sqlite"), ring);
  try {
    const results = await Promise.allSettled(
      [a, b].map((store) =>
        store.transaction(async (tx) => {
          await tx.put(key, { command: "one" }, null);
          await delay(10);
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const old = await a.transaction((tx) => tx.claim(key, "first", 5));
    await delay(15);
    const newer = await b.transaction((tx) => tx.claim(key, "second", 1000));
    assert.equal(newer.generation, old.generation + 1);
    await assert.rejects(
      a.transaction(async (tx) => {
        await tx.assertFence(old);
        await tx.put(key, { bad: true }, 1);
      }),
      PersistenceConflict,
    );
    assert.deepEqual((await b.transaction((tx) => tx.get(key)))?.value, {
      command: "one",
    });
  } finally {
    await a.close();
    await b.close();
    await rm(directory, { recursive: true });
  }
});

test("AC-38: encryption, metadata tamper detection, rotation and backup restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ceremony-encryption-"));
  const path = join(directory, "state.sqlite");
  let store = new SQLiteCeremonyStore(path, ring);
  try {
    await store.transaction((tx) =>
      tx.put(key, { secret: "synthetic-protected-record" }, null),
    );
    await store.close();
    assert.equal(
      (await readFile(path)).includes(
        Buffer.from("synthetic-protected-record"),
      ),
      false,
    );
    const second = randomBytes(32);
    store = new SQLiteCeremonyStore(path, {
      current: "second",
      keys: { ...ring.keys, second },
    });
    assert.equal(await rotateRecords(store, "tenant", "run"), 1);
    await store.close();
    await copyFile(path, join(directory, "backup.sqlite"));
    store = new SQLiteCeremonyStore(join(directory, "backup.sqlite"), {
      current: "second",
      keys: { second },
    });
    assert.equal((await store.transaction((tx) => tx.get(key)))?.revision, 2);
    await store.close();
    store = new SQLiteCeremonyStore(path, ring);
    await assert.rejects(
      store.transaction((tx) => tx.get(key)),
      /cannot be decrypted/,
    );
    await store.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE ceremony_records SET revision=99");
    raw.close();
    store = new SQLiteCeremonyStore(path, {
      current: "second",
      keys: { second },
    });
    await assert.rejects(
      store.transaction((tx) => tx.get(key)),
      /cannot be decrypted/,
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true });
  }
});

test("AC-27/28/31: actual PostgreSQL migration, transactions and independent workers", async () => {
  const fixture = await postgresFixture();
  const a = new PostgresCeremonyStore(fixture.config, ring);
  const b = new PostgresCeremonyStore(fixture.config, ring);
  try {
    await a.migrate();
    await b.migrate();
    await contract(a);
    const concurrent = { ...key, id: "concurrent" };
    const results = await Promise.allSettled(
      [a, b].map((store) =>
        store.transaction(async (tx) => {
          await tx.put(concurrent, { effect: "one" }, null);
          await delay(10);
        }),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const old = await a.transaction((tx) => tx.claim(concurrent, "first", 5));
    await delay(15);
    const next = await b.transaction((tx) =>
      tx.claim(concurrent, "second", 1000),
    );
    assert.ok(next.generation > old.generation);
    await assert.rejects(
      a.transaction(async (tx) => {
        await tx.assertFence(old);
        await tx.put(concurrent, { effect: "forbidden" }, 1);
      }),
      PersistenceConflict,
    );
    assert.deepEqual((await b.transaction((tx) => tx.get(concurrent)))?.value, {
      effect: "one",
    });
  } finally {
    await a.close();
    await b.close();
    await fixture.close();
  }
});

test("PostgreSQL idle-client failure exposes only safe health state and reconnects", async () => {
  const fixture = await postgresFixture();
  const store = new PostgresCeremonyStore(
    { ...fixture.config, application_name: "ceremony-idle-test" },
    ring,
  );
  const admin = new Pool(fixture.config);
  try {
    await store.migrate();
    await store.transaction((tx) => tx.now());
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1",
      ["ceremony-idle-test"],
    );
    for (
      let attempt = 0;
      attempt < 100 && store.health() !== "degraded";
      attempt++
    )
      await delay(5);
    assert.equal(store.health(), "degraded");
    assert.ok((await store.transaction((tx) => tx.now())) > 0);
    assert.equal(store.health(), "ready");
    await admin.query("DROP TABLE ceremony_records");
    await assert.rejects(
      store.transaction((tx) => tx.get(key)),
      (error) =>
        error instanceof Error &&
        error.message === "Persistence operation unavailable",
    );
    const missing = new PostgresCeremonyStore(
      { ...fixture.config, database: "missing_database" },
      ring,
    );
    try {
      await assert.rejects(
        missing.migrate(),
        (error) =>
          error instanceof Error &&
          error.message === "Persistence migration unavailable",
      );
      await assert.rejects(
        missing.transaction((tx) => tx.now()),
        (error) =>
          error instanceof Error &&
          error.message === "Persistence connection unavailable",
      );
    } finally {
      await missing.close();
    }
  } finally {
    await store.close();
    await admin.end();
    await fixture.close();
  }
});
