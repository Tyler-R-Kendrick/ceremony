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
import { teachingHttp } from "../src/server/teaching-http.js";

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
function fixture(connectorId?: string, continuation = true) {
  const runContext = connectorId
    ? { ...context, provider: "fixture-provider", profile: "fixture-key" }
    : context;
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
      provider: runContext.provider,
      profile: runContext.profile,
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
    ...(connectorId
      ? {
          connections: new Map([
            [
              connectorId,
              {
                definition: {
                  ...recipe,
                  inputs: {},
                  invocations: [
                    {
                      ...recipe.invocations[0]!,
                      bindings: {
                        target: { from: "literal", value: "account" },
                      },
                    },
                  ],
                },
                outputContract: "fixture.connection",
                revalidateOperation: "verify",
              },
            ],
          ]),
        }
      : {}),
    context: async () => runContext,
    authorize: async (_, __, operation) => {
      await onAuthorize?.(operation);
      return operation !== denied;
    },
    ...(continuation
      ? {
          continuation: {
            id: "task",
            handler: async () => {
              deliveries++;
            },
          },
        }
      : {}),
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
test("host-registered connectors use the shared HTTP runtime and unknown connectors cannot create runs", async () => {
  const f = fixture("custom");
  try {
    const call = (path: string, body?: unknown) =>
      teachingHttp(
        new Request(
          `https://app.example/api/v1/teaching${path}`,
          body === undefined
            ? {}
            : {
                method: "POST",
                headers: {
                  origin: context.origin,
                  "content-type": "application/json",
                },
                body: JSON.stringify(body),
              },
        ),
        f.runtime,
      );
    const capabilities = await call("/capabilities");
    assert.equal(capabilities.status, 200);
    assert.deepEqual((await capabilities.json()).connectors, ["custom"]);
    for (const connectorId of ["github", "unknown", "__proto__"]) {
      await assert.rejects(
        f.runtime.connect(actor, connectorId),
        /invalid_request/,
      );
      await assert.rejects(
        f.runtime.executeRecipe(
          actor,
          recipe,
          { target: "account" },
          connectorId,
        ),
        /invalid_request/,
      );
      assert.notEqual((await call("/runs", { connectorId })).status, 200);
    }
    assert.equal(
      (await f.store.transaction((tx) => tx.list("tenant", "run"))).length,
      0,
    );
    const connected = await call("/runs", { connectorId: "custom" });
    assert.equal(connected.status, 200);
    assert.equal(f.effects(), 1);
    const run = await f.runtime.connect(actor, "custom");
    assert.equal(run.status, "complete");
    const stored = await f.store.transaction((tx) =>
      tx.get<RunRecord>({
        tenant: actor.tenantId,
        kind: "run",
        id: run.id,
      }),
    );
    assert.equal(stored?.value.provider, "fixture-provider");
    assert.equal(stored?.value.profile, "fixture-key");
    assert.equal(f.effects(), 1);
    assert.equal(
      (await f.store.transaction((tx) => tx.list("tenant", "run"))).length,
      1,
    );
    f.deny("verify");
    const denied = await call("/tools/connect", { connectorId: "custom" });
    assert.notEqual(denied.status, 200);
    assert.equal(f.effects(), 1);
  } finally {
    await f.store.close();
  }
});
test("Connect reuses only the current authenticated session without destroying another session's parent", async () => {
  const f = fixture("custom");
  try {
    const first = await f.runtime.connect(actor, "custom", false);
    const otherSession = { ...actor, sessionId: "another-session" };
    const second = await f.runtime.connect(otherSession, "custom", false);
    assert.notEqual(second.id, first.id);
    assert.equal(
      (await f.runtime.connect(actor, "custom", false)).id,
      first.id,
    );
    assert.equal(
      (await f.runtime.connect(otherSession, "custom", false)).id,
      second.id,
    );
    assert.equal(
      (await f.runtime.commands.snapshot(actor, first.id)).status,
      "active",
    );
    assert.equal(f.effects(), 0);
    const records = await f.store.transaction((tx) =>
      tx.list<RunRecord>(actor.tenantId, "run"),
    );
    assert.deepEqual(records.map((r) => r.value.sessionId).sort(), [
      "another-session",
      "session",
    ]);
  } finally {
    await f.store.close();
  }
});
test("Connect binds reuse to the original host task, including hosts without continuations", async () => {
  for (const continuation of [true, false]) {
    const f = fixture("custom", continuation);
    try {
      const first = await f.runtime.connect(actor, "custom", false);
      assert.equal(
        (await f.runtime.connect(actor, "custom", false)).id,
        first.id,
      );
      await f.store.transaction(async (tx) => {
        const key = {
          tenant: actor.tenantId,
          kind: "run" as const,
          id: first.id,
        };
        const prior = (await tx.get<RunRecord>(key))!;
        await tx.put(
          key,
          { ...prior.value, continuation: "other-host-task" },
          prior.revision,
        );
      });
      const next = await f.runtime.connect(actor, "custom", false);
      assert.notEqual(next.id, first.id);
      assert.equal(f.effects(), 0);
      assert.equal(f.deliveries(), 0);
    } finally {
      await f.store.close();
    }
  }
});
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
