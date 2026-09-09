import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../../src/core/recipe-contracts.js";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import { OperationRegistry } from "../../src/server/recipes/index.js";
import { createTeachingRuntime } from "../../src/server/teaching-runtime.js";
import { teachingHttp } from "../../src/server/teaching-http.js";
import { boundedJson } from "../../src/server/authorization.js";
import { appendSemanticTransition } from "../../src/server/demonstrations.js";

test("AC-19 AC-11: mounted recipe routes enforce capabilities, definition-only export and current retirement", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const owner: ActorContext = {
    tenantId: "tenant",
    subjectId: "author",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["author", "reviewer", "publisher", "executor", "admin"],
  };
  let current = owner;
  const registry = new OperationRegistry();
  registry.register({
    contract: {
      id: "verify",
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
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => current },
    origin: "https://app.example",
    context: async () => ({
      provider: "github",
      profile: "app",
      target: "author",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "1",
    }),
    authorize: async () => true,
  });
  const definition: RecipeDefinition = {
    schemaVersion: 1,
    id: "verified-step",
    title: "Verify",
    description: "",
    inputs: {},
    invocations: [
      {
        id: "verify",
        use: { kind: "operation", id: "verify", version: "1.0.0" },
        dependsOn: [],
        bindings: {},
      },
    ],
    outputs: {},
  };
  const draft = await runtime.recipes.createDraft(owner, definition);
  await runtime.recipes.review(owner, draft.id, draft.revision, draft.digest);
  const published = await runtime.recipes.publish(
    owner,
    draft.id,
    draft.revision,
    draft.digest,
  );
  const call = (path: string, body?: unknown) =>
    teachingHttp(
      new Request(
        `https://app.example/api/v1/teaching${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                origin: "https://app.example",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
      ),
      runtime,
    );
  const recorded = await runtime.commands.createRun(
    owner,
    {
      provider: "github",
      profile: "app",
      target: "author",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "1",
    },
    [
      {
        id: "verify",
        operationId: "verify",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
    ],
    {},
  );
  const demo = await runtime.demonstrations.start(owner, recorded.id);
  await store.transaction(async (tx) => {
    for (let index = 1; index <= 101; index++)
      await appendSemanticTransition(
        tx,
        owner,
        recorded.id,
        {
          nodeId: "verify",
          operationId: "verify",
          operationVersion: "1.0.0",
          actorKind: "human",
          kind: "verification",
          beforeState: "pending",
          afterState: "complete",
          publicBindings: {},
          verification: "accepted",
        },
        {},
      );
  });
  assert.equal(
    (
      await call("/drafts/compile", {
        demonstrationId: demo.id,
        first: 101,
        last: 101,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/drafts/compile", {
        demonstrationId: demo.id,
        first: 1,
        last: 101,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/drafts/compile", {
        demonstrationId: demo.id,
        first: 0,
        last: 101,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/drafts/compile", {
        demonstrationId: demo.id,
        first: 1,
        last: 1001,
      })
    ).status,
    400,
  );
  current = { ...owner, capabilities: [] };
  assert.equal((await call("/recipes")).status, 403);
  current = { ...owner, subjectId: "executor", capabilities: ["executor"] };
  const exported = await call(
    `/recipes/verified-step/export?version=${published.version}&digest=${published.digest}`,
  );
  assert.equal(exported.status, 200);
  assert.deepEqual(await exported.json(), definition);
  assert.notEqual(
    (
      await call("/recipes/verified-step/retire", {
        version: published.version,
      })
    ).status,
    200,
  );
  assert.notEqual(
    (await call(`/drafts/${draft.id}/suggest`, { revision: draft.revision }))
      .status,
    200,
  );
  current = { ...owner, tenantId: "foreign" };
  assert.notEqual(
    (
      await call(
        `/recipes/verified-step/export?version=${published.version}&digest=${published.digest}`,
      )
    ).status,
    200,
  );
  current = owner;
  assert.equal(
    (
      await call("/recipes/verified-step/retire", {
        version: published.version,
      })
    ).status,
    200,
  );
  assert.notEqual(
    (
      await call(
        `/recipes/verified-step/export?version=${published.version}&digest=${published.digest}`,
      )
    ).status,
    200,
  );
  assert.notEqual(
    (
      await call("/drafts/import", {
        definition: JSON.stringify({
          ...definition,
          published: true,
          connectionRef: "foreign",
        }),
      })
    ).status,
    200,
  );
});

test("AC-19 AC-24 AC-33: recovery body stays private, stream ownership is checked, and cancellation precedes provider fencing", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const owner: ActorContext = {
    tenantId: "tenant",
    subjectId: "author",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  let current = owner,
    privateReads = 0,
    cancelled = false;
  const registry = new OperationRegistry();
  registry.register({
    contract: {
      id: "verify",
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
    handler: async () => ({ state: "awaiting-human", outputs: {} }),
    verify: async () => false,
  });
  const context = {
    provider: "github",
    profile: "app",
    target: "author",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "1",
  };
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => current },
    origin: context.origin,
    context: async () => context,
    authorize: async () => true,
    human: async (_actor, _run, request) => {
      assert.equal(request.bodyUsed, false);
      await boundedJson(request);
      privateReads++;
      return Response.json({ handled: true });
    },
    cancel: async (actor, runId) => {
      assert.equal(
        (await runtime.commands.snapshot(actor, runId)).status,
        "cancelled",
      );
      cancelled = true;
    },
  });
  const run = await runtime.commands.createRun(
    owner,
    context,
    [
      {
        id: "verify",
        operationId: "verify",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
    ],
    {},
  );
  const call = (path: string, body?: unknown) =>
    teachingHttp(
      new Request(
        `${context.origin}/api/v1/teaching${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                origin: context.origin,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
      ),
      runtime,
    );
  current = { ...owner, subjectId: "foreign" };
  assert.equal((await call(`/agent/${run.id}/stream?turnId=turn`)).status, 403);
  assert.equal(
    (
      await call(`/github/${run.id}/recovery`, {
        credential: "synthetic-private-input",
      })
    ).status,
    403,
  );
  current = { ...owner, actorKind: "agent" };
  assert.equal(
    (
      await call(`/github/${run.id}/recovery`, {
        credential: "synthetic-private-input",
      })
    ).status,
    403,
  );
  assert.equal(privateReads, 0);
  current = owner;
  const response = await call(`/github/${run.id}/recovery`, {
    credential: "synthetic-private-input",
  });
  assert.deepEqual(await response.json(), { handled: true });
  assert.equal(privateReads, 1);
  const stream = await call(`/agent/${run.id}/stream?turnId=turn`);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  const text = await stream.text();
  assert.equal(text.includes("synthetic-private-input"), false);
  await store.transaction((tx) =>
    tx.put(
      { tenant: owner.tenantId, kind: "budget", id: `agent:${run.id}` },
      {
        calls: 1,
        tools: 0,
        stopped: false,
        turns: { live: { calls: 1, tools: 0, status: "running" } },
      },
      null,
    ),
  );
  const live = await call(`/agent/${run.id}/stream?turnId=live`);
  const reader = live.body!.getReader();
  assert.equal((await reader.read()).done, false);
  current = { ...owner, sessionId: "changed-session" };
  assert.equal((await reader.read()).done, true);
  current = owner;
  assert.equal(
    (await call("/tools/connect", { connectorId: "github" })).status,
    200,
  );
  const native = await runtime.commands.snapshot(owner, run.id);
  assert.equal(native.nodes[0]!.state, "awaiting-human");
  assert.equal(
    (
      await call("/tools/advance", {
        runId: run.id,
        nodeId: "verify",
        revision: native.revision,
        commandId: "raw",
        password: "synthetic-private-input",
      })
    ).status,
    400,
  );
  await call(`/agent/${run.id}/stop`, {});
  assert.equal(
    (
      await call("/tools/advance", {
        runId: run.id,
        nodeId: "verify",
        revision: native.revision,
        commandId: "after-stop",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/tools/cancel", { runId: run.id, revision: native.revision }))
      .status,
    403,
  );
  assert.equal(
    (await call("/tools/connect", { connectorId: "github" })).status,
    403,
  );
  assert.equal(
    (await call(`/runs/${run.id}/cancel`, { revision: native.revision }))
      .status,
    200,
  );
  assert.equal(cancelled, true);
});
