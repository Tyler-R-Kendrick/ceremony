import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  RecipeService,
  OperationRegistry,
  validateRecipe,
  compileDemonstration,
} from "../src/server/recipes/index.js";
import {
  digestRecipeDefinition,
  type RecipeDefinition,
} from "../src/core/recipe-contracts.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { DemonstrationEvent } from "../src/core/teaching-contracts.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "author",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["author", "reviewer", "publisher", "executor", "admin"],
};
function registry() {
  const registry = new OperationRegistry(
    new Map([
      [
        "target",
        {
          schema: z.enum(["personal", "organization"]),
          classification: "public" as const,
        },
      ],
      ["setup", { schema: z.string(), classification: "artifact" as const }],
    ]),
  );
  for (const id of ["prepare", "install"])
    registry.register({
      contract: {
        id,
        version: "1.0.0",
        provider: "github",
        profile: "app",
        inputs:
          id === "prepare"
            ? { target: { contract: "target", required: true } }
            : { setup: { contract: "setup", required: true } },
        outputs: { setup: { contract: "setup", required: true } },
        effects: [id],
        verifier: "verify",
        humanFallback: "consent",
      },
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
      classifications: {},
      fixtures: ["signed-provider-fixture"],
      handler: async () => ({ state: "complete", outputs: {} }),
      verify: async () => true,
    });
  return registry;
}
const definition: RecipeDefinition = {
  schemaVersion: 1,
  id: "setup",
  title: "Set up GitHub",
  description: "Prepare an app",
  inputs: { target: { contract: "target", required: true } },
  invocations: [
    {
      id: "prepare",
      use: { kind: "operation", id: "prepare", version: "1.0.0" },
      dependsOn: [],
      bindings: { target: { from: "input", name: "target" } },
    },
  ],
  outputs: { setup: { node: "prepare", name: "setup" } },
};
const noChildren = async () => {
  throw new Error("Unavailable");
};

test("ORC-01 AUT-07 strict recipe contracts reject unsafe literals, missing evidence and type mismatches", async () => {
  const operations = registry();
  assert.deepEqual(
    (await validateRecipe(definition, operations, noChildren)).diagnostics,
    [],
  );
  const bad = {
    ...definition,
    invocations: [
      {
        ...definition.invocations[0]!,
        use: { kind: "operation" as const, id: "install", version: "1.0.0" },
        bindings: {
          setup: { from: "literal" as const, value: "original-secret-ref" },
        },
      },
    ],
  };
  assert.ok(
    (await validateRecipe(bad, operations, noChildren)).diagnostics.some(
      (d) => d.code === "forbidden-literal",
    ),
  );
  assert.ok(
    (
      await validateRecipe(
        {
          ...definition,
          invocations: [{ ...definition.invocations[0]!, bindings: {} }],
        },
        operations,
        noChildren,
      )
    ).diagnostics.some((d) => d.code === "unbound-required-input"),
  );
  assert.ok(
    (
      await validateRecipe(
        {
          ...definition,
          invocations: [
            {
              ...definition.invocations[0]!,
              use: { kind: "operation", id: "invented", version: "1.0.0" },
            },
          ],
        },
        operations,
        noChildren,
      )
    ).diagnostics.some((d) => d.code === "unsupported-operation"),
  );
});

