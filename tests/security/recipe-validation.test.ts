import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  OperationRegistry,
  validateRecipe,
  compileDemonstration,
} from "../../src/server/recipes/index.js";
import {
  digestRecipeDefinition,
  type RecipeDefinition,
} from "../../src/core/recipe-contracts.js";
import type { DemonstrationEvent } from "../../src/core/teaching-contracts.js";

function fixture() {
  const registry = new OperationRegistry(
    new Map([
      ["setup", { schema: z.string(), classification: "artifact" }],
      ["public", { schema: z.literal("allowed"), classification: "public" }],
    ]),
  );
  for (const id of ["prepare", "consume", "public", "optional"])
    registry.register({
      contract: {
        id,
        version: "1.0.0",
        provider: "github",
        profile: "app",
        inputs:
          id === "consume"
            ? { setup: { contract: "setup", required: true } }
            : id === "public" || id === "optional"
              ? { value: { contract: "public", required: id === "public" } }
              : {},
        outputs:
          id === "prepare"
            ? { setup: { contract: "setup", required: true } }
            : {},
        effects: ["read"],
        verifier: "provider",
        humanFallback: "consent",
      },
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
      classifications: {},
      fixtures: ["fixture"],
      handler: async () => ({ state: "complete", outputs: {} }),
      verify: async () => true,
    });
  const definition: RecipeDefinition = {
    schemaVersion: 1,
    id: "prepare-step",
    title: "Prepare",
    description: "",
    inputs: {},
    invocations: [
      {
        id: "prepare",
        use: { kind: "operation", id: "prepare", version: "1.0.0" },
        dependsOn: [],
        bindings: {},
      },
    ],
    outputs: { setup: { node: "prepare", name: "setup" } },
  };
  return { registry, definition };
}
test("AC-11 AC-26: registered operation and binding vocabulary gates reject malformed executable definitions", async () => {
  const { registry, definition } = fixture();
  assert.equal(registry.catalog().length, 4);
  assert.throws(() => registry.register(registry.require("prepare", "1.0.0")));
  assert.throws(() => registry.require("invented", "1.0.0"));
  assert.throws(() =>
    registry.register({
      ...registry.require("prepare", "1.0.0"),
      contract: {
        ...registry.require("prepare", "1.0.0").contract,
        id: "unknown-contract",
        outputs: { unknown: { contract: "absent", required: true } },
      },
    }),
  );
  const check = (value: unknown) =>
    validateRecipe(value, registry, async () => {
      throw new Error("unavailable");
    });
  const variant = (
    id: string,
    bindings: RecipeDefinition["invocations"][number]["bindings"] = {},
    inputs: RecipeDefinition["inputs"] = {},
  ) => ({
    ...definition,
    inputs,
    outputs: {},
    invocations: [
      {
        id: "only",
        use: { kind: "operation" as const, id, version: "1.0.0" },
        dependsOn: [],
        bindings,
      },
    ],
  });
  for (const [value, code] of [
    [variant("invented"), "unsupported-operation"],
    [variant("consume"), "unbound-required-input"],
    [
      variant("public", { value: { from: "literal", value: "wrong" } }),
      "forbidden-literal",
    ],
    [
      variant("consume", { setup: { from: "literal", value: "reference" } }),
      "forbidden-literal",
    ],
    [
      variant("prepare", { unexpected: { from: "literal", value: true } }),
      "unknown-operation-input",
    ],
    [
      variant(
        "public",
        { value: { from: "input", name: "value" } },
        { value: { contract: "setup", required: true } },
      ),
      "incompatible-input",
    ],
    [
      variant(
        "prepare",
        {},
        { unknown: { contract: "unknown", required: true } },
      ),
      "unknown-input-contract",
    ],
    [
      {
        ...definition,
        outputs: { absent: { node: "prepare", name: "absent" } },
      },
      "missing-declared-output",
    ],
  ] as const)
    assert.ok(
      (await check(value)).diagnostics.some((d) => d.code === code),
      code,
    );
  assert.deepEqual((await check(variant("optional"))).diagnostics, []);
  const noProof = registry.require("prepare", "1.0.0");
  const { verify, ...withoutVerifier } = noProof;
  registry.register({
    ...withoutVerifier,
    contract: { ...noProof.contract, id: "no-proof" },
    fixtures: [],
  });
  assert.deepEqual(
    (await check(variant("no-proof"))).diagnostics.map((d) => d.code),
    ["missing-operation-fixtures", "missing-verifier"],
  );
  const child: RecipeDefinition = variant(
    "consume",
    { setup: { from: "input", name: "setup" } },
    { setup: { contract: "setup", required: true } },
  );
  const parent: RecipeDefinition = {
    ...definition,
    outputs: {},
    invocations: [
      {
        id: "child",
        use: {
          kind: "recipe",
          id: child.id,
          version: "1.0.0",
          digest: await digestRecipeDefinition(child),
        },
        dependsOn: [],
        bindings: {},
      },
    ],
  };
  assert.ok(
    (
      await validateRecipe(parent, registry, async () => child)
    ).diagnostics.some((d) => d.code === "missing-child-input"),
  );
  assert.ok(
    (
      await validateRecipe(
        {
          ...parent,
          invocations: [
            {
              ...parent.invocations[0]!,
              bindings: { extra: { from: "literal", value: true } },
            },
          ],
        },
        registry,
        async () => child,
      )
    ).diagnostics.some((d) => d.code === "unknown-child-input"),
  );
  assert.ok(
    (
      await validateRecipe(parent, registry, async () => definition)
    ).diagnostics.some((d) => d.code === "child-digest-mismatch"),
  );
  assert.ok(
    (await check(parent)).diagnostics.some(
      (d) => d.code === "unavailable-child",
    ),
  );
});

