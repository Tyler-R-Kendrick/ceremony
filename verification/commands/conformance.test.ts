// Ties Commands.tla to the real ProtectedCommandService, on the SQLite store.
//
// Part 1 shows, on the real code, each fact the model takes from it: one
// test for each guard or write of the model's actions. If one of these
// fails, the code no longer does what the model says it does.
//
// Part 2 replays each counterexample of the model against the real code,
// one call for each step of the path. A finding that is still present has a
// test that passes while it is present; when a fix lands, that test fails,
// which is the signal to update the model (see README.md in this folder). A
// finding that is fixed has a test that asserts the correct behaviour on the
// same path.
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
import {
  OperationRegistry,
  type OperationResult,
  type RegisteredOperation,
} from "../../src/server/recipes/registry.js";
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
 * decides how that call behaves: it may throw, hang, or return the result
 * the call reports (a complete, verified call when it returns nothing).
 * `evidence.valid` is what the provider says when a step is verified.
 * `replay` is what both operations are registered with.
 */
async function fixture(
  t: TestContext,
  handler: (call: number) => Promise<void | OperationResult> = async () => {},
  replay: NonNullable<RegisteredOperation["replay"]> = "reconciliation",
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
      replay,
      handler: async () => {
        calls++;
        return (
          (await handler(calls)) ?? {
            state: "complete",
            outputs: { verified: true },
          }
        );
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
  // The worker's result is not recorded. What the step and the command read
  // after a cancel is the subject of the finding 3 tests in Part 2.
  const prepare = await f.step("prepare");
  assert.notEqual(prepare.state, "complete");
  assert.equal(prepare.verified, false);
  assert.deepEqual(
    (await f.records("command")).filter((c) => c.state === "complete"),
    [],
  );
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
// Part 2: the findings, replayed. A test named "fixed" asserts the correct
// behaviour; every other test passes while its finding is present.
// ---------------------------------------------------------------------------

test("finding 1, fixed: once a command is admitted for a step, a second id is refused after its lease runs out, and the handler is not called again", async (t) => {
  const stuck = hanging();
  // Only the first handler call hangs, so a repeated call returns.
  const f = await fixture(t, (call) =>
    call === 1 ? stuck.wait : Promise.resolve(),
  );

  // Admit, CallHandler (first): the worker does not return from the provider.
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);

  // LeaseExpires, then a second id for the same step at the current revision.
  f.leaseRunsOut();
  const current = (await f.snapshot()).revision;
  await assert.rejects(f.advance("prepare", current, "second"));
  assert.equal(
    f.calls(),
    1,
    "finding 1: the handler ran twice for one step, the first call unrecorded",
  );
  assert.deepEqual(states(await f.records("command")), [["first", "running"]]);
  assert.deepEqual(
    (await f.records("effect")).map((e) => [e.commandId, e.status]),
    [["first", "intent-persisted"]],
  );

  // Takeover (first): the first id is resolved as uncertain, and a new id is
  // still refused.
  const replay = await f.advance("prepare", 1, "first");
  assert.equal(replay.state, "uncertain");
  await assert.rejects(
    f.advance("prepare", replay.revision, "second"),
    /denied/,
  );
  assert.equal(f.calls(), 1);

  stuck.release();
  await assert.rejects(first);
  assert.equal(f.calls(), 1);
});

test("finding 1, fixed: a second id is refused after a revalidation has taken and released the first command's lease", async (t) => {
  const stuck = hanging();
  // Only the first handler call hangs, so a repeated call returns.
  const f = await fixture(t, (call) =>
    call === 1 ? stuck.wait : Promise.resolve(),
  );

  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);

  // LeaseExpires, RevalidateStart, RevalidateFinish("nothing").
  f.leaseRunsOut();
  const revalidated = await f.commands.revalidate(actor, f.run.id);
  await assert.rejects(f.advance("prepare", revalidated.revision, "second"));
  assert.equal(f.calls(), 1);
  assert.deepEqual(states(await f.records("command")), [["first", "running"]]);

  stuck.release();
  await first.catch(() => undefined);
});

