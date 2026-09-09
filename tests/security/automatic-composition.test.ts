import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  OperationRegistry,
  RecipeService,
} from "../../src/server/recipes/index.js";
import {
  SQLiteCeremonyStore,
  type AsyncCeremonyStore,
} from "../../src/server/persistence/index.js";
import { createTeachingRuntime } from "../../src/server/teaching-runtime.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../../src/core/recipe-contracts.js";

test("AC-08 AC-14: ordinary executor Connect composes different authors' fragments with fresh actor-bound artifacts and no model", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const author: ActorContext = {
    tenantId: "tenant",
    subjectId: "alice",
    sessionId: "alice-session",
    actorKind: "human",
    capabilities: ["author", "reviewer", "publisher", "executor", "admin"],
  };
  const executor: ActorContext = {
    ...author,
    subjectId: "charlie",
    sessionId: "charlie-session",
    capabilities: ["executor"],
  };
  const registry = new OperationRegistry(
    new Map(
      ["app", "installation", "connection"].map((name) => [
        `github.${name}`,
        {
          schema: z.string(),
          classification: "artifact" as const,
          provider: "github",
          profile: "github-app",
        },
      ]),
    ),
  );
  const effects: string[] = [];
  for (const [id, input, output] of [
    ["github.prepare-app", undefined, "app"],
    ["github.authorize-installation", "app", "installation"],
    ["github.verify-access", "installation", "connection"],
  ] as const)
    registry.register({
      contract: {
        id,
        version: "1.0.0",
        provider: "github",
        profile: "github-app",
        inputs: input
          ? { [input]: { contract: `github.${input}`, required: true } }
          : {},
        outputs: { [output]: { contract: `github.${output}`, required: true } },
        effects: ["read"],
        verifier: "github.provider",
        humanFallback: "github.own-browser",
      },
      inputSchema: z.strictObject(input ? { [input]: z.string() } : {}),
      outputSchema: z.strictObject({ [output]: z.string() }),
      classifications: {},
      fixtures: ["fixture"],
      handler: async (context, inputs) => {
        effects.push(context.actor.subjectId);
        if (input)
          assert.equal(inputs[input], `${context.actor.subjectId}:${input}`);
        return {
          state: "complete",
          outputs: { [output]: `${context.actor.subjectId}:${output}` },
        };
      },
      verify: async (context, result) =>
        result.outputs[output] === `${context.actor.subjectId}:${output}`,
    });
  const app: RecipeDefinition = {
    schemaVersion: 1,
    id: "recorded-app",
    title: "Prepare app",
    description: "",
    inputs: {},
    invocations: [
      {
        id: "prepare",
        use: { kind: "operation", id: "github.prepare-app", version: "1.0.0" },
        dependsOn: [],
        bindings: {},
      },
    ],
    outputs: { app: { node: "prepare", name: "app" } },
  };
  const tail: RecipeDefinition = {
    schemaVersion: 1,
    id: "recorded-install-access",
    title: "Install and verify",
    description: "",
    inputs: { app: { contract: "github.app", required: true } },
    invocations: [
      {
        id: "install",
        use: {
          kind: "operation",
          id: "github.authorize-installation",
          version: "1.0.0",
        },
        dependsOn: [],
        bindings: { app: { from: "input", name: "app" } },
      },
      {
        id: "verify",
        use: {
          kind: "operation",
          id: "github.verify-access",
          version: "1.0.0",
        },
        dependsOn: ["install"],
        bindings: {
          installation: {
            from: "output",
            node: "install",
            name: "installation",
          },
        },
      },
    ],
    outputs: { connection: { node: "verify", name: "connection" } },
  };
  const recipes = new RecipeService(store, registry);
  async function publish(actor: ActorContext, definition: RecipeDefinition) {
    const draft = await recipes.createDraft(actor, definition);
    await recipes.review(author, draft.id, draft.revision, draft.digest);
    return recipes.publish(author, draft.id, draft.revision, draft.digest);
  }
  const first = await publish(author, app);
  await publish({ ...author, subjectId: "bob" }, tail);
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => executor },
    origin: "https://app.example",
    context: async (actor) => ({
      provider: "github",
      profile: "github-app",
      target: actor.subjectId,
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "1",
    }),
    authorize: async () => true,
  });
  let run = await runtime.connect(executor, "github");
  assert.deepEqual(
    run.nodes.map((node) => node.id),
    ["part-1.prepare", "part-2.install", "part-2.verify"],
  );
  assert.equal(effects.length, 0);
  for (const node of run.nodes) {
    await runtime.commands.advance(
      executor,
      run.id,
      node.id,
      run.revision,
      `execute:${node.id}`,
    );
    run = await runtime.commands.snapshot(executor, run.id);
  }
  assert.equal(run.status, "complete");
  assert.deepEqual(effects, ["charlie", "charlie", "charlie"]);
  assert.equal((await runtime.connect(executor, "github")).id, run.id);
  assert.equal(effects.length, 3);
  assert.equal(
    (await store.transaction((tx) => tx.list("tenant", "budget"))).length,
    0,
  );
  await recipes.retire(author, app.id, first.version);
  await assert.rejects(
    recipes.getPublished(executor, app.id, first.version, first.digest),
  );
  assert.equal(
    await recipes.selectConnection(executor, {
      provider: "github",
      profile: "github-app",
      outputContract: "github.connection",
    }),
    undefined,
  );
  let calls = 0;
  const failing: AsyncCeremonyStore = {
    transaction: async (work) => {
      if (++calls === 2) throw new Error("Persistence unavailable");
      return store.transaction(work);
    },
    close: async () => {},
  };
  await assert.rejects(
    new RecipeService(failing, registry).selectConnection(executor, {
      provider: "github",
      profile: "github-app",
      outputContract: "github.connection",
    }),
    /Persistence unavailable/,
  );
  const next = await runtime.connect(
    { ...executor, subjectId: "dave", sessionId: "dave-session" },
    "github",
  );
  assert.deepEqual(
    next.nodes.map((node) => node.id),
    ["app", "installation", "access"],
  );
  assert.equal(effects.length, 3);
  const foreign = await recipes.selectConnection(
    { ...executor, tenantId: "foreign" },
    {
      provider: "github",
      profile: "github-app",
      outputContract: "github.connection",
    },
  );
  assert.equal(foreign, undefined);
});

