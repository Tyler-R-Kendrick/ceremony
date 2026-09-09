import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  AsyncPrivateCollectionBroker,
  type PrivateCollectionBinding,
} from "../src/server/persistence/collections.js";
import {
  SQLiteCeremonyStore,
  PostgresCeremonyStore,
} from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { postgresFixture } from "./fixtures/postgres.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};
const contract: PrivateCollectionBinding = {
  purpose: "github-recovery",
  provider: "github",
  operationId: "github.recover",
  operationVersion: "1.0.0",
  runId: "run:one",
  nodeId: "node:one",
  revision: 2,
  fields: ["appId", "pem"],
};
const values = { appId: "42", pem: "synthetic-private-material" };
const keys = { current: "test", keys: { test: randomBytes(32) } };

test("HUM-01: exact principal, field set, purpose, operation, run, node and revision binding", async () => {
  const store = new SQLiteCeremonyStore(":memory:", keys);
  const broker = new AsyncPrivateCollectionBroker(store);
  try {
    const ref = await broker.collect(actor, contract, values);
    for (const change of [
      { purpose: "other" },
      { provider: "other" },
      { operationId: "other" },
      { operationVersion: "2.0.0" },
      { runId: "run:two" },
      { nodeId: "node:two" },
      { revision: 3 },
      { fields: ["pem"] },
    ])
      await assert.rejects(
        broker.consume(actor, { ...contract, ...change }, ref, "command:one"),
        /unavailable/,
      );
    for (const change of [{ tenantId: "foreign" }, { subjectId: "foreign" }])
      await assert.rejects(
        broker.consume({ ...actor, ...change }, contract, ref, "command:one"),
        /unavailable/,
      );
    await assert.rejects(
      broker.consume(actor, contract, "invalid", "command:one"),
      /unavailable/,
    );
    await assert.rejects(
      broker.consume(actor, contract, ref, "__proto__"),
      /unavailable/,
    );
    const result = await broker.consume(
      actor,
      { ...contract, fields: ["pem", "appId"] },
      ref,
      "command:one",
    );
    assert.equal(result.pem === values.pem, true);
    assert.equal(
      (await broker.consume(actor, contract, ref, "command:one")).pem ===
        values.pem,
      true,
    );
    await assert.rejects(
      broker.consume(actor, contract, ref, "command:two"),
      /unavailable/,
    );
    const other = await broker.collect(actor, contract, values);
    await assert.rejects(
      broker.consume(actor, contract, other, "command:one"),
      /unavailable/,
    );
    await assert.rejects(
      broker.complete(
        { ...actor, subjectId: "foreign" },
        contract,
        ref,
        "command:one",
      ),
      /unavailable/,
    );
    await broker.complete(actor, contract, ref, "command:one");
    await broker.complete(actor, contract, ref, "command:one");
    await assert.rejects(
      broker.consume(actor, contract, ref, "command:one"),
      /unavailable/,
    );
    const record = await store.transaction((tx) =>
      tx.get({ tenant: "tenant", kind: "collection", id: ref }),
    );
    assert.equal(record, undefined);
  } finally {
    await store.close();
  }
});

test("HUM-01: private validation fails closed without reflecting values", async () => {
  const store = new SQLiteCeremonyStore(":memory:", keys);
  const broker = new AsyncPrivateCollectionBroker(store);
  try {
    for (const bad of [
      { pem: "secret" },
      { ...values, extra: "secret" },
      { ...values, pem: "x".repeat(30001) },
      JSON.parse('{"__proto__":"secret"}'),
      { appId: 42, pem: "secret" },
    ]) {
      await assert.rejects(
        broker.collect(actor, contract, bad),
        (error) =>
          error instanceof Error &&
          error.message === "Private collection unavailable",
      );
    }
    await assert.rejects(
      broker.collect({ ...actor, actorKind: "agent" }, contract, values),
      /unavailable/,
    );
    await assert.rejects(
      broker.collect(actor, { ...contract, fields: ["pem", "pem"] }, values),
      /unavailable/,
    );
    await assert.rejects(
      broker.collect(actor, contract, values, 300001),
      /unavailable/,
    );
    assert.throws(() => new AsyncPrivateCollectionBroker(store, 0), /Invalid/);
    assert.equal(
      (await store.transaction((tx) => tx.list("tenant", "collection"))).length,
      0,
    );
  } finally {
    await store.close();
  }
});

test("HUM recoverable consumption rolls back with command admission, expiry purges private material only", async () => {
  const store = new SQLiteCeremonyStore(":memory:", keys);
  const broker = new AsyncPrivateCollectionBroker(store, 10);
  try {
    const ref = await broker.collect(actor, contract, values);
    await assert.rejects(
      store.transaction(async (tx) => {
        await broker.consumeIn(tx, actor, contract, ref, "command:rollback");
        await tx.put(
          { tenant: "tenant", kind: "command", id: "admission" },
          { state: "admitted" },
          null,
        );
        throw new Error("injected rollback");
      }),
    );
    assert.equal(
      await store.transaction((tx) =>
        tx.get({ tenant: "tenant", kind: "command", id: "admission" }),
      ),
      undefined,
    );
    await broker.consume(actor, contract, ref, "command:next");
    await store.transaction((tx) =>
      tx.put(
        { tenant: "tenant", kind: "audit", id: "audit" },
        { code: "private-collected" },
        null,
      ),
    );
    const expiring = await broker.collect(actor, contract, values, 1);
    await delay(20);
    await assert.rejects(
      broker.consume(actor, contract, ref, "command:next"),
      /unavailable/,
    );
    await assert.rejects(
      broker.consume(actor, contract, expiring, "command:expired"),
      /unavailable/,
    );
    assert.equal((await broker.purgeExpired("tenant")).deleted, 2);
    assert.equal(
      (await store.transaction((tx) => tx.list("tenant", "audit"))).length,
      1,
    );
    assert.equal(
      (await store.transaction((tx) => tx.list("tenant", "command"))).length,
      1,
    );
  } finally {
    await store.close();
  }
});

test("HUM PostgreSQL: concurrent same command is recoverable; other command cannot consume the reference", async () => {
  const fixture = await postgresFixture();
  const a = new PostgresCeremonyStore(fixture.config, keys);
  const b = new PostgresCeremonyStore(fixture.config, keys);
  try {
    await a.migrate();
    const first = new AsyncPrivateCollectionBroker(a);
    const second = new AsyncPrivateCollectionBroker(b);
    const ref = await first.collect(actor, contract, values);
    const same = await Promise.all([
      first.consume(actor, contract, ref, "command:one"),
      second.consume(actor, contract, ref, "command:one"),
    ]);
    assert.equal(
      same.every((value) => value.pem === values.pem),
      true,
    );
    const fresh = await first.collect(actor, contract, values);
    const results = await Promise.allSettled([
      first.consume(actor, contract, fresh, "command:two"),
      second.consume(actor, contract, fresh, "command:three"),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
  } finally {
    await a.close();
    await b.close();
    await fixture.close();
  }
});
