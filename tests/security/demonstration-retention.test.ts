import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import {
  Demonstrations,
  appendSemanticTransition,
} from "../../src/server/demonstrations.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";

test("AC-10 AC-37: capture, cursor reads and discard traverse more than 1000 tenant records", async (t) => {
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "author",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["author"],
  };
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  await store.transaction(async (tx) => {
    await tx.put(
      { tenant: "tenant", kind: "run", id: "run" },
      { subjectId: actor.subjectId },
      null,
    );
    for (let index = 0; index < 1001; index++) {
      await tx.put(
        { tenant: "tenant", kind: "event", id: `aaa:${index}` },
        { unrelated: true },
        null,
      );
      await tx.put(
        { tenant: "tenant", kind: "demonstration", id: `aaa:${index}` },
        { runId: "other", subjectId: "other", consent: "stopped" },
        null,
      );
    }
  });
  const demos = new Demonstrations(store);
  const demo = await demos.start(actor, "run");
  await store.transaction(async (tx) => {
    await appendSemanticTransition(
      tx,
      actor,
      "run",
      {
        nodeId: "setup",
        operationId: "prepare",
        operationVersion: "1.0.0",
        actorKind: "human",
        kind: "verification",
        beforeState: "pending",
        afterState: "complete",
        publicBindings: {},
        verification: "accepted",
      },
      {},
    );
    const first = (
      await tx.list<{ demonstrationId: string }>(
        "tenant",
        "event",
        1,
        `${demo.id}:`,
      )
    )[0]!;
    for (let sequence = 2; sequence <= 1002; sequence++)
      await tx.put(
        {
          tenant: "tenant",
          kind: "event",
          id: `${demo.id}:${String(sequence).padStart(12, "0")}`,
        },
        { ...first.value, eventId: `event-${sequence}`, sequence },
        null,
      );
  });
  assert.equal((await demos.timeline(actor, demo.id)).events.length, 100);
  assert.deepEqual(
    (await demos.timeline(actor, demo.id, 1000)).events.map(
      (event) => event.sequence,
    ),
    [1001, 1002],
  );
  await demos.change(actor, demo.id, demo.revision, "discarded");
  await assert.rejects(demos.timeline(actor, demo.id));
  await store.transaction(async (tx) => {
    const remaining = await tx.list("tenant", "event", 1000, `${demo.id}:`);
    assert.ok(
      remaining.every((record) => !record.id.startsWith(`${demo.id}:`)),
    );
    assert.ok(await tx.get({ tenant: "tenant", kind: "event", id: "aaa:0" }));
    assert.ok((await tx.list("tenant", "audit")).length >= 2);
  });
});

test("AC-10 AC-19: consent revisions, scopes, reviewer reads and discard integrity fail closed", async (t) => {
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "author",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["author"],
  };
  const foreign = { ...actor, subjectId: "other" };
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const demos = new Demonstrations(store);
  await assert.rejects(demos.start(actor, "missing"));
  await store.transaction((tx) =>
    tx.put(
      { tenant: "tenant", kind: "run", id: "run" },
      { subjectId: actor.subjectId },
      null,
    ),
  );
  await assert.rejects(demos.start(foreign, "run"));
  const demo = await demos.start(actor, "run", ["allowed"]);
  const append = (nodeId: string) =>
    store.transaction((tx) =>
      appendSemanticTransition(
        tx,
        actor,
        "run",
        {
          nodeId,
          operationId: "prepare",
          operationVersion: "1.0.0",
          actorKind: "human",
          kind: "verification",
          beforeState: "pending",
          afterState: "complete",
          publicBindings: {},
          verification: "accepted",
        },
        {},
      ),
    );
  await append("excluded");
  assert.equal((await demos.timeline(actor, demo.id)).events.length, 0);
  await append("allowed");
  const second = await demos.start(actor, "run");
  assert.equal(second.startSequence, 2);
  await assert.rejects(demos.timeline(foreign, demo.id));
  assert.equal(
    (await demos.timeline({ ...foreign, capabilities: ["reviewer"] }, demo.id))
      .events.length,
    1,
  );
  for (const [after, limit] of [
    [-1, 1],
    [0, 0],
    [0, 101],
    [0, 0.5],
    [0.5, 1],
  ])
    await assert.rejects(demos.timeline(actor, demo.id, after, limit));
  await assert.rejects(demos.change(foreign, demo.id, 1, "paused"));
  await assert.rejects(demos.change(actor, "missing", 1, "paused"));
  await assert.rejects(demos.change(actor, demo.id, 99, "paused"));
  const paused = await demos.change(actor, demo.id, 1, "paused");
  await append("allowed");
  assert.equal((await demos.timeline(actor, demo.id)).events.length, 1);
  const resumed = await demos.change(
    actor,
    demo.id,
    paused.revision,
    "recording",
  );
  await append("allowed");
  assert.equal((await demos.timeline(actor, demo.id)).events.length, 2);
  const stopped = await demos.change(
    actor,
    demo.id,
    resumed.revision,
    "stopped",
  );
  await assert.rejects(
    demos.change(actor, demo.id, stopped.revision, "recording"),
  );
  await store.transaction((tx) =>
    tx.put(
      { tenant: "tenant", kind: "event", id: `${demo.id}:999999999999` },
      { demonstrationId: "different" },
      null,
    ),
  );
  await assert.rejects(
    demos.change(actor, demo.id, stopped.revision, "discarded"),
  );
  assert.equal((await demos.timeline(actor, demo.id)).consent, "stopped");
  await store.transaction(async (tx) => {
    const key = {
      tenant: "tenant",
      kind: "event" as const,
      id: `${demo.id}:999999999999`,
    };
    const record = await tx.get(key);
    await tx.delete(key, record!.revision);
  });
  const discarded = await demos.change(
    actor,
    demo.id,
    stopped.revision,
    "discarded",
  );
  await assert.rejects(
    demos.change(actor, demo.id, discarded.revision, "recording"),
  );
});
