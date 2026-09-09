import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import {
  configuredKeyring,
  rotateTenant,
  retainWithoutDemonstration,
} from "../src/server/persistence/maintenance.js";
import { postgresFixture } from "./fixtures/postgres.js";

test("AC-38: bounded previous key configuration excludes duplicates and malformed inputs", () => {
  const env = {
    CEREMONY_VAULT_KEY_ID: "new",
    CEREMONY_VAULT_KEY: randomBytes(32).toString("hex"),
    CEREMONY_VAULT_PREVIOUS_KEYS: JSON.stringify({
      old: randomBytes(32).toString("hex"),
    }),
  };
  assert.deepEqual(Object.keys(configuredKeyring(env).keys).sort(), [
    "new",
    "old",
  ]);
  assert.equal(
    Object.keys(
      configuredKeyring({ ...env, CEREMONY_VAULT_PREVIOUS_KEYS: undefined })
        .keys,
    ).length,
    1,
  );
  for (const value of [
    "broken",
    "x".repeat(1025),
    JSON.stringify({ new: env.CEREMONY_VAULT_KEY }),
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `old${i}`,
          env.CEREMONY_VAULT_KEY,
        ]),
      ),
    ),
    JSON.stringify({ old: "invalid" }),
  ])
    assert.throws(
      () => configuredKeyring({ ...env, CEREMONY_VAULT_PREVIOUS_KEYS: value }),
      /^Error: Invalid vault keyring configuration$/,
    );
});

test("AC-38: actual PostgreSQL encrypted backup restores fresh database, verifies keys and fences historical workers", async () => {
  const source = await postgresFixture(),
    target = await postgresFixture();
  const oldKey = randomBytes(32),
    newKey = randomBytes(32);
  const first = new PostgresCeremonyStore(source.config, {
    current: "old",
    keys: { old: oldKey },
  });
  const restored = new PostgresCeremonyStore(target.config, {
    current: "new",
    keys: { old: oldKey, new: newKey },
  });
  const wrong = new PostgresCeremonyStore(target.config, {
    current: "wrong",
    keys: { wrong: randomBytes(32) },
  });
  try {
    await first.migrate();
    await restored.migrate();
    const key = { tenant: "tenant", kind: "run" as const, id: "run:one" };
    const fence = await first.transaction(async (tx) => {
      await tx.put(key, { private: "synthetic-protected-material" }, null);
      return tx.claim(key, "worker", 10000);
    });
    await assert.rejects(first.encryptedBackup(), /maintenance refused/);
    await first.transaction((tx) => tx.cancel(key));
    const backup = await first.encryptedBackup();
    assert.equal(
      JSON.stringify(backup).includes("synthetic-protected-material"),
      false,
    );
    await assert.rejects(
      wrong.restoreEncryptedBackup(backup),
      /configured keys/,
    );
    const tampered = structuredClone(backup);
    tampered.records[0]!.value = Buffer.from("invalid").toString("base64");
    await assert.rejects(
      restored.restoreEncryptedBackup(tampered),
      /configured keys/,
    );
    const duplicate = structuredClone(backup);
    duplicate.records.push(duplicate.records[0]!);
    await assert.rejects(
      restored.restoreEncryptedBackup(duplicate),
      /maintenance refused/,
    );
    await restored.restoreEncryptedBackup(backup);
    assert.equal(
      (await restored.transaction((tx) => tx.get<{ private: string }>(key)))
        ?.value.private === "synthetic-protected-material",
      true,
    );
    await assert.rejects(
      restored.transaction((tx) => tx.assertFence(fence)),
      /conflict/,
    );
    const newFence = await restored.transaction((tx) =>
      tx.claim(key, "fresh-worker", 10000),
    );
    assert.ok(newFence.generation > fence.generation);
    await assert.rejects(
      restored.restoreEncryptedBackup(backup),
      /maintenance refused/,
    );
    await restored.transaction((tx) => tx.cancel(key));
    assert.equal(await rotateTenant(restored, "tenant"), 1);
    const rotated = await restored.encryptedBackup();
    assert.equal(
      JSON.parse(Buffer.from(rotated.records[0]!.value, "base64").toString())
        .key,
      "new",
    );
    const newOnly = new PostgresCeremonyStore(target.config, {
      current: "new",
      keys: { new: newKey },
    });
    try {
      assert.ok(await newOnly.transaction((tx) => tx.get(key)));
    } finally {
      await newOnly.close();
    }
  } finally {
    await first.close();
    await restored.close();
    await wrong.close();
    await source.close();
    await target.close();
  }
});

