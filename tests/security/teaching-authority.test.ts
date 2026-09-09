import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import { createTeachingRuntime } from "../../src/server/teaching-runtime.js";
import { OperationRegistry } from "../../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "alice",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author"],
};
const context = {
  provider: "github",
  profile: "github-app",
  target: "alice",
  origin: "https://app.example",
  environment: "test",
  configurationVersion: "1",
};
async function fixture(t: TestContext) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  let effects = 0,
    verifications = 0,
    valid = true;
  let pause: Promise<void> | undefined;
  const registry = new OperationRegistry(
    new Map([["proof", { classification: "public", schema: z.boolean() }]]),
  );
  registry.register({
    contract: {
      id: "github.verify-access",
      version: "1.0.0",
      provider: "github",
      profile: "github-app",
      inputs: {},
      outputs: { proof: { contract: "proof", required: true } },
      effects: ["read"],
      verifier: "github.provider",
      humanFallback: "github.own-browser",
    },
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ proof: z.boolean() }),
    classifications: {},
    fixtures: ["local-provider"],
    handler: async () => {
      effects++;
      await pause;
      return { state: "complete", outputs: { proof: true } };
    },
    verify: async () => {
      verifications++;
      return valid;
    },
  });
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => actor },
    origin: context.origin,
    context: async () => context,
    authorize: async () => true,
  });
  const run = await runtime.commands.createRun(
    actor,
    context,
    [
      {
        id: "access",
        operationId: "github.verify-access",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
    ],
    {},
  );
  return {
    runtime,
    store,
    run,
    effects: () => effects,
    verifications: () => verifications,
    revokeEvidence: () => {
      valid = false;
    },
    pause: () => {
      let release!: () => void;
      pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

test("AC-18 AC-33: Stop assistant rejects an in-flight agent commit and later work without cancelling human work", async (t) => {
  const f = await fixture(t);
  await f.runtime.delegate(actor, f.run.id);
  const delegated = await f.runtime.agentActor(f.run.id);
  const release = f.pause();
  const pending = f.runtime.commands.advance(
    delegated,
    f.run.id,
    "access",
    1,
    "agent-delayed",
  );
  while (f.effects() === 0)
    await new Promise<void>((resolve) => setImmediate(resolve));
  await f.runtime.agent.stop(actor, f.run.id);
  release();
  await assert.rejects(pending);
  assert.equal(
    (await f.runtime.commands.snapshot(actor, f.run.id)).nodes[0]!.verified,
    false,
  );
  await assert.rejects(
    f.runtime.commands.advance(
      delegated,
      f.run.id,
      "access",
      1,
      "agent-after-stop",
    ),
  );
  assert.equal(f.effects(), 1);
  assert.equal(
    (await f.runtime.commands.snapshot(actor, f.run.id)).status,
    "active",
  );
});

test("AC-18: expired, revoked, wrong-session and undelegated agents cannot issue effects", async (t) => {
  const f = await fixture(t);
  const agent = { ...actor, actorKind: "agent" as const };
  await assert.rejects(
    f.runtime.commands.advance(agent, f.run.id, "access", 1, "no-delegation"),
  );
  await f.runtime.delegate(actor, f.run.id);
  await assert.rejects(
    f.runtime.commands.advance(
      { ...agent, sessionId: "other" },
      f.run.id,
      "access",
      1,
      "wrong-session",
    ),
  );
  for (const mode of ["revoked", "expired"] as const) {
    await f.store.transaction(async (tx) => {
      const key = {
        tenant: "workload",
        kind: "session" as const,
        id: f.run.id,
      };
      const saved = await tx.get<{
        actor: ActorContext;
        runId: string;
        expiresAt: number;
        revoked: boolean;
      }>(key);
      await tx.put(
        key,
        {
          ...saved!.value,
          revoked: mode === "revoked",
          expiresAt: mode === "expired" ? 0 : (await tx.now()) + 60000,
        },
        saved!.revision,
      );
    });
    await assert.rejects(
      f.runtime.commands.advance(agent, f.run.id, "access", 1, mode),
    );
  }
  assert.equal(f.effects(), 0);
});

test("AC-03 AC-36: connection reuse requires fresh provider verification and invalidates revoked evidence", async (t) => {
  const f = await fixture(t);
  await f.runtime.commands.advance(actor, f.run.id, "access", 1, "initial");
  assert.equal((await f.runtime.connect(actor, "github")).status, "complete");
  assert.equal(f.effects(), 1);
  assert.equal(f.verifications(), 2);
  f.revokeEvidence();
  const reused = await f.runtime.connect(actor, "github");
  assert.equal(reused.id, f.run.id);
  assert.equal(reused.status, "active");
  assert.equal(reused.nodes[0]!.verified, false);
  assert.equal(reused.nodes[0]!.state, "failed");
  assert.equal(f.effects(), 1);
  assert.equal(f.verifications(), 3);
});

test("AC-36: invalidated prerequisite evidence invalidates every dependent without rerunning provider effects", async (t) => {
  const f = await fixture(t);
  const run = await f.runtime.commands.createRun(
    actor,
    context,
    [
      {
        id: "setup",
        operationId: "github.verify-access",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
      {
        id: "access",
        operationId: "github.verify-access",
        operationVersion: "1.0.0",
        dependsOn: ["setup"],
        bindings: {},
      },
    ],
    {},
  );
  await f.runtime.commands.advance(actor, run.id, "setup", 1, "setup");
  await f.runtime.commands.advance(actor, run.id, "access", 2, "access");
  f.revokeEvidence();
  const result = await f.runtime.commands.revalidate(actor, run.id);
  assert.equal(result.status, "active");
  assert.deepEqual(
    result.nodes.map((node) => node.verified),
    [false, false],
  );
  assert.equal(f.effects(), 2);
  assert.equal(f.verifications(), 3);
  await assert.rejects(
    f.runtime.commands.advance(
      actor,
      run.id,
      "access",
      result.revision,
      "forged-resume",
    ),
  );
  assert.equal(f.effects(), 2);
});

test("AC-18: delegation host authorization may access storage without nesting a transaction", async (t) => {
  const f = await fixture(t);
  let policyReads = 0;
  const runtime = createTeachingRuntime({
    store: f.store,
    registry: f.runtime.registry,
    identity: { authenticate: async () => actor },
    origin: context.origin,
    context: async () => context,
    authorize: async () => {
      await f.store.transaction(async (tx) => {
        await tx.now();
        policyReads++;
      });
      return true;
    },
  });
  await runtime.delegate(actor, f.run.id);
  assert.equal(policyReads, 1);
  await runtime.commands.advance(
    await runtime.agentActor(f.run.id),
    f.run.id,
    "access",
    1,
    "nested-policy",
  );
  assert.equal(
    (await runtime.commands.snapshot(actor, f.run.id)).status,
    "complete",
  );
});

test("AC-03: compatible run reuse is not lost behind the first 1000 tenant records", async (t) => {
  const f = await fixture(t);
  await f.store.transaction(async (tx) => {
    for (let index = 0; index < 1001; index++)
      await tx.put(
        { tenant: actor.tenantId, kind: "run", id: `aaa:${index}` },
        {
          ...context,
          id: `aaa:${index}`,
          subjectId: "other",
          sessionId: "other",
          status: "active",
          nodes: [],
          inputs: {},
        },
        null,
      );
  });
  const reused = await f.runtime.connect(actor, "github");
  assert.equal(reused.id, f.run.id);
  assert.equal(f.effects(), 0);
});

test("AC-18 AC-36: cancelled runs and failed provider revalidation cannot retain trusted success", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.commands.cancel(actor, f.run.id, 99));
  await f.runtime.delegate(actor, f.run.id);
  const agent = await f.runtime.agentActor(f.run.id);
  await f.runtime.commands.cancel(agent, f.run.id, 1);
  await assert.rejects(f.runtime.commands.revalidate(actor, f.run.id));
  const other = await fixture(t);
  await other.runtime.commands.advance(
    actor,
    other.run.id,
    "access",
    1,
    "complete",
  );
  other.runtime.registry.require("github.verify-access", "1.0.0").verify =
    async () => {
      throw new Error("synthetic-provider-error");
    };
  const current = await other.runtime.commands.revalidate(actor, other.run.id);
  assert.equal(current.status, "active");
  assert.equal(current.nodes[0]!.verified, false);
  assert.equal(
    JSON.stringify(current).includes("synthetic-provider-error"),
    false,
  );
});
