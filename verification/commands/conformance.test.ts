// Ties Commands.tla to the real ProtectedCommandService, on the SQLite store.
//
// Part 1 shows, on the real code, each fact the model takes from it: one
// test for each guard or write of the model's actions. If one of these
// fails, the code no longer does what the model says it does.
//
// Part 2 replays each counterexample of the model against the real code,
// one call for each step of the path. Those tests pass while the finding is
// still present. When a fix lands, its test fails: that is the signal to
// update the model (see README.md in this folder).
//
// Run from the repo root:
//   node --no-experimental-webstorage --import tsx --test verification/commands/conformance.test.ts
// verification/commands/check.sh runs it next to the model checks.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { ProtectedCommandService } from "../../src/server/commands.js";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import { OperationRegistry } from "../../src/server/recipes/registry.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "alice",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};

type Stored = {
  id: string;
  state?: string;
  status?: string;
  task?: string;
  commandId?: string;
};

/**
 * A run of two steps, `prepare` and then `verify`, which depends on it.
 * `handler` receives the number of the handler call across both steps and
 * decides how that call behaves. `evidence.valid` is what the provider says
 * when a step is verified.
 */
async function fixture(
  t: TestContext,
  handler: (call: number) => Promise<void> = async () => {},
) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const evidence = { valid: true };
  let calls = 0;
  const registry = new OperationRegistry(
    new Map([["verified", { classification: "public", schema: z.boolean() }]]),
  );
  for (const id of ["prepare", "verify"])
    registry.register({
      contract: {
        id,
        version: "1.0.0",
        provider: "github",
        profile: "app",
        inputs: {},
        outputs: { verified: { contract: "verified", required: true } },
        effects: ["read"],
        verifier: "provider",
        humanFallback: "provider-consent",
      },
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ verified: z.boolean() }),
      classifications: {},
      fixtures: ["signed-local-provider"],
      handler: async () => {
        calls++;
        await handler(calls);
        return { state: "complete", outputs: { verified: true } };
      },
      verify: async () => evidence.valid,
    });
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const run = await commands.createRun(
    actor,
    {
      provider: "github",
      profile: "app",
      target: "personal",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "v1",
    },
    [
      {
        id: "prepare",
        operationId: "prepare",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
      {
        id: "verify",
        operationId: "verify",
        operationVersion: "1.0.0",
        dependsOn: ["prepare"],
        bindings: {},
      },
    ],
    {},
  );
  return {
    commands,
    run,
    evidence,
    calls: () => calls,
    advance: (step: string, revision: number, commandId: string) =>
      commands.advance(actor, run.id, step, revision, commandId),
    snapshot: () => commands.snapshot(actor, run.id),
    /**
     * The model's "the lease runs out": the database clock passes every
     * claim's expiry. tests/command-crash-boundaries.test.ts does the same
     * with an UPDATE, so no test sleeps for the 60 s lease.
     */
    leaseRunsOut: () =>
      (store as unknown as { db: { exec(sql: string): void } }).db.exec(
        "UPDATE ceremony_claims SET expires=1",
      ),
    step: async (id: string) =>
      (await commands.snapshot(actor, run.id)).nodes.find(
        (node) => node.id === id,
      )!,
    /** Store a step record directly, as tests/commands.test.ts does. */
    putStep: (id: string, record: Record<string, unknown>) =>
      store.transaction(async (tx) => {
        const key = {
          tenant: actor.tenantId,
          kind: "node" as const,
          id: `${run.id}:${id}`,
        };
        const prior = await tx.get(key);
        await tx.put(key, { outputs: {}, ...record }, prior?.revision ?? null);
      }),
    records: (kind: "command" | "effect" | "outbox") =>
      store.transaction(async (tx) =>
        (await tx.list<Omit<Stored, "id">>(actor.tenantId, kind)).map(
          (entry): Stored => ({ id: entry.id, ...entry.value }),
        ),
      ),
  };
}

/** A handler call that does not come back until `release` is called. */
function hanging() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function until(done: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!done() && performance.now() < deadline)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(done(), true);
}

const states = (records: Stored[]) => records.map((r) => [r.id, r.state]);

// ---------------------------------------------------------------------------
// Part 1: what the model takes from the code.
// ---------------------------------------------------------------------------

