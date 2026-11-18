import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  PersistenceConflict,
  PostgresCeremonyStore,
} from "../src/server/persistence/index.js";
import { postgresFixture } from "./fixtures/postgres.js";

const ring = { current: "first", keys: { first: randomBytes(32) } };
const key = (id: string) => ({ tenant: "tenant", kind: "run" as const, id });

const outcomeOf = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ value }) as const,
    (error: unknown) => ({ error }) as const,
  );

/**
 * A claim of a key with no claim row inserts the row. On PostgreSQL that
 * INSERT waits while another transaction holds an uncommitted insert of the
 * same row, and when that transaction rolls back the INSERT goes ahead with
 * the values it computed before the wait.
 */
test("rule 6: a claim of a free key whose insert waited on an insert that rolled back returns no fence that has already run out", async () => {
  const fixture = await postgresFixture();
  const a = new PostgresCeremonyStore(fixture.config, ring);
  const b = new PostgresCeremonyStore(fixture.config, ring);
  try {
    await a.migrate();
    const id = "free";
    let inserted!: () => void;
    const untilInserted = new Promise<void>((done) => (inserted = done));
    let release!: () => void;
    const untilRelease = new Promise<void>((done) => (release = done));
    // This transaction inserts the claim row, holds it, then rolls back.
    const rolledBack = outcomeOf(
      a.transaction(async (tx) => {
        await tx.cancel(key(id));
        inserted();
        await untilRelease;
        throw new Error("roll back");
      }),
    );
    await untilInserted;
    const claimed = outcomeOf(
      b.transaction((tx) => tx.claim(key(id), "late", 1_000)),
    );
    await delay(1_500);
    release();
    const aborted = await rolledBack;
    assert.ok("error" in aborted, "the inserting transaction committed");
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