test("AC-09: compilation rejects noncontiguous and mixed-authoring timelines and preserves failure diagnostics", () => {
  const { registry } = fixture();
  const first: DemonstrationEvent = {
    schemaVersion: 1,
    eventId: "first",
    demonstrationId: "demo",
    sequence: 1,
    nodeId: "first",
    operationId: "prepare",
    operationVersion: "1.0.0",
    actorKind: "human",
    kind: "verification",
    beforeState: "pending",
    afterState: "complete",
    publicBindings: {},
    verification: "accepted",
  };
  const consume = {
    ...first,
    eventId: "second",
    sequence: 2,
    nodeId: "second",
    operationId: "consume",
  };
  const compiled = compileDemonstration(
    [first, consume],
    { first: 1, last: 2 },
    registry,
  );
  assert.deepEqual(compiled.definition.inputs, {});
  assert.deepEqual(compiled.definition.invocations[1]!.bindings.setup, {
    from: "output",
    node: "step-1",
    name: "setup",
  });
  for (const selection of [
    { first: 1, last: 0 },
    { first: 0.5, last: 2 },
    { first: 1, last: 2.5 },
    { first: 0, last: 2 },
    { first: 1, last: 3 },
  ])
    assert.throws(() =>
      compileDemonstration([first, consume], selection, registry),
    );
  assert.throws(() =>
    compileDemonstration(
      [first, { ...consume, sequence: 3 }],
      { first: 1, last: 3 },
      registry,
    ),
  );
  assert.throws(() =>
    compileDemonstration(
      [first, { ...consume, demonstrationId: "foreign" }],
      { first: 1, last: 2 },
      registry,
    ),
  );
  assert.throws(() =>
    compileDemonstration(
      Array.from({ length: 1001 }, () => first),
      { first: 1, last: 1 },
      registry,
    ),
  );
  assert.throws(() =>
    compileDemonstration(
      [{ ...first, kind: "transition", verification: "pending" }],
      { first: 1, last: 1 },
      registry,
    ),
  );
  const failure = {
    ...consume,
    kind: "failure" as const,
    verification: "rejected" as const,
  };
  assert.deepEqual(
    compileDemonstration(
      [first, failure],
      { first: 1, last: 2 },
      registry,
    ).diagnostics.map((d) => d.code),
    ["observed-failure", "incomplete-ending"],
  );
  assert.ok(
    compileDemonstration(
      [first, { ...consume, operationId: "unknown" }],
      { first: 1, last: 2 },
      registry,
    ).diagnostics.some((d) => d.code === "unsupported-operation"),
  );
  assert.equal(
    compileDemonstration(
      [first, { ...consume, nodeId: first.nodeId }],
      { first: 1, last: 2 },
      registry,
    ).definition.invocations.length,
    1,
  );
});
