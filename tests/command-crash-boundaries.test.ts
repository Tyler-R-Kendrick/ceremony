import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import {
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import { ProtectedCommandService } from "../src/server/commands.js";
import { Demonstrations } from "../src/server/demonstrations.js";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { postgresFixture } from "./fixtures/postgres.js";
import { crashActor, crashRegistry } from "./fixtures/command-crash-worker.js";

const context = {
  provider: "fixture",
  profile: "one-shot",
  target: "account",
  origin: "https://host.example",
  environment: "test",
  configurationVersion: "v1",
};
const nodes = [
  {
    id: "node",
    operationId: "provider-effect",
    operationVersion: "1.0.0",
    dependsOn: [],
    bindings: {},
  },
];
async function providerFixture(gate?: Promise<void>, arrived?: () => void) {
  const effects = new Map<string, number>();
  const server = createServer(async (req, res) => {
    if (req.method === "POST") {
      const id = String(req.headers["idempotency-key"]);
      effects.set(id, (effects.get(id) ?? 0) + 1);
      arrived?.();
      await gate;
      if (req.headers["x-fixture-mode"] === "after-request") {
        req.socket.destroy();
        return;
      }
      res.end("{}");
      return;
    }
    const id = decodeURIComponent(req.url!.slice("/evidence/".length));
    res.statusCode = effects.has(id) ? 200 : 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    effects,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const orderings = [
  ["cancel", "callback", "worker"],
  ["cancel", "worker", "callback"],
  ["callback", "cancel", "worker"],
  ["callback", "worker", "cancel"],
  ["worker", "cancel", "callback"],
  ["worker", "callback", "cancel"],
] as const;
for (const ordering of orderings)
  test(`AC-33: callback/cancel/worker ordering ${ordering.join(" -> ")} preserves verified authority`, async () => {
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const provider = await providerFixture(gate, arrived);
    const store = new SQLiteCeremonyStore(":memory:", {
      current: "key",
      keys: { key: randomBytes(32) },
    });
    const commands = new ProtectedCommandService(
      store,
      crashRegistry(provider.url),
      async () => true,
    );
    try {
      const run = await commands.createRun(crashActor, context, nodes, {});
      let pending: Promise<unknown> | undefined;
      let workerReturned = false;
      for (const event of ordering) {
        if (event === "callback") {
          pending = commands
            .advance(crashActor, run.id, "node", 1, "ordered-command")
            .then(
              (value) => value,
              () => undefined,
            );
          await Promise.race([entered, pending]);
          if (workerReturned) await pending;
          else
            assert.equal(
              (await commands.snapshot(crashActor, run.id)).nodes[0]!.verified,
              false,
            );
        }
        if (event === "worker") {
          workerReturned = true;
          release();
          if (pending) await pending;
        }
        if (event === "cancel") {
          const current = await commands.snapshot(crashActor, run.id);
          await commands.cancel(crashActor, run.id, current.revision);
        }
      }
      await pending;
      const final = await commands.snapshot(crashActor, run.id);
      assert.equal(final.status, "cancelled");
      const verifiedBeforeCancel =
        ordering.indexOf("cancel") > ordering.indexOf("callback") &&
        ordering.indexOf("cancel") > ordering.indexOf("worker");
      assert.equal(final.nodes[0]!.verified, verifiedBeforeCancel);
      assert.ok([...provider.effects.values()].every((count) => count === 1));
      await assert.rejects(
        commands.advance(
          crashActor,
          run.id,
          "node",
          final.revision,
          "late-new-command",
        ),
      );
    } finally {
      release();
      await store.close();
      await provider.close();
    }
  });
test("AC-27: concurrent authenticated UI and agent HTTP requests share one effect across independent PostgreSQL connections", async () => {
  const database = await postgresFixture(),
    provider = await providerFixture();
  const keys = { current: "test", keys: { test: randomBytes(32) } };
  const a = new PostgresCeremonyStore(database.config, keys),
    b = new PostgresCeremonyStore(database.config, keys);
  const runtimeOptions = {
    registry: crashRegistry(provider.url),
    identity: { authenticate: async () => null },
    origin: context.origin,
    context: async () => context,
    authorize: async (actor: typeof crashActor) =>
      actor.subjectId === crashActor.subjectId,
  };
  const uiRuntime = createTeachingRuntime({ ...runtimeOptions, store: a });
  const agentRuntime = createTeachingRuntime({ ...runtimeOptions, store: b });
  const ui = uiRuntime.commands,
    agent = agentRuntime.commands;
  await a.migrate();
  const run = await ui.createRun(crashActor, context, nodes, {});
  await uiRuntime.delegate(crashActor, run.id);
  const app = createServer(async (req, res) => {
    if (req.headers.cookie !== "fixture-auth=subject") {
      res.statusCode = 401;
      res.end();
      return;
    }
    try {
      const isAgent = req.url === "/agent";
      const result = await (isAgent ? agent : ui).advance(
        isAgent ? await agentRuntime.agentActor(run.id) : crashActor,
        run.id,
        "node",
        1,
        "shared-command",
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch {
      res.statusCode = 409;
      res.end("{}");
    }
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const address = app.address();
  assert.ok(address && typeof address !== "string");
  try {
    const request = (path: string) =>
      fetch(`http://127.0.0.1:${address.port}/${path}`, {
        method: "POST",
        headers: { cookie: "fixture-auth=subject" },
      });
    const responses = await Promise.all([request("ui"), request("agent")]);
    assert.ok(responses.every((r) => r.status === 200));
    const results = await Promise.all(responses.map((r) => r.json()));
    assert.ok(results.some((r) => r.verified));
    assert.equal(provider.effects.size, 1);
    assert.deepEqual([...provider.effects.values()], [1]);
    assert.equal((await (await request("agent")).json()).verified, true);
    assert.equal(
      (await b.transaction((tx) => tx.list(crashActor.tenantId, "effect")))
        .length,
      1,
    );
  } finally {
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await a.close();
    await b.close();
    await provider.close();
    await database.close();
  }
});

for (const [mode, exitCode, expectedEffects] of [
  ["before-request", 71, 0],
  ["after-request", 72, 1],
  ["after-response", 73, 1],
  ["after-commit", 74, 1],
] as const) {
  test(`AC-29: real process termination ${mode} preserves intent and never blindly repeats provider effects`, async () => {
    const database = await postgresFixture(),
      provider = await providerFixture();
    const key = randomBytes(32);
    const store = new PostgresCeremonyStore(database.config, {
      current: "test",
      keys: { test: key },
    });
    const commands = new ProtectedCommandService(
      store,
      crashRegistry(provider.url),
      async () => true,
    );
    try {
      await store.migrate();
      const run = await commands.createRun(crashActor, context, nodes, {});
      await new Demonstrations(store).start(crashActor, run.id);
      const worker = spawn(
        process.execPath,
        [
          "--no-experimental-webstorage",
          "--import",
          "tsx",
          "tests/fixtures/command-crash-worker.ts",
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            CEREMONY_CRASH_WORKER: JSON.stringify({
              database: database.config,
              key: key.toString("hex"),
              provider: provider.url,
              mode,
              runId: run.id,
            }),
          },
          stdio: "ignore",
        },
      );
      const [code] = await once(worker, "exit");
      assert.equal(code, exitCode);
      const intent = await store.transaction((tx) =>
        tx.list<{ status: string }>(crashActor.tenantId, "effect"),
      );
      assert.equal(intent.length, 1);
      assert.equal(provider.effects.size, expectedEffects);
      // Simulate database-clock lease expiration after the dead process; no sleeping or clock selected by a client.
      const admin = new Pool(database.config);
      try {
        await admin.query("UPDATE ceremony_claims SET expires=0");
      } finally {
        await admin.end();
      }
      const resumed = new ProtectedCommandService(
        store,
        crashRegistry(provider.url),
        async () => true,
      );
      const replay = await resumed.advance(
        crashActor,
        run.id,
        "node",
        1,
        "crash-command",
      );
      assert.equal(replay.verified, mode === "after-commit");
      assert.equal(
        replay.state,
        mode === "after-commit" ? "complete" : "uncertain",
      );
      if (mode !== "after-commit") {
        await assert.rejects(
          resumed.advance(
            crashActor,
            run.id,
            "node",
            replay.revision,
            "new-command-after-crash",
          ),
          /denied/,
        );
        const events = await store.transaction((tx) =>
          tx.list<{ afterState?: string }>(crashActor.tenantId, "event"),
        );
        assert.ok(
          events.some((event) => event.value.afterState === "uncertain"),
        );
        const outbox = await store.transaction((tx) =>
          tx.list<{ task?: string }>(crashActor.tenantId, "outbox"),
        );
        assert.ok(
          outbox.some(
            (event) => event.value.task === "reconciliation-required",
          ),
        );
      }
      assert.equal(provider.effects.size, expectedEffects);
      assert.ok([...provider.effects.values()].every((n) => n === 1));
      const after = await store.transaction((tx) =>
        tx.list(crashActor.tenantId, "effect"),
      );
      assert.equal(after[0]!.id, intent[0]!.id);
      assert.equal(
        (await resumed.snapshot(crashActor, run.id)).status,
        mode === "after-commit" ? "complete" : "active",
      );
    } finally {
      await store.close();
      await provider.close();
      await database.close();
    }
  });
}