test("Admit: the command and effect records are stored before the handler is called, and the run and step records are not written", async (t) => {
  let seen: { commands: Stored[]; effects: Stored[] } | undefined;
  const f = await fixture(t, async () => {
    seen = {
      commands: await f.records("command"),
      effects: await f.records("effect"),
    };
    const during = await f.snapshot();
    assert.equal(during.revision, 1);
    assert.equal(during.nodes[0]!.state, "pending");
  });
  await f.advance("prepare", 1, "first");
  assert.deepEqual(states(seen!.commands), [["first", "running"]]);
  assert.deepEqual(
    seen!.effects.map((e) => [e.commandId, e.status]),
    [["first", "intent-persisted"]],
  );
});

test("Admit: refused for a stale revision and for a run that is not active", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.advance("prepare", 2, "stale"));
  await f.commands.cancel(actor, f.run.id, 1);
  await assert.rejects(f.advance("prepare", 2, "after-cancel"));
  assert.equal(f.calls(), 0);
  assert.deepEqual(await f.records("command"), []);
});

for (const record of [
  { state: "uncertain", verified: false },
  { state: "complete", verified: true },
  { state: "failed", verified: false, exhausted: true },
])
  test(`Admit: refused while the step is ${record.exhausted ? "exhausted" : record.state}`, async (t) => {
    const f = await fixture(t);
    await f.putStep("prepare", record);
    await assert.rejects(f.advance("prepare", 1, "fresh"), /denied/);
    assert.equal(f.calls(), 0);
    assert.deepEqual(await f.records("command"), []);
  });

for (const record of [
  { state: "failed", verified: false },
  { state: "awaiting-human", verified: false },
  { state: "verifying", verified: false },
])
  test(`Admit: allowed while the step is ${record.state}`, async (t) => {
    const f = await fixture(t);
    await f.putStep("prepare", record);
    const result = await f.advance("prepare", 1, "fresh");
    assert.equal(result.state, "complete");
    assert.equal(f.calls(), 1);
  });

test("Admit: refused for a second id while the first worker's lease is live", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);
  const first = f.advance("prepare", 1, "first");
  await until(() => f.calls() === 1);
  await assert.rejects(f.advance("prepare", 1, "second"));
  assert.deepEqual(states(await f.records("command")), [["first", "running"]]);
  stuck.release();
  assert.equal((await first).state, "complete");
  assert.equal(f.calls(), 1);
});

test("Replay: a known id returns the stored state and never calls the handler again", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);
  const first = f.advance("prepare", 1, "first");
  await until(() => f.calls() === 1);
  // In flight with a live lease: the stored state is `running`.
  assert.equal((await f.advance("prepare", 1, "first")).state, "running");
  stuck.release();
  assert.equal((await first).state, "complete");
  const replay = await f.advance("prepare", 1, "first");
  assert.equal(replay.state, "complete");
  assert.equal(replay.verified, true);
  assert.equal(f.calls(), 1);
});

test("CallHandler: a handler that throws is recorded as uncertain, and the step then refuses a new id", async (t) => {
  const f = await fixture(t, async () => {
    throw new Error("connection reset");
  });
  const first = await f.advance("prepare", 1, "first");
  assert.equal(first.state, "uncertain");
  assert.equal((await f.step("prepare")).state, "uncertain");
  await assert.rejects(
    f.advance("prepare", first.revision, "second"),
    /denied/,
  );
  assert.equal(f.calls(), 1);
});

test("Commit: step, command, effect and run are written together and the lease is released", async (t) => {
  const f = await fixture(t);
  const first = await f.advance("prepare", 1, "first");
  assert.deepEqual(
    [first.state, first.verified, first.revision],
    ["complete", true, 2],
  );
  const prepare = await f.step("prepare");
  assert.deepEqual([prepare.state, prepare.verified], ["complete", true]);
  assert.deepEqual(states(await f.records("command")), [["first", "complete"]]);
  assert.deepEqual(
    (await f.records("effect")).map((e) => e.status),
    ["complete"],
  );
  // The lease is free at once: the next step is admitted, and the last
  // verified step completes the run.
  const second = await f.advance("verify", 2, "second");
  assert.equal(second.state, "complete");
  assert.equal((await f.snapshot()).status, "complete");
});

