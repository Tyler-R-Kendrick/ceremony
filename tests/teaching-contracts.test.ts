import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { z } from "zod";
import {
  recipeDefinitionSchema,
  parseRecipeImport,
  canonicalRecipeDefinition,
  digestRecipeDefinition,
  RECIPE_LIMITS,
  type RecipeDefinition,
} from "../src/core/recipe-contracts.js";
import {
  actorContextSchema,
  operationContractSchema,
} from "../src/core/operation-contracts.js";
import {
  commandEnvelopeSchema,
  demonstrationEventSchema,
  type DemonstrationEvent,
} from "../src/core/teaching-contracts.js";
import {
  agentProjection,
  humanProjection,
  demonstrationProjection,
  exportProjection,
  auditProjection,
  classifyField,
} from "../src/core/projections.js";
import { fieldSchema, type CeremonySnapshot } from "../src/core/schema.js";

const recipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "connect",
  title: "Connect",
  description: "Reviewed procedure",
  inputs: { target: { contract: "github.target", required: true } },
  invocations: [
    {
      id: "prepare",
      use: { kind: "operation", id: "github.prepare", version: "1.0.0" },
      dependsOn: [],
      bindings: { target: { from: "input", name: "target" } },
    },
  ],
  outputs: { setup: { node: "prepare", name: "setup" } },
};
const event: DemonstrationEvent = {
  schemaVersion: 1,
  eventId: "event-1",
  demonstrationId: "demo-1",
  sequence: 1,
  nodeId: "prepare",
  operationId: "github.prepare",
  operationVersion: "1.0.0",
  actorKind: "human",
  kind: "verification",
  beforeState: "waiting",
  afterState: "complete",
  publicBindings: {},
  verification: "accepted",
};
const snapshot: CeremonySnapshot = {
  id: "run-1",
  revision: 2,
  connectorId: "github",
  connectorName: "GitHub",
  description: "Connect",
  method: {
    id: "device",
    label: "Device",
    kind: "device",
    fields: [],
    scopes: [],
    templateId: "device",
  },
  step: "waiting",
  fields: [],
  actions: ["cancel"],
  expiresAt: 10000,
  userCode: "PRIVATE-CODE",
  verificationUri: "https://github.com/login/device",
  authorizationUrl: "https://github.com/authorize?state=private",
  message: "private error",
  outcome: {
    connectionRef: "private-ref",
    ownership: "authenticated",
    scopes: [],
  },
  prerequisites: [{ id: "setup", label: "Setup", status: "succeeded" }],
};

test("AC-21: human optional protocol fields remain absent when unavailable and agent projection never inherits them", () => {
  const {
    authorizationUrl,
    verificationUri,
    userCode,
    message,
    outcome,
    prerequisites,
    ...minimal
  } = snapshot;
  const human = humanProjection(minimal);
  for (const name of [
    "authorizationUrl",
    "verificationUri",
    "userCode",
    "message",
    "outcome",
    "prerequisites",
  ])
    assert.equal(Object.hasOwn(human, name), false);
  assert.equal(agentProjection(minimal).ownership, null);
  assert.deepEqual(agentProjection(minimal).prerequisites, []);
  const projected = demonstrationProjection(
    { ...event, publicBindings: { invalid: "wrong", object: null } },
    {
      missing: { classification: "public", schema: z.string() },
      invalid: { classification: "public", schema: z.number() },
      object: {
        classification: "public",
        schema: z.any().transform(() => ({ forbidden: "nested" })),
      },
    },
  );
  assert.deepEqual(projected.publicBindings, {});
  assert.equal(
    authorizationUrl !== undefined &&
      verificationUri !== undefined &&
      userCode !== undefined &&
      message !== undefined &&
      outcome !== undefined &&
      prerequisites !== undefined,
    true,
  );
});

test("TYP-01 AC-22 legacy text is unclassified and credentials cannot downgrade", () => {
  for (const type of ["text", "email"] as const)
    assert.equal(
      classifyField({ name: "value", label: "Value", type, required: true }),
      "unclassified",
    );
  assert.equal(
    classifyField({
      name: "token",
      label: "Token",
      type: "text",
      required: true,
      classification: "public",
    }),
    "secret",
  );
  assert.equal(
    classifyField({
      name: "region",
      label: "Region",
      type: "text",
      required: true,
      classification: "public",
    }),
    "public",
  );
  for (const classification of [
    "public",
    "personal",
    "artifact",
    "unclassified",
  ])
    assert.equal(
      fieldSchema.safeParse({
        name: "password",
        label: "Password",
        type: "password",
        required: true,
        classification,
      }).success,
      false,
    );
});

test("TYP-02 AC-21 destination projections exclude canaries by construction", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 100 }), (secret) => {
      const state = {
        ...snapshot,
        userCode: secret,
        message: secret,
        outcome: { ...snapshot.outcome!, connectionRef: secret },
      };
      const agent = agentProjection(state);
      assert.deepEqual(
        Object.keys(agent).sort(),
        [
          "actions",
          "connectorId",
          "fields",
          "id",
          "methodId",
          "ownership",
          "prerequisites",
          "revision",
          "step",
        ].sort(),
      );
      assert.equal(Object.hasOwn(agent, "userCode"), false);
      assert.equal(Object.hasOwn(agent, "outcome"), false);
      assert.equal(humanProjection(state).userCode, secret);
      const projected = demonstrationProjection(
        {
          ...event,
          publicBindings: {
            secret,
            unknown: secret,
            choice: "personal",
            nested: { token: secret } as never,
          },
        },
        {
          secret: { classification: "secret", schema: z.string() },
          choice: {
            classification: "public",
            schema: z.enum(["personal", "organization"]),
          },
        },
      );
      assert.deepEqual(projected.publicBindings, { choice: "personal" });
      assert.equal(
        Object.hasOwn(auditProjection(projected), "publicBindings"),
        false,
      );
    }),
  );
  assert.deepEqual(
    demonstrationProjection(
      { ...event, publicBindings: { choice: "wildcard" } },
      { choice: { classification: "public", schema: z.enum(["personal"]) } },
    ).publicBindings,
    {},
  );
});

