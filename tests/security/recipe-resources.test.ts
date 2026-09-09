import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import {
  digestRecipeDefinition,
  type RecipeDefinition,
} from "../../src/core/recipe-contracts.js";
import {
  OperationRegistry,
  validateRecipe,
  RecipeService,
} from "../../src/server/recipes/index.js";

test("AC-08: independent fragments compose by typed dependency rather than selection order", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "reviewer",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["author", "reviewer", "publisher", "executor"],
  };
  const registry = new OperationRegistry(
    new Map([
      ["setup", { schema: z.string(), classification: "artifact" }],
      ["connection", { schema: z.string(), classification: "artifact" }],
    ]),
  );
  const references = [];
  const service = new RecipeService(store, registry);
  for (const id of ["prepare", "install"]) {
    const name = id === "prepare" ? "setup" : "connection";
    const inputs =
      id === "prepare" ? {} : { setup: { contract: "setup", required: true } };
    registry.register({
      contract: {
        id,
        version: "1.0.0",
        provider: "github",
        profile: "app",
        inputs,
        outputs: { [name]: { contract: name, required: true } },
        effects: ["read"],
        verifier: "provider",
        humanFallback: "consent",
      },
      inputSchema: z.strictObject(
        id === "prepare" ? {} : { setup: z.string() },
      ),
      outputSchema: z.strictObject({ [name]: z.string() }),
      classifications: {},
      fixtures: ["fixture"],
      handler: async () => ({
        state: "complete",
        outputs: { [name]: "protected" },
      }),
      verify: async () => true,
    });
    const definition: RecipeDefinition = {
      schemaVersion: 1,
      id,
      title: id,
      description: "",
      inputs,
      invocations: [
        {
          id,
          use: { kind: "operation", id, version: "1.0.0" },
          dependsOn: [],
          bindings:
            id === "prepare" ? {} : { setup: { from: "input", name: "setup" } },
        },
      ],
      outputs: { [name]: { node: id, name } },
    };
    const draft = await service.createDraft(
      { ...actor, subjectId: id },
      definition,
    );
    await service.review(actor, draft.id, draft.revision, draft.digest);
    const published = await service.publish(
      actor,
      draft.id,
      draft.revision,
      draft.digest,
    );
    references.push({
      id,
      version: published.version,
      digest: published.digest,
    });
  }
  for (const selected of [references, [...references].reverse()]) {
    const composed = await service.composePublished(actor, selected);
    assert.deepEqual(composed.diagnostics, []);
    assert.deepEqual(composed.definition.inputs, {});
    const preview = await service.preview(actor, composed.definition);
    assert.deepEqual(
      preview.leaves.map((leaf) => leaf.use.id),
      ["prepare", "install"],
    );
    assert.deepEqual(preview.leaves[1]!.bindings.setup, {
      from: "output",
      node: "part-1.prepare",
      name: "setup",
    });
  }
});

test("AC-26: repeated pinned child graphs terminate at the global expansion budget", async () => {
  const registry = new OperationRegistry();
  registry.register({
    contract: {
      id: "leaf",
      version: "1.0.0",
      provider: "github",
      profile: "app",
      inputs: {},
      outputs: {},
      effects: ["read"],
      verifier: "provider",
      humanFallback: "consent",
    },
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({}),
    classifications: {},
    fixtures: ["fixture"],
    handler: async () => ({ state: "complete", outputs: {} }),
    verify: async () => true,
  });
  const definitions = new Map<string, RecipeDefinition>();
  let child: RecipeDefinition = {
    schemaVersion: 1,
    id: "base",
    title: "Base",
    description: "",
    inputs: {},
    outputs: {},
    invocations: [
      {
        id: "leaf",
        use: { kind: "operation", id: "leaf", version: "1.0.0" },
        dependsOn: [],
        bindings: {},
      },
    ],
  };
  definitions.set(child.id, child);
  for (let depth = 0; depth < 7; depth++) {
    const use = {
      kind: "recipe" as const,
      id: child.id,
      version: "1.0.0",
      digest: await digestRecipeDefinition(child),
    };
    child = {
      ...child,
      id: `depth-${depth}`,
      invocations: Array.from({ length: 32 }, (_, index) => ({
        id: `part-${index}`,
        use,
        dependsOn: [],
        bindings: {},
      })),
    };
    definitions.set(child.id, child);
  }
  let resolutions = 0;
  const result = await validateRecipe(child, registry, async (id) => {
    resolutions++;
    assert.ok(
      resolutions <= 256,
      "Expansion must stop before traversing exponential child references",
    );
    return definitions.get(id)!;
  });
  assert.ok(
    result.diagnostics.some(
      (d) =>
        d.code === "recipe-leaf-limit" || d.code === "recipe-expansion-limit",
    ),
  );
  assert.equal(result.leaves.length, 32);
  assert.ok(resolutions <= 256);
});