test("finding 2, fixed: the first id's takeover does not overwrite a step another command recorded complete", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, (call) =>
    call === 1 ? stuck.wait : Promise.resolve(),
  );

  // Admit, CallHandler (first): the worker does not return from the provider.
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);

  // LeaseExpires. The step is then recorded complete and verified, as the
  // commit of another command writes it.
  f.leaseRunsOut();
  await f.putStep("prepare", { state: "complete", verified: true });

  // Takeover (first): the same id is sent again.
  await f.advance("prepare", 1, "first");
  const prepare = await f.step("prepare");
  assert.deepEqual(
    [prepare.state, prepare.verified],
    ["complete", true],
    "finding 2: the verified step was overwritten",
  );
  assert.equal(f.calls(), 1);

  // The run moves on: the next step is admitted at the current revision.
  const next = await f.advance("verify", (await f.snapshot()).revision, "next");
  assert.deepEqual([next.state, next.verified], ["complete", true]);

  stuck.release();
  await first.catch(() => undefined);
});

/** What finding 3 requires once a command in flight met a cancel. */
async function settledUncertain(f: Awaited<ReturnType<typeof fixture>>) {
  // Every replay of the id returns `uncertain`, never `running`.
  for (let replay = 0; replay < 2; replay++) {
    const again = await f.advance("prepare", 1, "first");
    assert.deepEqual(
      [again.state, again.verified],
      ["uncertain", false],
      "finding 3: the command stays `running` after its run is cancelled",
    );
  }
  assert.deepEqual(states(await f.records("command")), [
    ["first", "uncertain"],
  ]);
  assert.deepEqual(
    (await f.records("effect")).map((e) => [e.commandId, e.status]),
    [["first", "uncertain"]],
  );
  assert.deepEqual(
    (await f.records("outbox")).map((o) => [o.id, o.task, o.status]),
    [["reconciliation:first", "reconciliation-required", "pending"]],
  );
  const prepare = await f.step("prepare");
  assert.deepEqual([prepare.state, prepare.verified], ["uncertain", false]);
  assert.equal((await f.snapshot()).status, "cancelled");
  // Nothing is run again: the handler was called once, and a new id is
  // refused.
  await assert.rejects(
    f.advance("prepare", (await f.snapshot()).revision, "second"),
  );
  assert.equal(f.calls(), 1);
}

test("finding 3, fixed: a command whose worker returns after its run is cancelled ends on record as uncertain, with a reconciliation task", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);

  // Admit, CallHandler, CancelRun, CommitRefused.
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);
  await f.commands.cancel(actor, f.run.id, 1);
  stuck.release();
  await assert.rejects(first);

  await settledUncertain(f);
});

test("finding 3, fixed: a command whose worker never returns after its run is cancelled ends on record as uncertain, with a reconciliation task", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, () => stuck.wait);

  // Admit, CallHandler, CancelRun; the worker is still in the provider call.
  const first = f.advance("prepare", 1, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 1);
  await f.commands.cancel(actor, f.run.id, 1);

  await settledUncertain(f);

  // The worker comes back late: its result is refused and changes nothing.
  stuck.release();
  await assert.rejects(first);
  await settledUncertain(f);
});

test("finding 3, second path closed with finding 1: a second command id cannot complete the run while the first is running, so the first id's takeover still records uncertain", async (t) => {
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
  const prepared = await f.advance("prepare", 1, "prepare");

  const first = f.advance("verify", prepared.revision, "first");
  first.catch(() => undefined);
  await until(() => f.calls() === 2);
  f.leaseRunsOut();
  await assert.rejects(
    f.advance("verify", (await f.snapshot()).revision, "second"),
  );
  assert.equal(f.calls(), 2);
  assert.equal((await f.snapshot()).status, "active");

  const replay = await f.advance("verify", prepared.revision, "first");
  assert.equal(replay.state, "uncertain");
  assert.deepEqual(
    (await f.records("outbox")).map((o) => [o.id, o.task, o.status]),
    [["reconciliation:first", "reconciliation-required", "pending"]],
  );

  stuck.release();
  await first.catch(() => undefined);
});

test("finding 4, fixed: a revalidation that rejects an earlier step leaves a dependent uncertain step uncertain, and a new id is refused", async (t) => {
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
  assert.deepEqual(
    revalidated.nodes.map((node) => [node.id, node.state, node.verified]),
    [
      ["prepare", "failed", false],
      ["verify", "uncertain", false],
    ],
    "finding 4: revalidation rewrites the uncertain step as failed",
  );

  // The earlier step is done again; a new id for `verify` is still refused.
  const prepared = await f.advance(
    "prepare",
    revalidated.revision,
    "prepare-again",
  );
  assert.equal(prepared.state, "complete");
  const before = f.calls();
  await assert.rejects(
    f.advance("verify", prepared.revision, "second"),
    /denied/,
    "finding 4: a new id is admitted for the reopened step",
  );
  assert.equal(f.calls(), before, "the handler ran again for the step");
  assert.equal((await f.step("verify")).state, "uncertain");
  assert.equal(
    (await f.advance("verify", 2, "first")).state,
    "uncertain",
    "the first id still reports uncertain",
  );
  assert.deepEqual(
    states(await f.records("command")).filter(
      ([id]) => id === "first" || id === "second",
    ),
    [["first", "uncertain"]],
  );
});

