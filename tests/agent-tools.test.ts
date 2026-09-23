import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { configuredModel } from "../src/server/agent/model.js";
import {
  AgentCoordinator,
  type AgentCommandPort,
} from "../src/server/agent/coordinator.js";
import { agentStatusStream } from "../src/server/agent/stream.js";
import {
  PersistenceConflict,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import { AuthorizationError } from "../src/server/identity.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import {
  scriptedModel,
  stepContext,
  type ScriptedCall,
} from "./fixtures/agent-model.js";

// Synthetic values that must never reach a model request.
const secret = "ghp_agentToolsCanary0123456789";
const privateCanary = "private-canary-7f3a";
const actor: ActorContext = {
  tenantId: "tenant-canary",
  subjectId: "subject-canary",
  sessionId: "session-canary",
  actorKind: "human",
  capabilities: ["executor"],
};
type Snapshot = Awaited<ReturnType<AgentCommandPort["snapshot"]>>;
type Advance = Awaited<ReturnType<AgentCommandPort["advance"]>>;

/** One-node run whose port also returns fields no projection may forward. */
function run(advance: (call: number) => Advance["state"] | Error) {
  const state = {
    revision: 1,
    node: "pending" as Snapshot["nodes"][number]["state"],
    status: "active" as Snapshot["status"],
    verified: false,
    advances: 0,
  };
  const port: AgentCommandPort = {
    snapshot: async () =>
      ({
        id: "run",
        revision: state.revision,
        provider: "github",
        profile: "app",
        status: state.status,
        nodes: [
          {
            id: "verify",
            operationId: "github.verify",
            operationVersion: "1.0.0",
            state: state.node,
            verified: state.verified,
            outputs: { token: secret },
          },
        ],
        inputs: { token: secret },
        continuation: privateCanary,
      }) as unknown as Snapshot,
    advance: async (agent, runId, nodeId, revision, commandId) => {
      assert.equal(agent.actorKind, "agent");
      const outcome = advance(++state.advances);
      if (outcome instanceof Error) throw outcome;
      state.node = outcome;
      state.revision = revision + 1;
      if (outcome === "complete") {
        state.verified = true;
        state.status = "complete";
      }
      return {
        runId,
        nodeId,
        commandId,
        revision: state.revision,
        state: outcome,
        verified: state.verified,
      };
    },
  };
  return { state, port };
}
function store() {
  return new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
}
function assertNothingPrivate(raw: string) {
  for (const value of [
    secret,
    privateCanary,
    actor.tenantId,
    actor.subjectId,
    actor.sessionId,
  ])
    assert.equal(raw.includes(value), false, `model request carried ${value}`);
}

test("AGT tools: snapshot, fixed error codes and request_human reach the model; nothing private does", async (t) => {
  const advance = { nodeId: "verify", expectedRevision: 1 };
  const script: ScriptedCall[][] = [
    [{ name: "snapshot", input: {} }],
    [{ name: "advance", input: advance }],
    [{ name: "advance", input: advance }],
    [{ name: "advance", input: advance }],
    [{ name: "advance", input: advance }],
    [
      { name: "invented_verifier", input: { permissions: "admin" } },
      { name: "request_human", input: { nodeId: "missing" } },
    ],
    [{ name: "request_human", input: { nodeId: "verify" } }],
  ];
  const model = await scriptedModel("chat", (index) => script[index] ?? []);
  const db = store();
  t.after(async () => {
    await db.close();
    await model.close();
  });
  const { state, port } = run(
    (call) =>
      [
        new AuthorizationError("denied"),
        new AuthorizationError("invalid_request"),
        new PersistenceConflict(),
        new Error(`provider exploded with ${secret} ${privateCanary}`),
      ][call - 1]!,
  );
  const coordinator = new AgentCoordinator(
    db,
    port,
    configuredModel({
      endpoint: `${model.origin}/v1/chat/completions`,
      model: "fixture",
    }),
  );
  const expected = {
    kind: "person",
    runId: "run",
    nodeId: "verify",
    operationId: "github.verify",
    nodeState: "pending",
    reason: "agent-request",
  };
  assert.deepEqual(await coordinator.turnOutcome(actor, "run", "tools"), {
    status: "awaiting-human",
    handoff: expected,
  });
  assert.equal(state.advances, 4);
  assert.equal(model.requests.length, 7);
  // Every step advertises exactly the three tools.
  for (const request of model.requests)
    assert.deepEqual(
      (request.body.tools as { function: { name: string } }[])
        .map((entry) => entry.function.name)
        .sort(),
      ["advance", "request_human", "snapshot"],
    );
  const results = model.requests.map((request) => stepContext(request).results);
  assert.deepEqual(results.slice(0, 6), [
    [],
    [{ tool: "snapshot", output: "current" }],
    [{ tool: "advance", output: { error: "denied" } }],
    [{ tool: "advance", output: { error: "invalid" } }],
    [{ tool: "advance", output: { error: "conflict" } }],
    [{ tool: "advance", output: { error: "transient" } }],
  ]);
  assert.deepEqual(
    results[6]!.sort((a, b) => a.tool.localeCompare(b.tool)),
    [
      { tool: "request_human", output: { error: "invalid" } },
      { tool: "unknown", error: "invalid" },
    ],
  );
  // The context is rebuilt each step: one user message, only the allowlisted run.
  for (const request of model.requests) {
    assert.equal(
      request.body.messages.filter((message) => message.role !== "system")
        .length,
      1,
    );
    assert.deepEqual(Object.keys(stepContext(request).run).sort(), [
      "id",
      "nodes",
      "profile",
      "provider",
      "revision",
      "status",
    ]);
    assertNothingPrivate(request.raw);
    assert.equal(request.raw.includes("invented_verifier"), false);
    assert.equal(request.raw.includes("admin"), false);
  }
  // Durable: every requested tool counted, including the invented one.
  assert.deepEqual(await coordinator.status(actor, "run", "tools"), {
    status: "awaiting-human",
    calls: 7,
    tools: 8,
    handoff: expected,
  });
  // A recorded outcome is returned again without inference.
  assert.deepEqual(await coordinator.turnOutcome(actor, "run", "tools"), {
    status: "awaiting-human",
    handoff: expected,
  });
  assert.equal(model.requests.length, 7);
});