test("Commit: refused once another party has taken the lease, even though the revision has not moved", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);
  // The lease runs out and a revalidation takes it, finds nothing to reject
  // and releases it. Nothing bumps the run revision.
  f.leaseRunsOut();
  assert.equal((await f.commands.revalidate(actor, f.run.id)).revision, 1);
  stuck.release();
  await assert.rejects(first);
  assert.deepEqual(states(await f.records("command")), [["first", "running"]]);
  const after = await f.snapshot();
  assert.equal(after.revision, 1);
  assert.equal(after.nodes[0]!.state, "pending");
});

test("Commit: refused after the run is cancelled", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);
  await f.commands.cancel(actor, f.run.id, 1);
  stuck.release();
  await assert.rejects(first);
  assert.equal((await f.step("prepare")).state, "pending");
});

test("Takeover: the same id after the lease runs out is marked uncertain with a reconciliation task, and the handler is not called again", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);
  f.leaseRunsOut();
  const replay = await f.advance("prepare", 1, "first");
  assert.deepEqual(
    [replay.state, replay.verified, replay.revision],
    ["uncertain", false, 2],
  );
  assert.equal(f.calls(), 1);
  assert.equal((await f.step("prepare")).state, "uncertain");
  assert.deepEqual(states(await f.records("command")), [
    ["first", "uncertain"],
  ]);
  assert.deepEqual(
    (await f.records("effect")).map((e) => e.status),
    ["uncertain"],
  );
  assert.deepEqual(
    (await f.records("outbox")).map((o) => [o.id, o.task, o.status]),
    [["reconciliation:first", "reconciliation-required", "pending"]],
  );
  // The old worker comes back: its result is refused and changes nothing.
  stuck.release();
  await assert.rejects(first);
  assert.deepEqual(states(await f.records("command")), [
    ["first", "uncertain"],
  ]);
  // A new id is refused, and the same id still reports uncertain.
  await assert.rejects(f.advance("prepare", 2, "second"), /denied/);
  assert.equal((await f.advance("prepare", 1, "first")).state, "uncertain");
  assert.equal(f.calls(), 1);
});

test("Revalidate: a rejected verified step becomes failed, the run is active again, and a new id may run it", async (t) => {
  const f = await fixture(t);
  await f.advance("prepare", 1, "prepare");
  await f.advance("verify", 2, "verify");
  assert.equal((await f.snapshot()).status, "complete");
  f.evidence.valid = false;
  const revalidated = await f.commands.revalidate(actor, f.run.id);
  f.evidence.valid = true;
  assert.equal(revalidated.status, "active");
  assert.deepEqual(
    revalidated.nodes.map((node) => [node.state, node.verified]),
    [
      ["failed", false],
      ["failed", false],
    ],
  );
  const again = await f.advance("prepare", revalidated.revision, "again");
  assert.equal(again.state, "complete");
  assert.equal(f.calls(), 3);
});

test("Revalidate: refused for a cancelled run and while a worker's lease is live", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);
  await assert.rejects(f.commands.revalidate(actor, f.run.id));
  await f.commands.cancel(actor, f.run.id, 1);
  await assert.rejects(f.commands.revalidate(actor, f.run.id), /denied/);
  stuck.release();
  await first.catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Part 2: the findings, replayed. Each passes while its finding is present.
// ---------------------------------------------------------------------------

test("finding 1 and 2: a second command id repeats the handler over an unrecorded call, then the first id's takeover overwrites the verified step", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, (call) =>
    call === 1 ? stuck.wait : Promise.resolve(),
  );

  // Admit, CallHandler (first): the worker does not return from the provider.
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);

  // LeaseExpires, Admit, CallHandler, Commit (second).
  f.leaseRunsOut();
  const second = await f.advance("prepare", 1, "second");
  assert.equal(second.state, "complete");
  assert.equal(
    f.calls(),
    2,
    "finding 1: the handler ran twice for one step, the first call unrecorded",
  );
  assert.deepEqual(states(await f.records("command")), [
    ["first", "running"],
    ["second", "complete"],
  ]);

  // Takeover (first): the same id is sent again.
  const replay = await f.advance("prepare", 1, "first");
  assert.equal(replay.state, "uncertain");
  const prepare = await f.step("prepare");
  assert.deepEqual(
    [prepare.state, prepare.verified],
    ["uncertain", false],
    "finding 2: the verified step was overwritten",
  );
  const again = await f.advance("prepare", 1, "second");
  assert.deepEqual([again.state, again.verified], ["complete", true]);
  // Nothing moves the run on: the next step and any new id are refused.
  await assert.rejects(f.advance("verify", replay.revision, "next"), /denied/);
  await assert.rejects(
    f.advance("prepare", replay.revision, "third"),
    /denied/,
  );

  stuck.release();
  await first.catch(() => undefined);
});

