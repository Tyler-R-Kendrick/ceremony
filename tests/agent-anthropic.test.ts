import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  configuredModel,
  modelConfigurationFromEnvironment,
} from "../src/server/agent/model.js";
import {
  AgentCoordinator,
  type AgentCommandPort,
} from "../src/server/agent/coordinator.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { AuthorizationError } from "../src/server/identity.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { scriptedModel, stepContext } from "./fixtures/agent-model.js";

// Synthetic only. The key must reach the fixture as a header and nowhere else.
const key = "fixture-anthropic-key-4d1c";
const secret = "ghp_anthropicCanary0123456789";
const actor: ActorContext = {
  tenantId: "tenant-canary",
  subjectId: "subject-canary",
  sessionId: "session-canary",
  actorKind: "human",
  capabilities: ["executor"],
};
type Snapshot = Awaited<ReturnType<AgentCommandPort["snapshot"]>>;

function port(first: "deny" | "complete") {
  const state = { complete: false, advances: 0 };
  const commands: AgentCommandPort = {
    snapshot: async () =>
      ({
        id: "run",
        revision: 1,
        provider: "github",
        profile: "app",
        status: state.complete ? "complete" : "active",
        nodes: [
          {
            id: "verify",
            operationId: "github.verify",
            operationVersion: "1.0.0",
            state: state.complete ? "complete" : "pending",
            verified: state.complete,
          },
        ],
        inputs: { token: secret },
      }) as unknown as Snapshot,
    advance: async (_actor, runId, nodeId, revision, commandId) => {
      state.advances++;
      if (first === "deny") throw new AuthorizationError("denied");
      state.complete = true;
      return {
        runId,
        nodeId,
        commandId,
        revision: revision + 1,
        state: "complete",
        verified: true,
      };
    },
  };
  return { state, commands };
}

test("AGT native Anthropic provider drives the tools over the Messages API shape", async (t) => {
  // Ambient provider variables must not be consulted for routing or credentials.
  const ambient = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
  process.env.ANTHROPIC_API_KEY = "ambient-canary-key";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/v1";
  const model = await scriptedModel("anthropic", (index) =>
    index === 0
      ? [{ name: "snapshot", input: {} }]
      : index === 1
        ? [
            {
              name: "advance",
              input: { nodeId: "verify", expectedRevision: 1 },
            },
          ]
        : [],
  );
  const db = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(async () => {
    for (const [name, value] of Object.entries(ambient))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await db.close();
    await model.close();
  });
  const configuration = modelConfigurationFromEnvironment({
    CEREMONY_MODEL_PROVIDER: "anthropic",
    CEREMONY_MODEL: "fixture-model",
    CEREMONY_MODEL_URL: `${model.origin}/v1/messages`,
    CEREMONY_MODEL_KEY: key,
  });
  const llm = configuredModel(configuration);
  const { state, commands } = port("complete");
  const coordinator = new AgentCoordinator(db, commands, llm);
  assert.deepEqual(await coordinator.turnOutcome(actor, "run", "turn"), {
    status: "complete",
  });
  assert.equal(state.advances, 1);
  assert.equal(model.requests.length, 2);
  for (const request of model.requests) {
    assert.equal(request.path, "/v1/messages");
    assert.equal(request.headers["x-api-key"], key);
    assert.equal(request.headers.authorization, undefined);
    assert.ok(request.headers["anthropic-version"]);
    assert.equal(request.body.model, "fixture-model");
    assert.deepEqual(
      (request.body.tools as { name: string }[])
        .map((entry) => entry.name)
        .sort(),
      ["advance", "request_human", "snapshot"],
    );
    // Rebuilt each step: one user message, no replayed tool_use history.
    assert.equal(request.body.messages.length, 1);
    for (const value of [
      key,
      "ambient-canary-key",
      secret,
      actor.subjectId,
      actor.sessionId,
    ])
      assert.equal(request.raw.includes(value), false);
  }
  assert.deepEqual(stepContext(model.requests[1]!).results, [
    { tool: "snapshot", output: "current" },
  ]);
  assert.equal((await coordinator.status(actor, "run")).tools, 2);
});