test("AGT a human wait ends the turn with a person-bound handoff instead of an opaque stop", async (t) => {
  const model = await scriptedModel("chat", (index) =>
    index === 0
      ? [
          // The second call in the same step is never executed.
          { name: "advance", input: { nodeId: "verify", expectedRevision: 1 } },
          { name: "request_human", input: { nodeId: "verify" } },
        ]
      : [],
  );
  const db = store();
  t.after(async () => {
    await db.close();
    await model.close();
  });
  const { state, port } = run(() => "awaiting-human");
  const llm = configuredModel({
    endpoint: `${model.origin}/v1/chat/completions`,
    model: "fixture",
  });
  const coordinator = new AgentCoordinator(db, port, llm);
  const handoff = {
    kind: "person",
    runId: "run",
    nodeId: "verify",
    operationId: "github.verify",
    nodeState: "awaiting-human",
    reason: "human-step",
    path: "/api/v1/teaching/github/run/human",
  };
  assert.deepEqual(await coordinator.turnOutcome(actor, "run", "first"), {
    status: "awaiting-human",
    handoff,
  });
  assert.equal(state.advances, 1);
  assert.equal(model.requests.length, 1);
  // The workflow carrier still records only the enum.
  assert.equal(
    await coordinator.turn(actor, "run", "second"),
    "awaiting-human",
  );
  assert.equal(model.requests.length, 1);
  assert.deepEqual(await coordinator.status(actor, "run"), {
    status: "awaiting-human",
    calls: 1,
    tools: 2,
    handoff,
  });
  const stream = await (
    await agentStatusStream(coordinator, actor, "run", "first")
  ).text();
  assert.ok(stream.includes('"path":"/api/v1/teaching/github/run/human"'));
  assertNothingPrivate(stream);
  assert.equal(stream.includes("http"), false);

  const mounted = new AgentCoordinator(db, port, llm, {
    humanRoutePrefix: "/host/auth",
  });
  assert.equal(
    (await mounted.turnOutcome(actor, "run", "mounted")).handoff?.path,
    "/host/auth/github/run/human",
  );
  for (const humanRoutePrefix of [
    "https://elsewhere.example/api",
    "/api?code=1",
    "/api/",
    "//elsewhere.example",
  ])
    assert.throws(
      () => new AgentCoordinator(db, port, llm, { humanRoutePrefix }),
      /prefix/,
    );

  // Once the person finishes, the handoff is gone.
  state.node = "complete";
  state.verified = true;
  state.status = "complete";
  assert.deepEqual(await coordinator.turnOutcome(actor, "run", "after"), {
    status: "complete",
  });
  assert.equal("handoff" in (await coordinator.status(actor, "run")), false);
});

test("AGT new tools share the durable budget and cannot run past it", async (t) => {
  const model = await scriptedModel("chat", () =>
    Array.from({ length: 9 }, () => ({ name: "snapshot", input: {} })),
  );
  const db = store();
  t.after(async () => {
    await db.close();
    await model.close();
  });
  const { port } = run(() => new Error("not reached"));
  let reads = 0;
  const counting: AgentCommandPort = {
    ...port,
    snapshot: async (...args) => {
      reads++;
      return port.snapshot(...args);
    },
  };
  const coordinator = new AgentCoordinator(
    db,
    counting,
    configuredModel({
      endpoint: `${model.origin}/v1/chat/completions`,
      model: "fixture",
    }),
  );
  assert.deepEqual(await coordinator.turnOutcome(actor, "run", "flood"), {
    status: "budget-exhausted",
  });
  const status = await coordinator.status(actor, "run", "flood");
  assert.equal(status.calls, 1);
  assert.equal(status.tools, 9);
  // Initial read, existing-turn status, one step context, the failure status
  // and this status call: none of the nine snapshot tools executed.
  assert.equal(reads, 5);
  assert.equal(model.requests.length, 1);

  // Stopping afterwards is durable and costs no further inference.
  await coordinator.stop(actor, "run");
  assert.equal(await coordinator.turn(actor, "run", "later"), "stopped");
  assert.equal(model.requests.length, 1);
});