test("AUT-05 AC-12 durable review binds exact revisions and published parents pin independent child recipes", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: new Uint8Array(32).fill(7) },
  });
  try {
    const service = new RecipeService(store, registry());
    const first = await service.createDraft(actor, definition);
    await assert.rejects(
      service.publish(actor, first.id, first.revision, first.digest),
      /review/,
    );
    await service.review(actor, first.id, first.revision, first.digest);
    const child = await service.publish(
      actor,
      first.id,
      first.revision,
      first.digest,
    );
    const secondAuthor = { ...actor, subjectId: "second-author" };
    const parentDefinition: RecipeDefinition = {
      ...definition,
      id: "parent",
      invocations: [
        {
          id: "child",
          use: {
            kind: "recipe",
            id: child.definition.id,
            version: child.version,
            digest: child.digest,
          },
          dependsOn: [],
          bindings: { target: { from: "input", name: "target" } },
        },
        {
          id: "install",
          use: { kind: "operation", id: "install", version: "1.0.0" },
          dependsOn: ["child"],
          bindings: { setup: { from: "output", node: "child", name: "setup" } },
        },
      ],
      outputs: { setup: { node: "install", name: "setup" } },
    };
    const preview = await service.preview(secondAuthor, parentDefinition);
    assert.deepEqual(preview.diagnostics, []);
    assert.deepEqual(
      preview.leaves.map((node) => node.id),
      ["child.prepare", "install"],
    );
    assert.deepEqual(preview.leaves[1]!.bindings.setup, {
      from: "output",
      node: "child.prepare",
      name: "setup",
    });
    const parentDraft = await service.createDraft(
      secondAuthor,
      parentDefinition,
    );
    await service.review(
      actor,
      parentDraft.id,
      parentDraft.revision,
      parentDraft.digest,
    );
    const parent = await service.publish(
      actor,
      parentDraft.id,
      parentDraft.revision,
      parentDraft.digest,
    );
    assert.equal(Object.keys(parent.closure).length, 1);
    const edit = await service.editDraft(actor, first.id, first.revision, {
      ...definition,
      title: "New version",
    });
    await assert.rejects(
      service.publish(actor, first.id, edit.revision, edit.digest),
      /review/,
    );
    await service.review(actor, edit.id, edit.revision, edit.digest);
    const child2 = await service.publish(
      actor,
      edit.id,
      edit.revision,
      edit.digest,
    );
    assert.notEqual(child2.version, child.version);
    assert.equal(
      (
        await service.getPublished(
          actor,
          parent.definition.id,
          parent.version,
          parent.digest,
        )
      ).closure[`${child.definition.id}@${child.version}:${child.digest}`]!
        .title,
      definition.title,
    );
    await service.retire(actor, child.definition.id, child.version);
    await assert.rejects(
      service.getPublished(
        actor,
        parent.definition.id,
        parent.version,
        parent.digest,
      ),
      /unavailable/,
    );
    await assert.rejects(
      service.getDraft({ ...actor, tenantId: "foreign" }, first.id),
      /unavailable/,
    );
    await assert.rejects(
      service.publish(
        { ...actor, capabilities: ["executor"] },
        first.id,
        edit.revision,
        edit.digest,
      ),
      /denied/,
    );
  } finally {
    await store.close();
  }
});

test("AUT-01 AC-09 selected fragments require fresh inputs and do not retain demonstration values", async () => {
  const events: DemonstrationEvent[] = [1, 2].map((sequence) => ({
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    demonstrationId: "demo",
    sequence,
    nodeId: `node-${sequence}`,
    operationId: sequence === 1 ? "prepare" : "install",
    operationVersion: "1.0.0",
    actorKind: "human",
    kind: "verification",
    beforeState: "waiting",
    afterState: "complete",
    publicBindings: { target: "organization" },
    verification: "accepted",
  }));
  const partial = compileDemonstration(
    events,
    { first: 2, last: 2 },
    registry(),
  );
  assert.equal(partial.definition.invocations.length, 1);
  assert.deepEqual(partial.definition.inputs, {
    "step-1.setup": { contract: "setup", required: true },
  });
  assert.equal(
    JSON.stringify(partial.definition).includes("organization"),
    false,
  );
  assert.deepEqual(partial.diagnostics, []);
  assert.throws(
    () => compileDemonstration(events, { first: 0, last: 2 }, registry()),
    /contiguous/,
  );
  assert.throws(
    () =>
      compileDemonstration(
        [{ ...events[0]!, verification: "pending" }],
        { first: 1, last: 1 },
        registry(),
      ),
    /verified/,
  );
  const changed = { ...definition, title: "Another" };
  assert.notEqual(
    await digestRecipeDefinition(definition),
    await digestRecipeDefinition(changed),
  );
});
