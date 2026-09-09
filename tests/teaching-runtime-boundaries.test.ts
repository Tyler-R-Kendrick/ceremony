import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../src/core/recipe-contracts.js";
import type { RunRecord } from "../src/server/commands.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};
const context = {
  provider: "github",
  profile: "github-app",
  target: "account",
  origin: "https://app.example",
  environment: "test",
  configurationVersion: "v1",
};
const recipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "fixture",
  title: "Fixture",
  description: "Public argument fixture",
  inputs: { target: { contract: "target", required: true } },
  invocations: [
    {
      id: "node",
      use: { kind: "operation", id: "verify", version: "1.0.0" },
      dependsOn: [],
      bindings: { target: { from: "input", name: "target" } },
    },
  ],
  outputs: {},
};
function fixture() {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  const registry = new OperationRegistry(
    new Map([
      [
        "target",
        { classification: "public" as const, schema: z.string().min(1) },
      ],
      ["private", { classification: "secret" as const, schema: z.string() }],
    ]),
  );
  let effects = 0,
    deliveries = 0,
    denied = "";
  let onAuthorize: ((id: string) => Promise<void>) | undefined;
  registry.register({
    contract: {
      id: "verify",
      version: "1.0.0",
      provider: "github",
      profile: "github-app",
      inputs: { target: { contract: "target", required: true } },
      outputs: {},
      effects: ["verify"],
      verifier: "fixture",
      humanFallback: "human",
    },
    inputSchema: z.strictObject({ target: z.string().min(1) }),
    outputSchema: z.strictObject({}),
    classifications: {
      target: { classification: "public", schema: z.string().min(1) },
    },
    fixtures: ["local"],
    handler: async () => {
      effects++;
      return { state: "complete", outputs: {} };
    },
    verify: async () => true,
  });
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => actor },
    origin: context.origin,
    context: async () => context,
    authorize: async (_, __, operation) => {
      await onAuthorize?.(operation);
      return operation !== denied;
    },
    continuation: {
      id: "task",
      handler: async () => {
        deliveries++;
      },
    },
  });
  return {
    store,
    runtime,
    effects: () => effects,
    deliveries: () => deliveries,
    deny: (id: string) => {
      denied = id;
    },
    duringAuthorization: (fn: (id: string) => Promise<void>) => {
      onAuthorize = fn;
    },
  };
}
test("AC-16 AC-26: recipe execution rejects unsupported and invalid public bindings before run admission", async () => {
  const f = fixture();
  try {
    for (const inputs of [
      { target: 4 },
      { target: "" },
      { target: "allowed", unknown: "injected" },
    ])
      await assert.rejects(
        f.runtime.executeRecipe(actor, recipe, inputs, "github"),
        /denied/,
      );
    await assert.rejects(
      f.runtime.executeRecipe(
        actor,
        {
          ...recipe,
          invocations: [
            {
              ...recipe.invocations[0]!,
              use: { kind: "operation", id: "missing", version: "1.0.0" },
            },
          ],
        },
        { target: "allowed" },
        "github",
      ),
      /invalid_request/,
    );
    assert.equal(
      (await f.store.transaction((tx) => tx.list("tenant", "run"))).length,
      0,
    );
    const run = await f.runtime.executeRecipe(
      actor,
      recipe,
      { target: "allowed" },
      "github",
    );
    assert.equal(f.effects(), 0);
    await f.runtime.commands.advance(
      actor,
      run.id,
      "node",
      run.revision,
      "execute",
    );
    assert.equal(f.effects(), 1);
  } finally {
    await f.store.close();
  }
});
test("AC-18: delegation rechecks host permission and revision after awaited authorization", async () => {
  const f = fixture();
  try {
    const run = await f.runtime.executeRecipe(
      actor,
      recipe,
      { target: "allowed" },
      "github",
    );
    f.deny("agent");
    await assert.rejects(f.runtime.delegate(actor, run.id), /denied/);
    f.deny("");
    f.duringAuthorization(async (operation) => {
      if (operation === "agent")
        await f.store.transaction(async (tx) => {
          const key = { tenant: "tenant", kind: "run" as const, id: run.id };
          const current = await tx.get<RunRecord>(key);
          await tx.put(key, current!.value, current!.revision);
        });
    });
    await assert.rejects(f.runtime.delegate(actor, run.id), /denied/);
    assert.equal(
      await f.store.transaction((tx) =>
        tx.get({ tenant: "workload", kind: "session", id: run.id }),
      ),
      undefined,
    );
    f.duringAuthorization(async () => {});
    await f.runtime.delegate(actor, run.id);
    f.deny("agent");
    await assert.rejects(f.runtime.agentActor(run.id), /denied/);
    f.deny("");
    const key = { tenant: "tenant", kind: "run" as const, id: run.id };
    const current = await f.store.transaction((tx) => tx.get(key));
    await f.store.transaction((tx) => tx.delete(key, current!.revision));
    await assert.rejects(f.runtime.agentActor(run.id), /denied/);
    assert.equal(f.effects(), 0);
  } finally {
    await f.store.close();
  }
});
test("AC-19 AC-35: continuation cannot resume a missing, foreign, unfinished, retargeted or newly denied host task", async () => {
  const f = fixture();
  try {
    const run = await f.runtime.executeRecipe(
      actor,
      recipe,
      { target: "allowed" },
      "github",
    );
    await f.runtime.commands.advance(
      actor,
      run.id,
      "node",
      run.revision,
      "execute",
    );
    const key = { tenant: "tenant", kind: "run" as const, id: run.id };
    const saved = (await f.store.transaction((tx) => tx.get<RunRecord>(key)))!;
    for (const changes of [
      { subjectId: "foreign" },
      { status: "active" },
      { continuation: "other-task" },
    ]) {
      await f.store.transaction(async (tx) => {
        const current = (await tx.get(key))!;
        await tx.put(key, { ...saved.value, ...changes }, current.revision);
      });
      await assert.rejects(f.runtime.flushContinuations(actor), /denied/);
    }
    await f.store.transaction(async (tx) => {
      const current = (await tx.get(key))!;
      await tx.delete(key, current.revision);
    });
    await assert.rejects(f.runtime.flushContinuations(actor), /denied/);
    await f.store.transaction((tx) => tx.put(key, saved.value, null));
    f.deny("continuation");
    await assert.rejects(f.runtime.flushContinuations(actor), /denied/);
    assert.equal(f.deliveries(), 0);
    f.deny("");
    await f.runtime.flushContinuations(actor);
    await f.runtime.flushContinuations(actor);
    assert.equal(f.deliveries(), 1);
  } finally {
    await f.store.close();
  }
});
