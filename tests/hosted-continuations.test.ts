import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import { PostgresCeremonyStore } from "../src/server/persistence/index.js";
import { postgresFixture } from "./fixtures/postgres.js";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";
import { hostedHttp } from "../src/server/hosted/http.js";
import {
  dispatchHostedContinuations,
  hostedContinuation,
  validContinuationWorker,
} from "../src/server/hosted/continuations.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { dispatchAgentWakes } from "../src/server/agent/workflow-api.js";

test("AC-35: mounted workload dispatcher resumes trusted host task after lost acknowledgment with one logical effect", async () => {
  const database = await postgresFixture();
  const store = new PostgresCeremonyStore(database.config, {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  await store.migrate();
  const seen = new Set<string>();
  let requests = 0;
  const consumer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests++;
    assert.equal(req.headers["idempotency-key"], input.deliveryId);
    seen.add(input.deliveryId);
    if (requests === 1) {
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ deliveryId: input.deliveryId, completed: true }));
  });
  consumer.listen(0, "127.0.0.1");
  await once(consumer, "listening");
  const address = consumer.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  try {
    const actor: ActorContext = {
      tenantId: "tenant",
      subjectId: "subject",
      sessionId: "session",
      actorKind: "human",
      capabilities: ["executor"],
    };
    const registry = new OperationRegistry();
    registry.register({
      contract: {
        id: "verified-fixture",
        version: "1.0.0",
        provider: "github",
        profile: "github-app",
        inputs: {},
        outputs: {},
        effects: ["verified"],
        verifier: "fixture",
        humanFallback: "fixture",
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({}).strict(),
      classifications: {},
      fixtures: ["local-verifier"],
      handler: async () => ({ state: "complete", outputs: {} }),
      verify: async () => true,
    });
    const options = {
      store,
      identity: { authenticate: async () => actor },
      registry,
      origin: "https://ceremony.example",
      context: async () => ({
        provider: "github",
        profile: "github-app",
        target: "account",
        origin: "https://ceremony.example",
        environment: "test",
        configurationVersion: "v1",
      }),
      authorize: async () => true,
      continuation: hostedContinuation(
        {
          CEREMONY_CONTINUATION_URL: "https://host-task.example/continue",
          CEREMONY_CONTINUATION_TOKEN: "fixture-".repeat(8),
        },
        async (url, init) => {
          assert.equal(String(url), "https://host-task.example/continue");
          return fetch(`http://127.0.0.1:${address.port}`, init);
        },
      )!,
    };
    let runtime = createTeachingRuntime(options);
    const run = await runtime.executeRecipe(
      actor,
      {
        schemaVersion: 1,
        id: "recipe",
        title: "Fixture",
        description: "Deterministic verified operation",
        inputs: {},
        invocations: [
          {
            id: "node",
            use: {
              kind: "operation",
              id: "verified-fixture",
              version: "1.0.0",
            },
            dependsOn: [],
            bindings: {},
          },
        ],
        outputs: {},
      },
      {},
      "github",
    );
    const stored = await store.transaction((tx) =>
      tx.get<{ continuation: string }>({
        tenant: "tenant",
        kind: "run",
        id: run.id,
      }),
    );
    assert.equal(stored?.value.continuation, "host-task");
    await runtime.commands.advance(
      actor,
      run.id,
      "node",
      run.revision,
      "command",
    );
    const secret = randomBytes(32).toString("hex");
    const dispatch = () =>
      hostedHttp(
        new Request("https://ceremony.example/api/internal/continuations", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        runtime,
        async () => {},
        {
          secret,
          dispatch: () => dispatchHostedContinuations(runtime, "tenant"),
        },
      );
    assert.equal(
      (
        await hostedHttp(
          new Request("https://ceremony.example/api/internal/continuations"),
          runtime,
          async () => {},
          {
            secret,
            dispatch: () => dispatchHostedContinuations(runtime, "tenant"),
          },
        )
      ).status,
      403,
    );
    assert.equal(requests, 0);
    assert.equal((await dispatch()).status, 503);
    runtime = createTeachingRuntime(options); // Fresh runtime; authoritative delivery remains in PostgreSQL.
    assert.equal((await dispatch()).status, 200);
    assert.equal((await dispatch()).status, 200);
    assert.equal(requests, 2);
    assert.equal(seen.size, 1);
    const outbox = await store.transaction((tx) =>
      tx.get<{ status: string }>({
        tenant: "tenant",
        kind: "outbox",
        id: `continuation:${run.id}`,
      }),
    );
    assert.equal(outbox?.value.status, "delivered");
    await runtime.delegate(actor, run.id);
    const wakeKey = {
      tenant: actor.tenantId,
      kind: "outbox" as const,
      id: `agent-wake:${run.id}:test`,
    };
    await store.transaction((tx) =>
      tx.put(
        wakeKey,
        {
          task: "agent-wake",
          runId: run.id,
          subjectId: actor.subjectId,
          status: "pending",
        },
        null,
      ),
    );
    let wakes = 0;
    await dispatchAgentWakes(runtime, actor.tenantId, async () => {
      wakes++;
      return false;
    });
    assert.equal(
      (await store.transaction((tx) => tx.get<{ status: string }>(wakeKey)))
        ?.value.status,
      "pending",
    );
    await dispatchAgentWakes(
      runtime,
      actor.tenantId,
      async (_commands, derived, id) => {
        wakes++;
        assert.equal(derived.actorKind, "agent");
        assert.equal(id, run.id);
        return true;
      },
    );
    await dispatchAgentWakes(runtime, actor.tenantId, async () => {
      throw new Error("Duplicate wake");
    });
    assert.equal(wakes, 2);
    const denied = { ...wakeKey, id: `agent-wake:${run.id}:foreign` };
    await store.transaction((tx) =>
      tx.put(
        denied,
        {
          task: "agent-wake",
          runId: run.id,
          subjectId: "foreign",
          status: "pending",
        },
        null,
      ),
    );
    await dispatchAgentWakes(runtime, actor.tenantId, async () => {
      throw new Error("Unauthorized wake");
    });
    assert.equal(
      (await store.transaction((tx) => tx.get<{ status: string }>(denied)))
        ?.value.status,
      "blocked",
    );
  } finally {
    await store.close();
    consumer.closeAllConnections();
    await new Promise<void>((resolve) => consumer.close(() => resolve()));
    await database.close();
  }
});

