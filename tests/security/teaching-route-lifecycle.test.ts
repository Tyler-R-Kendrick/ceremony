import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import { OperationRegistry } from "../../src/server/recipes/index.js";
import { createTeachingRuntime } from "../../src/server/teaching-runtime.js";
import { teachingHttp } from "../../src/server/teaching-http.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../../src/core/recipe-contracts.js";

test("AC-10 AC-14 AC-19: mounted authoring lifecycle and reconnect reads preserve authority and effects", async (t) => {
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
  let current: ActorContext | null = owner;
  let effects = 0;
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
    handler: async () => {
      effects++;
      return { state: "awaiting-human", outputs: {} };
    },
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
  });
  const call = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    teachingHttp(
      new Request(`${context.origin}/api/v1/teaching${path}`, {
        method,
        headers: { origin: context.origin, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      runtime,
    );
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
  assert.equal((await call("/capabilities")).status, 200);
  assert.equal((await call("/tools/snapshot", { runId: run.id })).status, 200);
  assert.equal((await call("/tools/unknown", {})).status, 404);
  assert.equal((await call("/tools/snapshot")).status, 405);
  assert.equal((await call("/unknown")).status, 404);
  assert.equal((await call("/unknown", undefined, "DELETE")).status, 405);
  assert.equal(
    (await call("/runs", { connectorId: "github", target: "other" })).status,
    403,
  );
  assert.deepEqual(await (await call(`/runs/${run.id}/demonstration`)).json(), {
    demonstration: null,
  });
  const demonstration = await (
    await call("/demonstrations", { runId: run.id, scope: ["verify"] })
  ).json();
  assert.equal(
    (await call(`/demonstrations/${demonstration.id}?after=0&limit=1`)).status,
    200,
  );
  assert.equal((await call(`/runs/${run.id}/demonstration`)).status, 200);
  assert.equal(
    (
      await call(`/demonstrations/${demonstration.id}`, {
        revision: demonstration.revision,
        consent: "paused",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/demonstrations/${demonstration.id}`, {
        revision: demonstration.revision,
        consent: "stopped",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/runs/${run.id}/advance`, {
        nodeId: "verify",
        revision: run.revision,
        commandId: "human-advance",
      })
    ).status,
    200,
  );
  assert.equal(effects, 1);
  const waiting = await runtime.agent.turn(owner, run.id, "human-wait");
  assert.equal(waiting, "awaiting-human");
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await (await call(`/agent/${run.id}/status`)).json(), {
      status: "awaiting-human",
      calls: 0,
      tools: 0,
    });
    assert.equal((await call(`/runs/${run.id}`)).status, 200);
  }
  assert.match(
    await (await call(`/agent/${run.id}/stream`)).text(),
    /awaiting-human/,
  );
  assert.deepEqual(await (await call(`/agent/${run.id}/start`, {})).json(), {
    status: "unavailable",
  });
  const enabled = createTeachingRuntime({
    store,
    registry,
    identity: runtime.identity,
    origin: context.origin,
    context: async () => context,
    authorize: async () => true,
    modelConfiguration: {
      model: "fixture",
      endpoint: "http://127.0.0.1:1/v1/chat/completions",
    },
  });
  const start = (schedule?: (runId: string, turnId: string) => Promise<void>) =>
    teachingHttp(
      new Request(`${context.origin}/api/v1/teaching/agent/${run.id}/start`, {
        method: "POST",
        headers: { origin: context.origin, "content-type": "application/json" },
        body: "{}",
      }),
      enabled,
      schedule,
    );
  // A configured assistant at a known human wait does not try the unreachable model.
  assert.equal((await (await start()).json()).status, "awaiting-human");
  let scheduled = 0;
  const delegated = await (
    await start(async (runId, turnId) => {
      assert.equal(runId, run.id);
      assert.ok(turnId);
      scheduled++;
    })
  ).json();
  assert.equal(delegated.status, "running");
  assert.equal(scheduled, 1);
  assert.equal(effects, 1);
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
  const draft = await (
    await call("/drafts/import", { definition: JSON.stringify(definition) })
  ).json();
  assert.equal((await call(`/drafts/${draft.id}`)).status, 200);
  assert.equal((await call("/composition/preview", definition)).status, 200);
  assert.equal(
    (
      await call(`/drafts/${draft.id}/suggest`, {
        revision: draft.revision + 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(`/drafts/${draft.id}/suggest`, { revision: draft.revision }))
      .status,
    200,
  );
  const edited = await (
    await call(`/drafts/${draft.id}/edit`, {
      revision: draft.revision,
      definition: { ...definition, title: "Reviewed verification" },
    })
  ).json();
  assert.equal(
    (
      await call(`/drafts/${draft.id}/review`, {
        revision: edited.revision,
        digest: edited.digest,
      })
    ).status,
    200,
  );
  const published = await (
    await call(`/drafts/${draft.id}/publish`, {
      revision: edited.revision,
      digest: edited.digest,
    })
  ).json();
  assert.equal(
    (
      await call("/recipes/execute", {
        id: definition.id,
        version: published.version,
        digest: published.digest,
        inputs: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/recipes/compose", {
        references: [
          {
            id: definition.id,
            version: published.version,
            digest: published.digest,
          },
          {
            id: definition.id,
            version: published.version,
            digest: published.digest,
          },
        ],
      })
    ).status,
    200,
  );
  current = { ...owner, subjectId: "other" };
  assert.equal((await call(`/agent/${run.id}/status`)).status, 403);
  current = null;
  assert.equal((await call(`/runs/${run.id}`)).status, 401);
  assert.deepEqual(await (await call("/capabilities")).json(), {
    available: true,
    authenticated: false,
    modelAvailable: false,
  });
});
