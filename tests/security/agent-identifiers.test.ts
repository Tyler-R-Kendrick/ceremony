import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import { OperationRegistry } from "../../src/server/recipes/index.js";
import { ProtectedCommandService } from "../../src/server/commands.js";
import { AgentCoordinator } from "../../src/server/agent/coordinator.js";
import { configuredModel } from "../../src/server/agent/model.js";
import { suggestRecipeLabels } from "../../src/server/agent/authoring.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";

test("AC-23 AC-25: secret-shaped author identifiers cannot reach the actual model HTTP transport", async (t) => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    for await (const _chunk of request) {
      /* Deliberately do not retain model request content. */
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Waiting." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "author",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const registry = new OperationRegistry();
  registry.register({
    contract: {
      id: "prepare",
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
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const run = await commands.createRun(
    actor,
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
        id: "ghp_syntheticPrivateCanary",
        operationId: "prepare",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
    ],
    {},
  );
  const coordinator = new AgentCoordinator(
    store,
    commands,
    configuredModel({
      model: "fixture",
      endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
    }),
  );
  assert.equal(await coordinator.turn(actor, run.id, "turn"), "unavailable");
  await assert.rejects(
    suggestRecipeLabels(
      store,
      { ...actor, capabilities: ["author"] },
      "draft",
      [{ id: "ghp_syntheticPrivateCanary", version: "1.0.0" }],
      configuredModel({
        model: "fixture",
        endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
      }),
    ),
  );
  assert.equal(calls, 0);
});