test("AC-12 AC-13 AC-26: automatic selection respects latest pins, ambiguity, provider profile and bounded catalog work", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const author: ActorContext = {
    tenantId: "tenant",
    subjectId: "author",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["author", "reviewer", "publisher", "executor", "admin"],
  };
  const executor: ActorContext = {
    ...author,
    capabilities: ["executor"],
  };
  const registry = new OperationRegistry(
    new Map(
      ["setup", "connection", "a", "b"].map((name) => [
        name,
        { schema: z.string(), classification: "artifact" as const },
      ]),
    ),
  );
  const recipes = new RecipeService(store, registry);
  async function publish(
    name: string,
    input: string | undefined,
    output: string,
    provider = "github",
    operation = name,
  ) {
    if (!registry.get(operation, "1.0.0"))
      registry.register({
        contract: {
          id: operation,
          version: "1.0.0",
          provider,
          profile: "app",
          inputs: input ? { input: { contract: input, required: true } } : {},
          outputs: { output: { contract: output, required: true } },
          effects: ["read"],
          verifier: "provider",
          humanFallback: "consent",
        },
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.record(z.string(), z.unknown()),
        classifications: {},
        fixtures: ["fixture"],
        handler: async () => ({
          state: "complete",
          outputs: { output: "host-owned" },
        }),
        verify: async () => true,
      });
    const definition: RecipeDefinition = {
      schemaVersion: 1,
      id: name,
      title: name,
      description: "",
      inputs: input ? { input: { contract: input, required: true } } : {},
      invocations: [
        {
          id: "step",
          use: { kind: "operation", id: operation, version: "1.0.0" },
          dependsOn: [],
          bindings: input ? { input: { from: "input", name: "input" } } : {},
        },
      ],
      outputs: { output: { node: "step", name: "output" } },
    };
    const draft = await recipes.createDraft(author, definition);
    await recipes.review(author, draft.id, draft.revision, draft.digest);
    return recipes.publish(author, draft.id, draft.revision, draft.digest);
  }
  const profile = {
    provider: "github",
    profile: "app",
    outputContract: "connection",
  };
  await store.transaction((tx) =>
    tx.put(
      { tenant: "tenant", kind: "recipe", id: "legacy-counter" },
      { count: 1 },
      null,
    ),
  );
  const first = await publish("setup", undefined, "setup");
  await publish("tail", "setup", "connection");
  const second = await publish("setup", undefined, "setup");
  const selected = await recipes.selectConnection(executor, profile);
  assert.ok(selected);
  assert.equal(selected.invocations[0]!.use.kind, "recipe");
  assert.equal(selected.invocations[0]!.use.version, second.version);
  assert.notEqual(second.version, first.version);
  const duplicate = await publish("setup-duplicate", undefined, "setup");
  assert.equal(await recipes.selectConnection(executor, profile), undefined);
  await recipes.retire(author, duplicate.definition.id, duplicate.version);
  await publish("aaa-foreign", undefined, "connection", "stripe");
  assert.equal(
    (await recipes.selectConnection(executor, profile))!.invocations.length,
    2,
  );
  await publish("direct", undefined, "connection");
  assert.equal(
    (await recipes.selectConnection(executor, profile))!.invocations[0]!.use.id,
    "direct",
  );
  await publish("cycle-a", "b", "a");
  await publish("cycle-b", "a", "b");
  await publish("cycle-target", "a", "connection");
  assert.equal(
    (await recipes.selectConnection(executor, profile))!.invocations[0]!.use.id,
    "direct",
  );
  assert.equal(
    await recipes.selectConnection(executor, {
      ...profile,
      profile: "unavailable",
    }),
    undefined,
  );
  await store.transaction(async (tx) => {
    for (let index = 0; index < 257; index++)
      await tx.put(
        { tenant: "large", kind: "recipe", id: `entry:${index}` },
        { count: index },
        null,
      );
  });
  await assert.rejects(
    recipes.selectConnection({ ...executor, tenantId: "large" }, profile),
    /selection budget/,
  );
});