test("AGT Anthropic tool errors and handoff use the same fixed codes", async (t) => {
  const model = await scriptedModel("anthropic", (index) =>
    index === 0
      ? [{ name: "advance", input: { nodeId: "verify", expectedRevision: 1 } }]
      : [{ name: "request_human", input: { nodeId: "verify" } }],
  );
  const db = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(async () => {
    await db.close();
    await model.close();
  });
  const { commands } = port("deny");
  const coordinator = new AgentCoordinator(
    db,
    commands,
    configuredModel({
      provider: "anthropic",
      model: "fixture-model",
      endpoint: `${model.origin}/v1/messages`,
      apiKey: key,
    }),
  );
  assert.deepEqual(await coordinator.turnOutcome(actor, "run", "turn"), {
    status: "awaiting-human",
    handoff: {
      kind: "person",
      runId: "run",
      nodeId: "verify",
      operationId: "github.verify",
      nodeState: "pending",
      reason: "agent-request",
    },
  });
  assert.deepEqual(stepContext(model.requests[1]!).results, [
    { tool: "advance", output: { error: "denied" } },
  ]);
  assert.equal((await coordinator.status(actor, "run")).calls, 2);
});

test("AGT Anthropic configuration is explicit and fails closed", () => {
  const base = { provider: "anthropic" as const, apiKey: key };
  // Model ID is always the operator's; there is no default.
  assert.throws(() => configuredModel(base), /Invalid model configuration/);
  // No key means no fallback to ANTHROPIC_API_KEY.
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "ambient-canary-key";
  try {
    assert.throws(
      () => configuredModel({ provider: "anthropic", model: "fixture" }),
      /key is required/,
    );
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
  assert.throws(() =>
    configuredModel({ ...base, model: "fixture", gateway: true }),
  );
  for (const endpoint of [
    "https://api.example/v1/chat/completions",
    "https://user:pass@api.example/v1/messages",
    "http://remote.example/v1/messages",
    "https://api.example/v1/messages?key=private",
    "https://api.example/v1/messages#fragment",
  ])
    assert.throws(
      () => configuredModel({ ...base, model: "fixture", endpoint }),
      /endpoint/,
    );
  // Default destination is the public Messages API; nothing is sent here.
  assert.ok(configuredModel({ ...base, model: "fixture" }));
  // Unchanged: no configuration means no model and no paid fallback.
  assert.equal(
    configuredModel(modelConfigurationFromEnvironment({})),
    undefined,
  );
  assert.deepEqual(
    modelConfigurationFromEnvironment({
      CEREMONY_MODEL_PROVIDER: "openai-compatible",
      CEREMONY_MODEL: "local",
      CEREMONY_MODEL_URL: "http://127.0.0.1:8000/v1/chat/completions",
      ANTHROPIC_API_KEY: "ignored",
    }),
    {
      model: "local",
      endpoint: "http://127.0.0.1:8000/v1/chat/completions",
    },
  );
  assert.deepEqual(
    modelConfigurationFromEnvironment({
      CEREMONY_MODEL: "gateway/model",
      CEREMONY_MODEL_GATEWAY: "true",
    }),
    { model: "gateway/model", gateway: true },
  );
  assert.throws(
    () => modelConfigurationFromEnvironment({ CEREMONY_MODEL_PROVIDER: "x" }),
    /Invalid model configuration/,
  );
  // A provider alone still enables nothing silently: it demands a model.
  assert.throws(() =>
    configuredModel(
      modelConfigurationFromEnvironment({
        CEREMONY_MODEL_PROVIDER: "anthropic",
      }),
    ),
  );
});
