import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { ProtectedCommandService } from "../src/server/commands.js";
import {
  OperationRegistry,
  type OperationResult,
} from "../src/server/recipes/registry.js";
import { RecipeService } from "../src/server/recipes/index.js";
import {
  PersistenceConflict,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import { AuthorizationError } from "../src/server/identity.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type {
  RecipeDefinition,
  RecipeOutcome,
} from "../src/core/recipe-contracts.js";

/*
 * Success criteria and bounded retry on a recipe invocation, enforced by the
 * command service. The operation is a local fixture that reports a public
 * status output and, like an HTTP-backed handler would, the status code of
 * the exchange it performed.
 */

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher"],
};
const context = {
  provider: "probe",
  profile: "probe-api",
  target: "probe-target",
  origin: "https://app.example",
  environment: "test",
  configurationVersion: "v1",
};

type Attempt = {
  status: string;
  statusCode?: number;
  token?: string;
  state?: OperationResult["state"];
};

function fixture(t: TestContext, attempts: Attempt[], replay = true) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  t.after(() => store.close());
  const registry = new OperationRegistry(
    new Map([
      [
        "probe.status",
        { schema: z.string().max(40), classification: "public" as const },
      ],
      [
        "probe.token",
        { schema: z.string().max(80), classification: "secret" as const },
      ],
      [
        "probe.region",
        { schema: z.enum(["eu", "us"]), classification: "public" as const },
      ],
    ]),
  );
  let calls = 0;
  registry.register({
    contract: {
      id: "probe.check",
      version: "1.0.0",
      provider: "probe",
      profile: "probe-api",
      inputs: { region: { contract: "probe.region", required: true } },
      outputs: {
        status: { contract: "probe.status", required: true },
        token: { contract: "probe.token", required: false },
      },
      effects: ["read"],
      verifier: "probe",
      humanFallback: "none",
    },
    inputSchema: z.strictObject({ region: z.enum(["eu", "us"]) }),
    outputSchema: z.strictObject({
      status: z.string(),
      token: z.string().optional(),
    }),
    classifications: {
      region: { classification: "public", schema: z.enum(["eu", "us"]) },
    },
    fixtures: ["tests/recipe-outcome.test.ts"],
    ...(replay ? { replay: "read-only" as const } : {}),
    handler: async () => {
      const attempt = attempts[Math.min(calls, attempts.length - 1)]!;
      calls++;
      if (attempt.state && attempt.state !== "complete")
        return {
          state: attempt.state,
          outputs: {},
          response: { statusCode: attempt.statusCode ?? 500 },
        };
      return {
        state: "complete",
        outputs: {
          status: attempt.status,
          ...(attempt.token ? { token: attempt.token } : {}),
        },
        ...(attempt.statusCode === undefined
          ? {}
          : {
              response: {
                statusCode: attempt.statusCode,
                headers: { "x-trace": "trace-synthetic-7781" },
              },
            }),
      };
    },
    verify: async () => true,
  });
  const recipes = new RecipeService(store, registry);
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const recipe = (outcome: RecipeOutcome): RecipeDefinition => ({
    schemaVersion: 1,
    id: "probe-until-ready",
    title: "Probe until ready",
    description: "",
    inputs: { region: { contract: "probe.region", required: true } },
    invocations: [
      {
        id: "check",
        use: { kind: "operation", id: "probe.check", version: "1.0.0" },
        dependsOn: [],
        bindings: { region: { from: "input", name: "region" } },
        outcome,
      },
    ],
    outputs: { status: { node: "check", name: "status" } },
  });
  async function start(outcome: RecipeOutcome) {
    const preview = await recipes.preview(actor, recipe(outcome));
    assert.deepEqual(preview.diagnostics, []);
    return commands.createRun(
      actor,
      context,
      preview.leaves.map((leaf) => ({
        id: leaf.id,
        operationId: leaf.use.id,
        operationVersion: leaf.use.version,
        dependsOn: leaf.dependsOn,
        bindings: leaf.bindings,
        ...(leaf.outcome ? { outcome: leaf.outcome } : {}),
      })),
      { region: "eu" },
    );
  }
  async function advance(runId: string) {
    const snapshot = await commands.snapshot(actor, runId);
    return commands.advance(
      actor,
      runId,
      "check",
      snapshot.revision,
      `command:${randomUUID()}`,
    );
  }
  return {
    store,
    recipes,
    commands,
    recipe,
    start,
    advance,
    calls: () => calls,
  };
}

const ready: RecipeOutcome = {
  successCriteria: [
    "$steps.check.outputs.status == 'ready' && $statusCode == 200",
    "$inputs.region == 'eu'",
  ],
  retry: { limit: 2, afterMs: 0, criteria: ["$statusCode < 500"] },
  values: {
    "$steps.check.outputs.status": {
      from: "output",
      node: "check",
      name: "status",
    },
    "$inputs.region": { from: "input", name: "region" },
  },
};