test("TYP-03 AC-11 strict imports reject authority, references and executable structures", () => {
  assert.deepEqual(parseRecipeImport(JSON.stringify(recipe)), recipe);
  for (const key of [
    "published",
    "digest",
    "owner",
    "connectionRef",
    "runId",
    "_meta",
  ])
    assert.throws(() =>
      parseRecipeImport(JSON.stringify({ ...recipe, [key]: "injected" })),
    );
  for (const use of [
    { kind: "javascript", source: "eval()" },
    { kind: "operation", id: "https://attacker.test", version: "1.0.0" },
    { kind: "operation", id: "constructor", version: "1.0.0" },
    { kind: "operation", id: "github.prepare", version: "latest" },
  ])
    assert.equal(
      recipeDefinitionSchema.safeParse({
        ...recipe,
        invocations: [{ ...recipe.invocations[0], use }],
      }).success,
      false,
    );
  assert.throws(() =>
    parseRecipeImport(
      JSON.stringify(recipe).replace(
        '"target":{"contract"',
        '"__proto__":{"contract"',
      ),
    ),
  );
  assert.throws(() =>
    parseRecipeImport(
      JSON.stringify({
        ...recipe,
        inputs: {
          target: {
            contract: "github.target",
            required: true,
            $ref: "https://attacker.test",
          },
        },
      }),
    ),
  );
  assert.throws(() => exportProjection({ ...recipe, author: "original" }));
});

test("TYP-03 AC-26 graph and exact byte limits reject rather than truncate", () => {
  const serialized = JSON.stringify(recipe);
  assert.deepEqual(
    parseRecipeImport(
      serialized +
        " ".repeat(
          RECIPE_LIMITS.bytes - new TextEncoder().encode(serialized).byteLength,
        ),
    ),
    recipe,
  );
  assert.throws(
    () => parseRecipeImport(" ".repeat(RECIPE_LIMITS.bytes + 1)),
    /limit/,
  );
  const nodes = Array.from({ length: 32 }, (_, i) => ({
    ...recipe.invocations[0]!,
    id: `node-${i}`,
  }));
  assert.equal(
    recipeDefinitionSchema.safeParse({
      ...recipe,
      invocations: nodes,
      outputs: {},
    }).success,
    true,
  );
  assert.equal(
    recipeDefinitionSchema.safeParse({
      ...recipe,
      invocations: [...nodes, { ...nodes[0], id: "overflow" }],
      outputs: {},
    }).success,
    false,
  );
  for (const invocations of [
    [recipe.invocations[0], recipe.invocations[0]],
    [{ ...recipe.invocations[0], dependsOn: ["missing"] }],
    [{ ...recipe.invocations[0], dependsOn: ["prepare"] }],
    [
      {
        ...recipe.invocations[0],
        bindings: { target: { from: "input", name: "missing" } },
      },
    ],
    [
      {
        ...recipe.invocations[0],
        bindings: {
          target: { from: "output", node: "missing", name: "value" },
        },
      },
    ],
  ])
    assert.equal(
      recipeDefinitionSchema.safeParse({ ...recipe, invocations }).success,
      false,
    );
  assert.equal(
    recipeDefinitionSchema.safeParse({
      ...recipe,
      outputs: { setup: { node: "missing", name: "setup" } },
    }).success,
    false,
  );
});

test("TYP-04 digest is stable under key order but changes with semantics", async () => {
  const reversed = Object.fromEntries(Object.entries(recipe).reverse());
  assert.equal(
    canonicalRecipeDefinition(recipe),
    canonicalRecipeDefinition(reversed),
  );
  assert.equal(
    await digestRecipeDefinition(recipe),
    await digestRecipeDefinition(reversed),
  );
  assert.notEqual(
    await digestRecipeDefinition(recipe),
    await digestRecipeDefinition({ ...recipe, title: "Changed" }),
  );
});

test("TYP-05 strict actor/command/event interfaces do not authenticate imported claims", () => {
  const actor = {
    tenantId: "tenant",
    subjectId: "oidc|123",
    sessionId: "12345",
    actorKind: "human",
    capabilities: ["executor"],
  };
  assert.equal(actorContextSchema.safeParse(actor).success, true);
  assert.equal(
    actorContextSchema.safeParse({ ...actor, owner: "administrator" }).success,
    false,
  );
  const command = {
    commandId: "cmd-1",
    runId: "run-1",
    nodeId: "prepare",
    expectedRevision: 0,
    operationId: "github.prepare",
    operationVersion: "1.0.0",
    bindings: {},
  };
  assert.equal(commandEnvelopeSchema.safeParse(command).success, true);
  assert.equal(
    commandEnvelopeSchema.safeParse({ ...command, source: "ui" }).success,
    false,
  );
  assert.equal(demonstrationEventSchema.safeParse(event).success, true);
  assert.equal(
    demonstrationEventSchema.safeParse({
      ...event,
      diagnosticCode: "provider dumped secret",
    }).success,
    false,
  );
  assert.equal(
    operationContractSchema.safeParse({
      id: "github.prepare",
      version: "1.0.0",
      provider: "github",
      profile: "app",
      inputs: {},
      outputs: {},
      effects: ["registration"],
      verifier: "github.verify",
      humanFallback: "browser-consent",
    }).success,
    true,
  );
});
