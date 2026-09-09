import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  configuredModel,
  validateAgentText,
} from "../src/server/agent/model.js";
import {
  AgentCoordinator,
  type AgentCommandPort,
} from "../src/server/agent/coordinator.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { agentStatusStream } from "../src/server/agent/stream.js";
import { suggestRecipeLabels } from "../src/server/agent/authoring.js";

test("AGT AC-23 configured model routing is explicit and text ingress fails closed for known formats", () => {
  assert.equal(configuredModel({}), undefined);
  assert.throws(() => configuredModel({ model: "local" }), /endpoint/);
  for (const endpoint of [
    "https://example.com/v1",
    "https://user:pass@example.com/chat/completions",
    "http://remote.example/chat/completions",
    "https://example.com/chat/completions?key=private",
  ])
    assert.throws(() => configuredModel({ model: "local", endpoint }));
  assert.throws(() =>
    configuredModel({
      model: "local",
      endpoint: "https://example.com/chat/completions",
      gateway: true,
    }),
  );
  assert.ok(
    configuredModel({
      model: "explicit/configured",
      gateway: true,
      apiKey: "fixture",
    }),
  );
  assert.equal(validateAgentText("Connect GitHub"), "Connect GitHub");
  for (const text of [
    "sk_live_fixture",
    "ghp_fixture",
    "Bearer fixture",
    "private-canary",
    "a".repeat(2001),
  ])
    assert.throws(
      () => validateAgentText(text, ["private-canary"]),
      /private collection/,
    );
});
test("AGT AC-15 AC-17 AC-26 real AI SDK HTTP tools, unknown-tool budgets, outage, stop and safe context", async () => {
  let mode:
    | "valid"
    | "unknown"
    | "outage"
    | "malformed"
    | "flood"
    | "labels"
    | "broaden" = "valid";
  let calls = 0,
    effects = 0;
  const paths: string[] = [];
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    calls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    if (mode === "outage") {
      res.statusCode = 503;
      return res.end(
        JSON.stringify({ error: { message: "fixture unavailable" } }),
      );
    }
    if (mode === "malformed") return res.end("{}");
    if (mode === "labels")
      return res.end(
        JSON.stringify({
          id: "fixture-labels",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  title: "Connect GitHub",
                  description: "Prepare and verify GitHub access.",
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    res.end(
      JSON.stringify({
        id: "fixture-response",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: Array.from(
                { length: mode === "flood" ? 9 : 1 },
                (_, index) => ({
                  id: `call-${index}`,
                  type: "function",
                  function: {
                    name: mode === "unknown" ? "invented_verifier" : "advance",
                    arguments: JSON.stringify({
                      nodeId: "verify",
                      expectedRevision: 1,
                      ...(mode === "broaden"
                        ? {
                            permissions: "admin",
                            verifier: "accept-without-provider",
                            source: "ui",
                          }
                        : {}),
                    }),
                  },
                }),
              ),
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  let complete = false;
  const commands: AgentCommandPort = {
    snapshot: async () => ({
      id: "run",
      revision: 1,
      provider: "github",
      profile: "app",
      status: complete ? "complete" : "active",
      nodes: [
        {
          id: "verify",
          operationId: "github.verify",
          operationVersion: "1.0.0",
          state: complete ? "complete" : "pending",
          verified: complete,
        },
      ],
    }),
    advance: async (a, run, node, revision, id) => {
      assert.equal(a.actorKind, "agent");
      assert.equal(node, "verify");
      effects++;
      complete = true;
      return {
        commandId: id,
        runId: run,
        nodeId: node,
        revision: revision + 1,
        state: "complete",
        verified: true,
      };
    },
  };
  try {
    const model = configuredModel({
      endpoint: `${origin}/v1/chat/completions`,
      model: "fixture",
    })!;
    const agent = new AgentCoordinator(store, commands, model);
    assert.equal(await agent.turn(actor, "run", "first"), "complete");
    assert.equal(effects, 1);
    const before = calls;
    assert.equal(await agent.turn(actor, "run", "reused"), "complete");
    assert.equal(calls, before);
    assert.ok(paths.every((path) => path === "/v1/chat/completions"));
    assert.equal(JSON.stringify(requests).includes("session"), false);
    complete = false;
    mode = "unknown";
    assert.equal(
      await agent.turn(actor, "other-run", "unknown"),
      "awaiting-human",
    );
    assert.equal((await agent.status(actor, "other-run", "unknown")).tools, 8);
    assert.equal(effects, 1);
    mode = "outage";
    mode = "broaden";
    assert.equal(
      await agent.turn(actor, "broaden-run", "injected"),
      "awaiting-human",
    );
    assert.equal((await agent.status(actor, "broaden-run")).tools, 8);
    assert.equal(effects, 1);
    const rejecting = new AgentCoordinator(
      store,
      {
        ...commands,
        advance: async () => {
          throw new Error("private-provider-error");
        },
      },
      model,
    );
    mode = "valid";
    assert.equal(
      await rejecting.turn(actor, "denied-run", "denied"),
      "awaiting-human",
    );
    assert.equal((await rejecting.status(actor, "denied-run")).tools, 8);
    for (const state of ["verifying", "uncertain"] as const) {
      const waiting = new AgentCoordinator(
        store,
        {
          ...commands,
          advance: async (_actor, runId, nodeId, revision, commandId) => ({
            runId,
            nodeId,
            commandId,
            revision,
            state,
            verified: false,
          }),
        },
        model,
      );
      assert.equal(
        await waiting.turn(actor, `${state}-run`, "wait"),
        state === "verifying" ? "awaiting-human" : "uncertain",
      );
      assert.equal((await waiting.status(actor, `${state}-run`)).calls, 1);
    }
    mode = "outage";
    assert.equal(
      await agent.turn(actor, "outage-run", "outage"),
      "unavailable",
    );
    assert.equal((await agent.status(actor, "outage-run", "outage")).calls, 1);
    mode = "malformed";
    assert.equal(
      await agent.turn(actor, "malformed-run", "bad"),
      "unavailable",
    );
    await agent.stop(actor, "stop-run");
    const stoppedCalls = calls;
    assert.equal(await agent.turn(actor, "stop-run", "stopped"), "stopped");
    assert.equal(calls, stoppedCalls);
    mode = "flood";
    assert.equal(
      await agent.turn(actor, "flood-run", "flood"),
      "budget-exhausted",
    );
    assert.equal((await agent.status(actor, "flood-run", "flood")).tools, 9);
    assert.equal(effects, 1);
    const stream = await agentStatusStream(agent, actor, "flood-run", "flood");
    assert.equal(stream.headers.get("cache-control"), "no-store");
    const text = await stream.text();
    assert.ok(text.includes("budget-exhausted"));
    assert.equal(text.includes("subject"), false);
    mode = "labels";
    const author = { ...actor, capabilities: ["author" as const] };
    assert.equal(
      (
        await suggestRecipeLabels(
          store,
          author,
          "draft",
          [{ id: "github.verify", version: "1.0.0" }],
          model,
        )
      )?.title,
      "Connect GitHub",
    );
    mode = "malformed";
    assert.equal(
      await suggestRecipeLabels(
        store,
        author,
        "broken",
        [{ id: "github.verify", version: "1.0.0" }],
        model,
      ),
      null,
    );
    const exhaustedCalls = calls;
    assert.equal(
      await suggestRecipeLabels(
        store,
        author,
        "broken",
        [{ id: "github.verify", version: "1.0.0" }],
        model,
      ),
      null,
    );
    assert.equal(calls, exhaustedCalls);
    assert.equal(
      await suggestRecipeLabels(store, author, "no-model", [
        { id: "github.verify", version: "1.0.0" },
      ]),
      null,
    );
    await assert.rejects(
      suggestRecipeLabels(
        store,
        { ...author, subjectId: "other" },
        "broken",
        [{ id: "github.verify", version: "1.0.0" }],
        model,
      ),
      /denied/,
    );
    assert.equal(
      await new AgentCoordinator(store, commands).turn(
        actor,
        "offline-run",
        "offline",
      ),
      "unavailable",
    );
  } finally {
    await store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("AGT safe stream reconnect and cancellation do not stop the assistant", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const port: AgentCommandPort = {
    snapshot: async () => ({
      id: "run",
      revision: 1,
      provider: "github",
      profile: "app",
      status: "active",
      nodes: [],
    }),
    advance: async () => {
      throw new Error("not invoked");
    },
  };
  const coordinator = new AgentCoordinator(store, port);
  try {
    await store.transaction((tx) =>
      tx.put(
        { tenant: "tenant", kind: "budget", id: "agent:run" },
        {
          calls: 1,
          tools: 0,
          stopped: false,
          turns: { turn: { calls: 1, tools: 0, status: "running" } },
        },
        null,
      ),
    );
    const response = await agentStatusStream(coordinator, actor, "run", "turn");
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    assert.equal(
      (await coordinator.status(actor, "run", "turn")).status,
      "running",
    );
    assert.equal(await coordinator.turn(actor, "run", "turn"), "unavailable");
    await coordinator.stop(actor, "run");
    const resumed = await agentStatusStream(coordinator, actor, "run", "turn");
    assert.ok((await resumed.text()).includes("stopped"));
  } finally {
    await store.close();
  }
});
