import { expect, test } from "vitest";
import { start } from "workflow/api";
import { ceremonyAgentWorkflow } from "../../src/server/agent/workflow.js";
import { createHostedRuntime } from "../../src/server/hosted/runtime.js";
import { postgresFixture } from "../fixtures/postgres.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import { dispatchAgentWakes } from "../../src/server/agent/workflow-api.js";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function restartWorker(dataDir: string) {
  const child = fork(
    new URL("../fixtures/workflow-restart-worker.mjs", import.meta.url),
    [],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        CEREMONY_RESTART_DATA: dataDir,
        CEREMONY_RESTART_BUNDLES: resolve(".workflow-vitest"),
      },
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (success: boolean) => {
        clearTimeout(timer);
        child.off("message", ready);
        child.off("exit", failed);
        child.off("error", failed);
        if (success) resolve();
        else reject(new Error("Workflow worker startup failed"));
      };
      const ready = (message: unknown) =>
        finish(
          !!message &&
            typeof message === "object" &&
            Reflect.get(message, "ready") === true,
        );
      const failed = () => finish(false);
      const timer = setTimeout(failed, 10000);
      child.once("message", ready);
      child.once("exit", failed);
      child.once("error", failed);
    });
  } catch {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped;
    }
    throw new Error("Workflow worker startup failed");
  }
  let sequence = 0;
  return {
    child,
    invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("message", receive);
          child.off("exit", exited);
          reject(new Error("Worker operation timed out"));
        }, 30000);
        const exited = () => {
          clearTimeout(timer);
          child.off("message", receive);
          reject(new Error("Workflow worker exited during operation"));
        };
        const receive = (message: unknown) => {
          if (
            !message ||
            typeof message !== "object" ||
            Reflect.get(message, "id") !== id
          )
            return;
          clearTimeout(timer);
          child.off("message", receive);
          child.off("exit", exited);
          if (Reflect.get(message, "errorCode"))
            reject(new Error("Workflow worker operation failed"));
          else resolve(Reflect.get(message, "result"));
        };
        child.on("message", receive);
        child.once("exit", exited);
        child.send({ ...input, id }, (error) => {
          if (error) {
            child.off("exit", exited);
            exited();
          }
        });
      });
    },
  };
}

test("AGT Workflow compiled local carrier fails closed without configured hosted authority", async () => {
  const run = await start(ceremonyAgentWorkflow, [
    "run:fixture",
    "turn:fixture",
  ]);
  expect(await run.returnValue).toBe("unavailable");
});

test("AGT AC-34 actual Workflow worker SIGKILL and replacement resumes persisted human wait without replaying inference", async () => {
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
      // Real transport latency intentionally exceeds Vitest's default 1s poll
      // budget. The domain-state assertion must still wait for durable commit.
      await new Promise((resolve) => setTimeout(resolve, 1500));
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
  const dataDir = await mkdtemp(join(tmpdir(), "ceremony-workflow-restart-"));
  const workers: ChildProcess[] = [];
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
    const first = await restartWorker(dataDir);
    workers.push(first.child);
    const { workflowRunId } = await first.invoke({
      action: "start",
      workflowId: Reflect.get(ceremonyAgentWorkflow, "workflowId"),
      runId: connection.id,
      sessionId: session,
    });
    // Hook is established before the turn; wait for its authoritative status commit.
    await expect
      .poll(
        async () =>
          (await runtime.commands.snapshot(actor, connection.id)).nodes[0]
            ?.state,
        { timeout: 20000, interval: 100 },
      )
      .toBe("awaiting-human");
    expect(calls).toBe(1);
    await expect
      .poll(
        async () =>
          (await first.invoke({ action: "checkpoint", workflowRunId }))
            .completedSteps,
        { timeout: 20000, interval: 100 },
      )
      .toBe(1);
    const exit = once(first.child, "exit");
    first.child.kill("SIGKILL");
    expect((await exit)[1]).toBe("SIGKILL");
    const second = await restartWorker(dataDir);
    workers.push(second.child);
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(
      (await second.invoke({ action: "checkpoint", workflowRunId }))
        .completedSteps,
    ).toBe(1);
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
    let returnValue: unknown;
    await dispatchAgentWakes(runtime, actor.tenantId, async () => {
      returnValue = (
        await second.invoke({
          action: "resume",
          runId: connection.id,
          workflowRunId,
        })
      ).value;
      return true;
    });
    expect(
      (
        await runtime.store.transaction((tx) =>
          tx.get<{ status: string }>(wakeKey),
        )
      )?.value.status,
    ).toBe("delivered");
    expect(returnValue).toBe("stopped");
    expect(
      (await second.invoke({ action: "checkpoint", workflowRunId }))
        .completedSteps,
    ).toBe(2);
    expect(calls).toBe(1);
    expect((await runtime.commands.snapshot(actor, connection.id)).status).toBe(
      "active",
    );
    const historyFiles = await readdir(dataDir, { recursive: true });
    expect(historyFiles.some((file) => file.endsWith(".json"))).toBe(true);
    for (const file of historyFiles.filter((file) =>
      /\.(json|bin)$/.test(file),
    )) {
      const content = await readFile(join(dataDir, file));
      expect(content.includes(Buffer.from(config.CEREMONY_VAULT_KEY))).toBe(
        false,
      );
      expect(content.includes(Buffer.from(config.CEREMONY_DATABASE_URL))).toBe(
        false,
      );
    }
  } finally {
    for (const worker of workers)
      if (worker.exitCode === null && worker.signalCode === null) {
        const stopped = once(worker, "exit");
        worker.kill("SIGKILL");
        await stopped;
      }
    await rm(dataDir, { recursive: true, force: true });
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
