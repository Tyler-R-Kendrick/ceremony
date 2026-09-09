import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AuthorizationError } from "../../src/server/identity.js";
import {
  ProtectedCommandService,
  type RunPlanNode,
} from "../../src/server/commands.js";
import {
  OperationRegistry,
  type OperationResult,
} from "../../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";

test("AC-16 AC-25: command bindings reject wrong state fields, unbound values, private literals and substituted commands before effects", async (t) => {
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "alice",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const context = {
    provider: "github",
    profile: "app",
    target: "alice",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "1",
  };
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const registry = new OperationRegistry(
    new Map([
      ["value", { schema: z.enum(["allowed"]), classification: "public" }],
    ]),
  );
  let effects = 0,
    authorized = true;
  let outcome: OperationResult = {
    state: "complete",
    outputs: { value: "allowed" },
  };
  for (const id of ["public", "private", "unclassified"])
    registry.register({
      contract: {
        id,
        version: "1.0.0",
        provider: "github",
        profile: "app",
        inputs: { value: { contract: "value", required: true } },
        outputs: { value: { contract: "value", required: true } },
        effects: ["read"],
        verifier: "provider",
        humanFallback: "consent",
      },
      inputSchema: z.strictObject({ value: z.literal("allowed") }),
      outputSchema: z.strictObject({ value: z.literal("allowed") }),
      classifications:
        id === "unclassified"
          ? {}
          : {
              value: {
                classification: id === "public" ? "public" : "secret",
                schema: z.literal("allowed"),
              },
            },
      fixtures: ["fixture"],
      handler: async () => {
        effects++;
        return structuredClone(outcome);
      },
      verify: async () => true,
    });
  const service = new ProtectedCommandService(
    store,
    registry,
    async () => authorized,
  );
  const node: RunPlanNode = {
    id: "step",
    operationId: "public",
    operationVersion: "1.0.0",
    dependsOn: [],
    bindings: { value: { from: "literal", value: "allowed" } },
  };
  for (const nodes of [
    [],
    [node, node],
    Array.from({ length: 33 }, (_, i) => ({ ...node, id: `step-${i}` })),
    [{ ...node, dependsOn: ["absent"] }],
  ])
    await assert.rejects(service.createRun(actor, context, nodes, {}));
  for (const changed of [
    { ...context, provider: "other" },
    { ...context, profile: "other" },
  ])
    await assert.rejects(service.createRun(actor, changed, [node], {}));
  authorized = false;
  await assert.rejects(service.createRun(actor, context, [node], {}));
  authorized = true;
  for (const invalid of [
    {
      ...node,
      bindings: { other: { from: "literal" as const, value: "allowed" } },
    },
    { ...node, operationId: "private" },
    { ...node, operationId: "unclassified" },
    {
      ...node,
      bindings: { value: { from: "input" as const, name: "missing" } },
    },
    {
      ...node,
      bindings: {
        value: { from: "output" as const, node: "missing", name: "value" },
      },
    },
    {
      ...node,
      bindings: { value: { from: "literal" as const, value: "wrong" } },
    },
  ]) {
    const run = await service.createRun(actor, context, [invalid], {});
    await assert.rejects(
      service.advance(actor, run.id, "step", 1, `invalid-${run.id}`),
      (error: unknown) =>
        invalid.operationId === "private" ||
        invalid.operationId === "unclassified"
          ? error instanceof AuthorizationError && error.code === "denied"
          : error instanceof Error,
    );
  }
  assert.equal(effects, 0);
  const run = await service.createRun(actor, context, [node], {});
  await assert.rejects(service.advance(actor, run.id, "absent", 1, "missing"));
  await assert.rejects(service.advance(actor, run.id, "step", 99, "stale"));
  await assert.rejects(
    service.execute(actor, {
      commandId: "substitute",
      runId: run.id,
      nodeId: "step",
      operationId: "private",
      operationVersion: "1.0.0",
      expectedRevision: 1,
      bindings: node.bindings,
    }),
  );
  await assert.rejects(
    service.execute(actor, {
      commandId: "substitute",
      runId: run.id,
      nodeId: "step",
      operationId: "public",
      operationVersion: "1.0.0",
      expectedRevision: 1,
      bindings: { value: { from: "literal", value: "changed" } },
    }),
  );
  await assert.rejects(
    service.advance(actor, run.id, "step", 1, "aborted", AbortSignal.abort()),
  );
  assert.equal(effects, 0);
  assert.equal(
    (await service.advance(actor, run.id, "step", 1, "valid")).verified,
    true,
  );
  await assert.rejects(
    service.snapshot({ ...actor, subjectId: "foreign" }, run.id),
    { code: "denied" },
  );
  await assert.rejects(service.advance(actor, run.id, "step", 2, "valid"), {
    code: "denied",
  });
  await assert.rejects(
    service.advance(actor, run.id, "step", 2, "new-after-complete"),
  );
  const hostBound = await service.createRun(
    actor,
    context,
    [
      {
        ...node,
        operationId: "private",
        bindings: { value: { from: "input", name: "host" } },
      },
    ],
    { host: "allowed" },
  );
  assert.equal(
    (await service.advance(actor, hostBound.id, "step", 1, "host-bound"))
      .verified,
    true,
  );
  const dependency = await service.createRun(
    actor,
    context,
    [
      node,
      {
        ...node,
        id: "consumer",
        dependsOn: ["step"],
        bindings: { value: { from: "output", node: "step", name: "value" } },
      },
    ],
    {},
  );
  await service.advance(actor, dependency.id, "step", 1, "producer");
  assert.equal(
    (await service.advance(actor, dependency.id, "consumer", 2, "consumer"))
      .verified,
    true,
  );
  outcome = { state: "complete", outputs: { value: "wrong" } };
  const malformed = await service.createRun(actor, context, [node], {});
  assert.equal(
    (await service.advance(actor, malformed.id, "step", 1, "malformed")).state,
    "uncertain",
  );
  outcome = { state: "awaiting-human", outputs: { value: "allowed" } };
  const leaking = await service.createRun(actor, context, [node], {});
  assert.equal(
    (await service.advance(actor, leaking.id, "step", 1, "leaking")).state,
    "uncertain",
  );
  assert.equal(
    JSON.stringify(await service.snapshot(actor, leaking.id)).includes(
      "outputs",
    ),
    false,
  );
});