test("finding 4, fixed: the same after a takeover; the step stays uncertain and its reconciliation task stays pending", async (t) => {
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
  assert.equal(
    (await f.step("verify")).state,
    "uncertain",
    "finding 4: revalidation rewrites the uncertain step as failed",
  );
  const prepared = await f.advance(
    "prepare",
    revalidated.revision,
    "prepare-again",
  );
  assert.equal(prepared.state, "complete");
  const before = f.calls();
  await assert.rejects(
    f.advance("verify", prepared.revision, "second"),
    /denied/,
    "finding 4: a new id is admitted while the reconciliation task is pending",
  );
  assert.equal(f.calls(), before);
  assert.equal((await f.step("verify")).state, "uncertain");
  assert.deepEqual(
    (await f.records("outbox")).map((o) => [o.id, o.task, o.status]),
    [["reconciliation:first", "reconciliation-required", "pending"]],
  );

  stuck.release();
  await first.catch(() => undefined);
});

test("finding 4, fixed: a revalidation that rejects an earlier step leaves a dependent exhausted step exhausted, and a new id is refused", async (t) => {
  const f = await fixture(t);
  const prepared = await f.advance("prepare", 1, "prepare");
  assert.equal(prepared.state, "complete");
  // `verify` has no attempt left.
  await f.putStep("verify", {
    state: "failed",
    verified: false,
    attempts: 1,
    exhausted: true,
  });
  await assert.rejects(
    f.advance("verify", prepared.revision, "blocked"),
    /denied/,
  );

  f.evidence.valid = false;
  const revalidated = await f.commands.revalidate(actor, f.run.id);
  f.evidence.valid = true;
  assert.deepEqual(
    revalidated.nodes.map((node) => [node.id, node.state]),
    [
      ["prepare", "failed"],
      ["verify", "failed"],
    ],
  );

  const again = await f.advance(
    "prepare",
    revalidated.revision,
    "prepare-again",
  );
  assert.equal(again.state, "complete");
  const before = f.calls();
  await assert.rejects(
    f.advance("verify", again.revision, "second"),
    /denied/,
    "finding 4: revalidation drops `exhausted`, and a new id is admitted",
  );
  assert.equal(f.calls(), before);
});

// A revalidation that rewrites a step failed must keep the command that holds
// it (commands.ts:551); otherwise a new id is admitted while that command is
// still running and the step's handler is called twice.

test("finding 1, fixed: a revalidation that rewrites a step failed keeps the holder of a retry still in flight", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, (call) =>
    call === 3 ? stuck.wait : Promise.resolve(),
  );
  const p = await f.advance("prepare", 1, "p1");
  // verify's first attempt fails verification: step "failed", not exhausted.
  f.evidence.valid = false;
  const v1 = await f.advance("verify", p.revision, "v1");
  assert.equal(v1.state, "failed");
  f.evidence.valid = true;
  // A second attempt hangs.
  const v2 = f.advance("verify", v1.revision, "v2");
  v2.catch(() => undefined);
  await until(() => f.calls() === 3);
  f.leaseRunsOut();
  // The provider no longer vouches for prepare: prepare and verify are rewritten failed.
  f.evidence.valid = false;
  const r = await f.commands.revalidate(actor, f.run.id);
  f.evidence.valid = true;
  const p2 = await f.advance("prepare", r.revision, "p2");
  assert.equal(p2.state, "complete");
  await assert.rejects(f.advance("verify", p2.revision, "v3"));
  assert.equal(
    f.calls(),
    4,
    "the handler for verify ran again while v2 was running",
  );
  stuck.release();
  await v2.catch(() => undefined);
});