test("AC-37: retention deletes selected stopped teaching data, not recipes, audit or another run's pointer", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  try {
    await store.transaction(async (tx) => {
      await tx.put(
        { tenant: "tenant", kind: "demonstration", id: "demo:one" },
        { consent: "recording", runId: "run:one" },
        null,
      );
      await tx.put(
        { tenant: "tenant", kind: "session", id: "demonstration:run:one" },
        { id: "demo:one" },
        null,
      );
      for (let i = 0; i < 101; i++)
        await tx.put(
          {
            tenant: "tenant",
            kind: "event",
            id: `demo:one:${String(i).padStart(3, "0")}`,
          },
          { demonstrationId: "demo:one" },
          null,
        );
      await tx.put(
        { tenant: "tenant", kind: "audit", id: "required" },
        { retained: true },
        null,
      );
      await tx.put(
        { tenant: "tenant", kind: "recipe", id: "published" },
        { retained: true },
        null,
      );
    });
    await assert.rejects(
      retainWithoutDemonstration(store, "tenant", "demo:one"),
      /stopped/,
    );
    await store.transaction((tx) =>
      tx.put(
        { tenant: "tenant", kind: "demonstration", id: "demo:one" },
        { consent: "stopped", runId: "run:one" },
        1,
      ),
    );
    await retainWithoutDemonstration(store, "tenant", "demo:one");
    await store.transaction(async (tx) => {
      assert.equal((await tx.list("tenant", "event")).length, 0);
      assert.equal((await tx.list("tenant", "session")).length, 0);
      assert.equal((await tx.list("tenant", "demonstration")).length, 0);
      assert.equal((await tx.list("tenant", "audit")).length, 1);
      assert.equal((await tx.list("tenant", "recipe")).length, 1);
    });
  } finally {
    await store.close();
  }
});

test("AC-37: retention rejects wrong event ownership atomically and preserves a newer demonstration pointer", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  try {
    await store.transaction(async (tx) => {
      await tx.put(
        { tenant: "tenant", kind: "demonstration", id: "demo:one" },
        { consent: "discarded", runId: "run:one" },
        null,
      );
      await tx.put(
        { tenant: "tenant", kind: "session", id: "demonstration:run:one" },
        { id: "demo:new" },
        null,
      );
      await tx.put(
        { tenant: "tenant", kind: "event", id: "demo:one:1" },
        { demonstrationId: "demo:one" },
        null,
      );
      await tx.put(
        { tenant: "tenant", kind: "event", id: "demo:one:2" },
        { demonstrationId: "demo:foreign" },
        null,
      );
    });
    await assert.rejects(
      retainWithoutDemonstration(store, "tenant", "demo:one"),
      /binding invalid/,
    );
    assert.equal(
      (await store.transaction((tx) => tx.list("tenant", "event"))).length,
      2,
    );
    await store.transaction((tx) =>
      tx.delete({ tenant: "tenant", kind: "event", id: "demo:one:2" }, 1),
    );
    await retainWithoutDemonstration(store, "tenant", "demo:one");
    assert.equal(
      (await store.transaction((tx) => tx.list("tenant", "session"))).length,
      1,
    );
    await assert.rejects(
      retainWithoutDemonstration(store, "tenant", "demo:one"),
      /stopped/,
    );
  } finally {
    await store.close();
  }
});

test("AC-38: rotation's cursor and re-encryption share one atomic page snapshot", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  try {
    await store.transaction(async (tx) => {
      for (let i = 0; i < 101; i++)
        await tx.put(
          {
            tenant: "tenant",
            kind: "artifact",
            id: `artifact:${String(i).padStart(3, "0")}`,
          },
          { safe: true },
          null,
        );
    });
    const guarded = {
      close: () => store.close(),
      transaction: async <T>(
        work: (
          tx: import("../src/server/persistence/index.js").AsyncTransaction,
        ) => Promise<T>,
      ): Promise<T> =>
        store.transaction(async (tx) => {
          let read = 0,
            written = 0;
          const result = await work({
            ...tx,
            list: async <V>(...args: Parameters<typeof tx.list>) => {
              const page = await tx.list<V>(...args);
              read += page.length;
              return page;
            },
            put: async (...args) => {
              written++;
              return tx.put(...args);
            },
          });
          assert.equal(
            written,
            read,
            "A rotation page cannot advance its cursor outside its write transaction",
          );
          return result;
        }),
    };
    assert.equal(await rotateTenant(guarded, "tenant"), 101);
    assert.ok(
      (
        await store.transaction((tx) => tx.list("tenant", "artifact", 1000))
      ).every((record) => record.revision === 2),
    );
  } finally {
    await store.close();
  }
});
