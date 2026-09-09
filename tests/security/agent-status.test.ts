import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  AgentCoordinator,
  type AgentCommandPort,
} from "../../src/server/agent/coordinator.js";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import { configuredModel } from "../../src/server/agent/model.js";

test("AC-14 AC-26 AC-34: human waits persist zero-call status and reconnect never advances", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  let state: "pending" | "awaiting-human" | "verifying" | "uncertain" =
    "pending";
  let status: "active" | "complete" | "cancelled" = "active";
  let effects = 0;
  const commands: AgentCommandPort = {
    snapshot: async () => ({
      id: "run",
      revision: 1,
      provider: "github",
      profile: "app",
      status,
      nodes: [
        {
          id: "verify",
          operationId: "verify",
          operationVersion: "1.0.0",
          state,
          verified: false,
        },
      ],
    }),
    advance: async () => {
      effects++;
      throw new Error("Unexpected effect");
    },
  };
  const agent = new AgentCoordinator(store, commands);
  assert.deepEqual(await agent.status(actor, "run"), {
    status: "idle",
    calls: 0,
    tools: 0,
  });
  assert.equal(await agent.turn(actor, "run", "offline"), "unavailable");
  for (const wait of ["awaiting-human", "verifying", "uncertain"] as const) {
    state = wait;
    const turn = `wait-${wait}`;
    assert.equal(await agent.turn(actor, "run", turn), "awaiting-human");
    const restored = new AgentCoordinator(store, commands);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(await restored.status(actor, "run"), {
        status: "awaiting-human",
        calls: 0,
        tools: 0,
      });
    assert.equal(await restored.turn(actor, "run", turn), "awaiting-human");
  }
  assert.equal(effects, 0);
  state = "pending";
  const enabled = new AgentCoordinator(
    store,
    commands,
    configuredModel({
      model: "fixture",
      endpoint: "http://127.0.0.1:1/v1/chat/completions",
    }),
  );
  const budgetKey = {
    tenant: actor.tenantId,
    kind: "budget" as const,
    id: "agent:run",
  };
  for (const priorStatus of ["running", "unavailable"] as const) {
    await store.transaction(async (tx) => {
      const prior = await tx.get(budgetKey);
      await tx.put(
        budgetKey,
        {
          calls: 1,
          tools: 1,
          stopped: false,
          turns: { resumed: { calls: 1, tools: 1, status: priorStatus } },
        },
        prior!.revision,
      );
    });
    assert.equal(
      await enabled.turn(actor, "run", "resumed"),
      priorStatus === "running" ? "uncertain" : "unavailable",
    );
    assert.deepEqual(await enabled.status(actor, "run"), {
      status: priorStatus,
      calls: 1,
      tools: 1,
    });
  }
  await agent.stop(actor, "run");
  assert.equal(await agent.turn(actor, "run", "after-stop"), "stopped");
  assert.equal((await agent.status(actor, "run")).status, "stopped");
  status = "complete";
  assert.equal(await agent.turn(actor, "run", "complete"), "complete");
  status = "cancelled";
  assert.equal(await agent.turn(actor, "run", "cancelled"), "stopped");
  await assert.rejects(agent.turn(actor, "run", "bad/id"));
  await assert.rejects(
    agent.turn({ ...actor, capabilities: [] }, "run", "denied"),
  );
});