test("OPS workload configuration is explicit and cannot be forged with user headers", () => {
  assert.equal(hostedContinuation({}), undefined);
  for (const env of [
    {
      CEREMONY_CONTINUATION_URL: "http://remote.example",
      CEREMONY_CONTINUATION_TOKEN: "x".repeat(32),
    },
    {
      CEREMONY_CONTINUATION_URL: "https://remote.example",
      CEREMONY_CONTINUATION_TOKEN: "short",
    },
    {
      CEREMONY_CONTINUATION_URL: "https://user:password@remote.example",
      CEREMONY_CONTINUATION_TOKEN: "x".repeat(32),
    },
  ])
    assert.throws(() => hostedContinuation(env));
  const secret = "x".repeat(32);
  assert.equal(
    validContinuationWorker(
      new Request("https://app.example", { headers: { "x-owner": "admin" } }),
      secret,
    ),
    false,
  );
  assert.equal(
    validContinuationWorker(
      new Request("https://app.example", {
        headers: { authorization: `Bearer ${"y".repeat(32)}` },
      }),
      secret,
    ),
    false,
  );
  assert.equal(
    validContinuationWorker(
      new Request("https://app.example", {
        headers: { authorization: `Bearer ${secret}` },
      }),
      secret,
    ),
    true,
  );
  assert.equal(
    validContinuationWorker(new Request("https://app.example"), undefined),
    false,
  );
});