test("a step that misses its success criteria fails, and a declared retry runs it again", async (t) => {
  const f = fixture(t, [
    { status: "pending", statusCode: 200 },
    { status: "ready", statusCode: 200 },
  ]);
  const run = await f.start(ready);
  const first = await f.advance(run.id);
  assert.deepEqual([first.state, first.verified], ["failed", false]);
  const waiting = await f.commands.snapshot(actor, run.id);
  assert.equal(waiting.status, "active");
  assert.equal(
    (waiting.nodes[0] as { retry?: { attempts: number } }).retry?.attempts,
    1,
  );
  const second = await f.advance(run.id);
  assert.deepEqual([second.state, second.verified], ["complete", true]);
  const done = await f.commands.snapshot(actor, run.id);
  assert.equal(done.status, "complete");
  assert.equal(f.calls(), 2);

  // Reported transport facts are evaluated and dropped, never recorded.
  const audit = await f.store.transaction((tx) =>
    tx.list(actor.tenantId, "audit", 100),
  );
  const visible = JSON.stringify([waiting, done, audit]);
  assert.equal(visible.includes("trace-synthetic-7781"), false);
});

test("retries are bounded: after the last one the step is exhausted and cannot run again", async (t) => {
  const f = fixture(t, [{ status: "pending", statusCode: 200 }]);
  const run = await f.start(ready);
  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal((await f.advance(run.id)).state, "failed");
  await assert.rejects(
    f.advance(run.id),
    (error) => error instanceof AuthorizationError && error.code === "denied",
  );
  assert.equal(f.calls(), 3, "one attempt and two retries, then none");
  const snapshot = await f.commands.snapshot(actor, run.id);
  assert.equal(snapshot.nodes[0]!.state, "failed");
  assert.equal("retry" in snapshot.nodes[0]!, false);
});

test("a retry whose criteria refuse the failure, or no retry at all, ends the step", async (t) => {
  const refused = fixture(t, [
    { status: "pending", statusCode: 503, state: "failed" },
  ]);
  const run = await refused.start(ready);
  assert.equal((await refused.advance(run.id)).state, "failed");
  await assert.rejects(refused.advance(run.id), AuthorizationError);
  assert.equal(refused.calls(), 1);

  const once = fixture(t, [{ status: "pending", statusCode: 200 }]);
  const single = await once.start({
    successCriteria: ready.successCriteria,
    values: ready.values,
  });
  assert.equal((await once.advance(single.id)).state, "failed");
  await assert.rejects(once.advance(single.id), AuthorizationError);
  assert.equal(once.calls(), 1);
});

test("a criterion over a fact the handler did not report fails closed", async (t) => {
  const f = fixture(t, [{ status: "ready" }]);
  const run = await f.start({
    successCriteria: ["$statusCode == 200"],
    values: {},
  });
  const result = await f.advance(run.id);
  assert.deepEqual([result.state, result.verified], ["failed", false]);
});

test("a retry is spaced: an early attempt is a conflict, not a new effect", async (t) => {
  const f = fixture(t, [
    { status: "pending", statusCode: 200 },
    { status: "ready", statusCode: 200 },
  ]);
  const run = await f.start({
    ...ready,
    retry: { ...ready.retry!, afterMs: 60_000 },
  });
  assert.equal((await f.advance(run.id)).state, "failed");
  await assert.rejects(f.advance(run.id), PersistenceConflict);
  assert.equal(f.calls(), 1);
});

test("validation refuses retries without replay evidence, private values and unsupported references", async (t) => {
  const unsafe = fixture(t, [{ status: "ready", statusCode: 200 }], false);
  const retrying = await unsafe.recipes.preview(actor, unsafe.recipe(ready));
  assert.deepEqual(retrying.diagnostics, [
    { code: "retry-not-replay-safe", node: "check" },
  ]);
  // The command service refuses the plan too, whatever produced it.
  await assert.rejects(
    unsafe.commands.createRun(
      actor,
      context,
      [
        {
          id: "check",
          operationId: "probe.check",
          operationVersion: "1.0.0",
          dependsOn: [],
          bindings: { region: { from: "input", name: "region" } },
          outcome: retrying.leaves[0]!.outcome!,
        },
      ],
      { region: "eu" },
    ),
    AuthorizationError,
  );

  const f = fixture(t, [{ status: "ready", statusCode: 200 }]);
  const secret = await f.recipes.preview(
    actor,
    f.recipe({
      successCriteria: ["$steps.check.outputs.token == 'guess'"],
      values: {
        "$steps.check.outputs.token": {
          from: "output",
          node: "check",
          name: "token",
        },
      },
    }),
  );
  assert.deepEqual(secret.diagnostics, [
    { code: "private-criterion-value", node: "check" },
  ]);
  const body = await f.recipes.preview(
    actor,
    f.recipe({ successCriteria: ["$response.body#/ok == true"], values: {} }),
  );
  assert.deepEqual(body.diagnostics, [
    { code: "unsupported-criterion", node: "check" },
  ]);
  const unbound = await f.recipes.preview(
    actor,
    f.recipe({
      successCriteria: ["$steps.check.outputs.status == 'ready'"],
      values: {},
    }),
  );
  assert.deepEqual(unbound.diagnostics, [
    { code: "unbound-criterion-value", node: "check" },
  ]);
  const syntax = await f.recipes.preview(
    actor,
    f.recipe({ successCriteria: ["$statusCode =="], values: {} }),
  );
  assert.deepEqual(syntax.diagnostics, [
    { code: "invalid-criterion", node: "check" },
  ]);
});