test("finding 1, fixed: a revalidation that rewrites a step failed keeps the holder of a first command still in flight", async (t) => {
  const stuck = hanging();
  const f = await fixture(t, (call) =>
    call === 2 ? stuck.wait : Promise.resolve(),
  );
  const p = await f.advance("prepare", 1, "p1");
  const v1 = f.advance("verify", p.revision, "v1");
  v1.catch(() => undefined);
  await until(() => f.calls() === 2);
  f.leaseRunsOut();
  f.evidence.valid = false;
  const r = await f.commands.revalidate(actor, f.run.id);
  f.evidence.valid = true;
  const p2 = await f.advance("prepare", r.revision, "p2");
  assert.equal(p2.state, "complete");
  await assert.rejects(f.advance("verify", p2.revision, "v2"));
  assert.equal(f.calls(), 3);
  stuck.release();
  await v1.catch(() => undefined);
});

// Finding 5: an `uncertain` step had no way out. A step recorded `uncertain`
// refuses every new command id, and only the takeover and the cancel wrote
// a reconciliation entry; a handler that threw (or returned `uncertain`)
// was committed with none, so nothing would ever resolve the step. The
// tests below assert the declared way out: an operation registered with
// replay "read-only" may be run again by a new id, and every command
// recorded `uncertain` has a pending reconciliation entry, which the run's
// snapshot shows on the step as `reconciliation: { commandId, status }`.

/** The reconciliation the snapshot shows on a step, if any. */
const reconciliationOf = (step: object) =>
  (step as { reconciliation?: unknown }).reconciliation;

test('finding 5, fixed: a handler that throws, on an operation registered replay "reconciliation", leaves a pending reconciliation entry shown on the step, and a new id is refused', async (t) => {
  const f = await fixture(t, async () => {
    throw new Error("connection reset");
  });
  const first = await f.advance("prepare", 1, "first");
  assert.equal(first.state, "uncertain");
  assert.deepEqual(states(await f.records("command")), [
    ["first", "uncertain"],
  ]);
  assert.deepEqual(
    (await f.records("outbox")).map((o) => [o.id, o.task, o.status]),
    [["reconciliation:first", "reconciliation-required", "pending"]],
    "finding 5: a handler that threw left no reconciliation entry",
  );
  const prepare = await f.step("prepare");
  assert.equal(prepare.state, "uncertain");
  assert.deepEqual(
    reconciliationOf(prepare),
    { commandId: "first", status: "pending" },
    "finding 5: the run does not show the pending reconciliation",
  );
  await assert.rejects(
    f.advance("prepare", first.revision, "second"),
    /denied/,
  );
  assert.equal(f.calls(), 1);
});

test('finding 5, fixed: a handler that returns uncertain, on an operation registered replay "reconciliation", leaves a pending reconciliation entry', async (t) => {
  const f = await fixture(t, async () => ({ state: "uncertain", outputs: {} }));
  const first = await f.advance("prepare", 1, "first");
  assert.equal(first.state, "uncertain");
  assert.equal((await f.step("prepare")).state, "uncertain");
  assert.deepEqual(
    (await f.records("outbox")).map((o) => [o.id, o.task, o.status]),
    [["reconciliation:first", "reconciliation-required", "pending"]],
    "finding 5: an uncertain result left no reconciliation entry",
  );
  await assert.rejects(
    f.advance("prepare", first.revision, "second"),
    /denied/,
  );
  assert.equal(f.calls(), 1);
});

test('finding 5, fixed: a handler that throws, on an operation registered replay "read-only", leaves a reconciliation entry, and a new id runs the step again', async (t) => {
  const f = await fixture(
    t,
    async (call) => {
      if (call === 1) throw new Error("connection reset");
    },
    "read-only",
  );
  const first = await f.advance("prepare", 1, "first");
  assert.equal(first.state, "uncertain");
  assert.deepEqual(
    (await f.records("outbox")).map((o) => [o.id, o.task, o.status]),
    [["reconciliation:first", "reconciliation-required", "pending"]],
    "finding 5: a handler that threw left no reconciliation entry",
  );
  const second = await f.advance("prepare", first.revision, "second");
  assert.deepEqual(
    [second.state, second.verified],
    ["complete", true],
    "finding 5: a read-only step recorded uncertain refuses a new id",
  );
  assert.equal(f.calls(), 2);
  const prepare = await f.step("prepare");
  assert.deepEqual([prepare.state, prepare.verified], ["complete", true]);
  // The id that threw still reports what it recorded, and is not run again.
  assert.equal((await f.advance("prepare", 1, "first")).state, "uncertain");
  assert.equal(f.calls(), 2);
});
