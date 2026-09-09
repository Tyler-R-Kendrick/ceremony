import { expect, test } from "vitest";
import { start } from "workflow/api";
import { waitForHook } from "@workflow/vitest";
import { ceremonyAgentWorkflow } from "../../src/server/agent/workflow.js";
import { createHostedRuntime } from "../../src/server/hosted/runtime.js";
import { postgresFixture } from "../fixtures/postgres.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import { dispatchAgentWakes } from "../../src/server/agent/workflow-api.js";

test("AGT Workflow compiled local carrier fails closed without configured hosted authority", async () => {
  const run = await start(ceremonyAgentWorkflow, [
    "run:fixture",
    "turn:fixture",
  ]);
  expect(await run.returnValue).toBe("unavailable");
});

test("AGT AC-34 Workflow waits on actual GitHub preparation with shared PostgreSQL and resumes stopped without inference", async () => {
  const pg = await postgresFixture();
  let origin = "",
    calls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration")
      return res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
        }),
      );
    if (req.url === "/v1/chat/completions") {
      for await (const _ of req) {
        /* consume bounded synthetic SDK request */
      }
      calls++;
      return res.end(
        JSON.stringify({
          id: "fixture",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "prepare",
                    type: "function",
                    function: {
                      name: "advance",
                      arguments: JSON.stringify({
                        nodeId: "app",
                        expectedRevision: 1,
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = {
    NODE_ENV: "test",
    CEREMONY_TEST_PROFILE: "true",
    CEREMONY_PUBLIC_ORIGIN: origin,
    CEREMONY_DATABASE_URL: `postgresql://${pg.config.user}:${pg.config.password}@127.0.0.1:${pg.config.port}/postgres`,
    CEREMONY_VAULT_KEY: randomBytes(32).toString("hex"),
    CEREMONY_VAULT_KEY_ID: "fixture",
    CEREMONY_OIDC_ISSUER: origin,
    CEREMONY_OIDC_CLIENT_ID: "fixture",
    CEREMONY_TENANT_ID: "tenant",
    CEREMONY_GITHUB_ACCOUNT: "fixture-owner",
    CEREMONY_CONFIGURATION_VERSION: "fixture",
    CEREMONY_MODEL: "fixture",
    CEREMONY_MODEL_URL: `${origin}/v1/chat/completions`,
  };
  const old = new Map(
    Object.keys(config).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, config);
  const runtime = await createHostedRuntime(config);
  try {
    const actor: ActorContext = {
      tenantId: "tenant",
      subjectId: "fixture-subject",
      sessionId: "fixture-session",
      actorKind: "human",
      capabilities: ["executor"],
    };
    const connection = await runtime.connect(actor, "github");
    const session = await runtime.delegate(actor, connection.id);
    const run = await start(ceremonyAgentWorkflow, [connection.id, session]);
    await waitForHook(run, { token: `ceremony-agent:${connection.id}` });
    // Hook is established before the turn; wait for its authoritative status commit.
    await expect
      .poll(
        async () =>
          (await runtime.commands.snapshot(actor, connection.id)).nodes[0]
            ?.state,
      )
      .toBe("awaiting-human");
    expect(calls).toBe(1);
    await runtime.agent.stop(actor, connection.id);
    const wakeKey = {
      tenant: actor.tenantId,
      kind: "outbox" as const,
      id: `agent-wake:${connection.id}:fixture`,
    };
    await runtime.store.transaction((tx) =>
      tx.put(
        wakeKey,
        {
          task: "agent-wake",
          runId: connection.id,
          subjectId: actor.subjectId,
          status: "pending",
        },
        null,
      ),
    );
    await dispatchAgentWakes(runtime, actor.tenantId);
    expect(
      (
        await runtime.store.transaction((tx) =>
          tx.get<{ status: string }>(wakeKey),
        )
      )?.value.status,
    ).toBe("delivered");
    expect(await run.returnValue).toBe("stopped");
    expect(calls).toBe(1);
    expect((await runtime.commands.snapshot(actor, connection.id)).status).toBe(
      "active",
    );
  } finally {
    await runtime.store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pg.close();
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