test("finding 3: a command in flight when its run is cancelled stays `running` for ever, with no reconciliation task", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);

  // Admit, CallHandler, CancelRun, CommitRefused.
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);
  await f.commands.cancel(actor, f.run.id, 1);
  stuck.release();
  await assert.rejects(first);

  // The same id sent again, with the lease long gone, changes nothing.
  f.leaseRunsOut();
  assert.equal((await f.advance("prepare", 1, "first")).state, "running");
  assert.deepEqual(
    (await f.records("effect")).map((e) => e.status),
    ["intent-persisted"],
  );
  assert.deepEqual(await f.records("outbox"), []);
});

test("finding 3: the same dead end when a second command id completes the run", async (t) => {
  const stuck = hanging();
  let held = false;
  const f = await fixture(t, (call) => {
    // The first call for step `verify` does not return.
    if (call === 2 && !held) {
      held = true;
      return stuck.wait;
    }
    return Promise.resolve();
  });
  await f.advance("prepare", 1, "prepare");

  const first = f.advance("verify", 2, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 2);
  f.leaseRunsOut();
  assert.equal((await f.advance("verify", 2, "second")).state, "complete");
  assert.equal((await f.snapshot()).status, "complete");

  assert.equal((await f.advance("verify", 2, "first")).state, "running");
  assert.deepEqual(await f.records("outbox"), []);

  stuck.release();
  await first.catch(() => undefined);
});

test("finding 4: revalidation that rejects an earlier step reopens an uncertain step, and a new id repeats its handler", async (t) => {
  // The first call for step `verify` throws: the service records `uncertain`.
  const f = await fixture(t, async (call) => {
    if (call === 2) throw new Error("connection reset");
  });
  await f.advance("prepare", 1, "prepare");

  // Admit, CallHandler, Commit (first): recorded uncertain by its worker.
  const first = await f.advance("verify", 2, "first");
  assert.equal(first.state, "uncertain");
  await assert.rejects(
    f.advance("verify", first.revision, "blocked"),
    /denied/,
  );

  // RevalidateStart, RevalidateFinish: the provider no longer vouches for `prepare`.
  f.evidence.valid = false;
  const revalidated = await f.commands.revalidate(actor, f.run.id);
  f.evidence.valid = true;
  assert.equal(
    (await f.step("verify")).state,
    "failed",
    "finding 4: the uncertain step is open to a new id",
  );

  // The earlier step is done again, then Admit, CallHandler (second).
  const prepared = await f.advance(
    "prepare",
    revalidated.revision,
    "prepare-again",
  );
  const before = f.calls();
  const second = await f.advance("verify", prepared.revision, "second");
  assert.equal(second.state, "complete");
  assert.equal(f.calls(), before + 1, "the handler ran again for the step");
  assert.deepEqual(
    states(await f.records("command")).filter(
      ([id]) => id === "first" || id === "second",
    ),
    [
      ["first", "uncertain"],
      ["second", "complete"],
    ],
  );
});

test("finding 4: the same after a takeover, with its reconciliation task still pending", async (t) => {
  const stuck = hanging();
  let held = false;
  const f = await fixture(t, (call) => {
    if (call === 2 && !held) {
      held = true;
      return stuck.wait;
    }
    return Promise.resolve();
  });
  await f.advance("prepare", 1, "prepare");

  // Admit, CallHandler, LeaseExpires, Takeover (first).
  const first = f.advance("verify", 2, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 2);
  f.leaseRunsOut();
  assert.equal((await f.advance("verify", 2, "first")).state, "uncertain");

  f.evidence.valid = false;
  const revalidated = await f.commands.revalidate(actor, f.run.id);
  f.evidence.valid = true;
  const prepared = await f.advance(
    "prepare",
    revalidated.revision,
    "prepare-again",
  );
  const before = f.calls();
  const second = await f.advance("verify", prepared.revision, "second");
  assert.equal(second.state, "complete");
  assert.equal(f.calls(), before + 1);
  assert.deepEqual(
    (await f.records("outbox")).map((o) => [o.id, o.task, o.status]),
    [["reconciliation:first", "reconciliation-required", "pending"]],
  );

  stuck.release();
  await first.catch(() => undefined);
});
