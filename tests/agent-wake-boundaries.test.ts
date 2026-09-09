import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  dispatchAgentWakes,
  startAgentWorkflow,
  wakeAgent,
} from "../src/server/agent/workflow-api.js";
import {
  SQLiteCeremonyStore,
  type AsyncCeremonyStore,
} from "../src/server/persistence/index.js";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";
import { AuthorizationError } from "../src/server/identity.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

test("AC-19 AC-28 AC-34: wake dispatch pages safely, respects competing claims and retains transient failures", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject",
    sessionId: "workload",
    actorKind: "agent",
    capabilities: ["executor"],
  };
  const runtime = createTeachingRuntime({
    store,
    registry: new OperationRegistry(),
    identity: { authenticate: async () => actor },
    origin: "https://ceremony.example",
    authorize: async () => true,
    context: async () => ({
      provider: "github",
      profile: "github-app",
      target: "account",
      origin: "https://ceremony.example",
      environment: "test",
      configurationVersion: "v1",
    }),
  });
  try {
    await store.transaction(async (tx) => {
      for (let i = 0; i < 100; i++)
        await tx.put(
          {
            tenant: "tenant",
            kind: "outbox",
            id: `a:${String(i).padStart(3, "0")}`,
          },
          { task: "unrelated", status: "pending" },
          null,
        );
      for (const id of ["busy", "transient", "foreign"])
        await tx.put(
          { tenant: "tenant", kind: "outbox", id: `z:${id}` },
          {
            task: "agent-wake",
            runId: id,
            subjectId: "subject",
            status: "pending",
          },
          null,
        );
      await tx.claim(
        { tenant: "tenant", kind: "outbox", id: "z:busy" },
        "independent-worker",
        30000,
      );
    });
    let resumes = 0;
    const port = {
      ...runtime,
      agentActor: async (runId: string) => ({
        ...actor,
        actorKind: "agent" as const,
        tenantId: runId === "foreign" ? "other" : actor.tenantId,
      }),
    };
    await dispatchAgentWakes(port, "tenant", async () => {
      resumes++;
      throw new Error("transport interrupted");
    });
    assert.equal(resumes, 1);
    const read = () =>
      store.transaction((tx) =>
        tx.list<{ status: string }>("tenant", "outbox", 1000),
      );
    assert.equal(
      (await read()).find((r) => r.id === "z:transient")?.value.status,
      "pending",
    );
    assert.equal(
      (await read()).find((r) => r.id === "z:foreign")?.value.status,
      "blocked",
    );
    await store.transaction((tx) =>
      tx.cancel({ tenant: "tenant", kind: "outbox", id: "z:busy" }),
    );
    await dispatchAgentWakes(
      {
        ...runtime,
        agentActor: async () => {
          throw new AuthorizationError("denied");
        },
      },
      "tenant",
    );
    assert.ok(
      (await read())
        .filter((r) => r.id.startsWith("z:"))
        .every((r) => r.value.status === "blocked"),
    );
    await assert.rejects(
      startAgentWorkflow(runtime.commands, actor, "missing", "session"),
      /denied/,
    );
    await assert.rejects(
      wakeAgent(runtime.commands, actor, "missing"),
      /denied/,
    );
    const disappearing = {
      tenant: "tenant",
      kind: "outbox" as const,
      id: "z:vanished",
    };
    await store.transaction((tx) =>
      tx.put(
        disappearing,
        {
          task: "agent-wake",
          runId: "vanished",
          subjectId: "subject",
          status: "pending",
        },
        null,
      ),
    );
    let transactions = 0;
    const racingStore: AsyncCeremonyStore = {
      close: () => store.close(),
      transaction: async (work) => {
        const result = await store.transaction(work);
        if (++transactions === 2)
          await store.transaction((tx) => tx.delete(disappearing, 1));
        return result;
      },
    };
    await dispatchAgentWakes(
      { ...port, store: racingStore },
      "tenant",
      async () => {
        throw new Error("A deleted wake must not dispatch");
      },
    );
    assert.equal(
      await store.transaction((tx) => tx.get(disappearing)),
      undefined,
    );
    await store.transaction((tx) =>
      tx.put(
        disappearing,
        {
          task: "agent-wake",
          runId: "vanished",
          subjectId: "subject",
          status: "pending",
        },
        null,
      ),
    );
    transactions = 0;
    const failingStore: AsyncCeremonyStore = {
      close: () => store.close(),
      transaction: async (work) => {
        if (++transactions === 3)
          throw new Error("synthetic storage unavailable");
        return store.transaction(work);
      },
    };
    await assert.rejects(
      dispatchAgentWakes({ ...port, store: failingStore }, "tenant"),
      /synthetic storage unavailable/,
    );
  } finally {
    await store.close();
  }
});
