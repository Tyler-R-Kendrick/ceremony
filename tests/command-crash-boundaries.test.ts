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
import { z } from "zod";
import {
  OperationRegistry,
  type OperationResult,
  type RegisteredOperation,
} from "../src/server/recipes/registry.js";
import { RecipeService } from "../src/server/recipes/index.js";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RecipeOutcome } from "../src/core/recipe-contracts.js";

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
test("AC-27: concurrent authenticated UI and agent HTTP requests share one effect across independent PostgreSQL connections", async (t) => {
  const releaseProvider = Promise.withResolvers<void>();
  const enteredProvider = Promise.withResolvers<void>();
  const duplicateHoldingRun = Promise.withResolvers<void>();
  const completionAtLock = Promise.withResolvers<void>();
  const database = await postgresFixture(),
    provider = await providerFixture(
      releaseProvider.promise,
      enteredProvider.resolve,
    );
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
    const uiRequest = request("ui");
    await Promise.race([
      enteredProvider.promise,
      uiRequest.then(() => assert.fail("UI must reach the provider")),
    ]);
    // Hold the duplicate's run lock while completion acquires its first lock.
    // Taking the lease first creates a run/lease deadlock across these connections.
    const aTransaction = a.transaction.bind(a);
    t.mock.method(
      a,
      "transaction",
      (work: Parameters<typeof aTransaction>[0]) =>
        aTransaction(async (tx) => {
          const get = tx.get.bind(tx);
          const assertFence = tx.assertFence.bind(tx);
          t.mock.method(tx, "get", (...args: Parameters<typeof get>) => {
            completionAtLock.resolve();
            return get(...args);
          });
          t.mock.method(
            tx,
            "assertFence",
            async (...args: Parameters<typeof assertFence>) => {
              await assertFence(...args);
              completionAtLock.resolve();
            },
          );
          return work(tx);
        }),
    );
    const bTransaction = b.transaction.bind(b);
    t.mock.method(
      b,
      "transaction",
      (work: Parameters<typeof bTransaction>[0]) =>
        bTransaction(async (tx) => {
          const claim = tx.claim.bind(tx);
          t.mock.method(
            tx,
            "claim",
            async (...args: Parameters<typeof claim>) => {
              duplicateHoldingRun.resolve();
              await completionAtLock.promise;
              return claim(...args);
            },
          );
          return work(tx);
        }),
    );
    const agentRequest = request("agent");
    await Promise.race([
      duplicateHoldingRun.promise,
      agentRequest.then(() =>
        assert.fail("Agent must reach the duplicate claim"),
      ),
    ]);
    releaseProvider.resolve();
    const responses = await Promise.all([uiRequest, agentRequest]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [200, 200],
    );
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
    releaseProvider.resolve();
    completionAtLock.resolve();
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
      // The fixture's server is stopped while this pool may still hold an idle
      // client, and pg rethrows a pool `error` event that nothing is listening
      // for. See the note in tests/persistence.test.ts.
      admin.on("error", () => {});
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
      // A new command id for the step, sent before the crashed one is
      // replayed, is refused and makes no provider call.
      await assert.rejects(
        resumed.advance(
          crashActor,
          run.id,
          "node",
          (await resumed.snapshot(crashActor, run.id)).revision,
          "new-command-before-replay",
        ),
      );
      assert.equal(provider.effects.size, expectedEffects);
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

// ---------------------------------------------------------------------------
// The way out of an `uncertain` step, and retry permission, by the replay an
// operation is registered with. An operation with no declared replay is
// treated as "reconciliation".
// ---------------------------------------------------------------------------

type Replay = NonNullable<RegisteredOperation["replay"]>;

const replayActor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher"],
};
const replayContext = {
  provider: "probe",
  profile: "probe-api",
  target: "probe-target",
  origin: "https://app.example",
  environment: "test",
  configurationVersion: "v1",
};
const retryOutcome: RecipeOutcome = {
  successCriteria: [],
  retry: { limit: 2, afterMs: 0, criteria: [] },
  values: {},
};

/**
 * One step, `check`, whose operation is registered with `replay` (none when
 * undefined). `results[n]` decides the n-th handler call: "throw" throws,
 * anything else is the state it returns.
 */
function replayFixture(
  t: { after(fn: () => unknown): void },
  replay: Replay | undefined,
  results: ("throw" | OperationResult["state"])[] = ["complete"],
) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  t.after(() => store.close());
  const registry = new OperationRegistry(
    new Map([
      [
        "probe.status",
        { schema: z.string().max(40), classification: "public" as const },
      ],
    ]),
  );
  let calls = 0;
  registry.register({
    contract: {
      id: "probe.check",
      version: "1.0.0",
      provider: "probe",
      profile: "probe-api",
      inputs: {},
      outputs: { status: { contract: "probe.status", required: false } },
      effects: ["read"],
      verifier: "probe",
      humanFallback: "none",
    },
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ status: z.string().optional() }),
    classifications: {},
    fixtures: ["tests/command-crash-boundaries.test.ts"],
    ...(replay ? { replay } : {}),
    handler: async () => {
      const result = results[Math.min(calls, results.length - 1)]!;
      calls++;
      if (result === "throw") throw new Error("connection reset");
      return { state: result, outputs: {} };
    },
    verify: async () => true,
  });
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const recipes = new RecipeService(store, registry);
  const node = (outcome?: RecipeOutcome) => ({
    id: "check",
    operationId: "probe.check",
    operationVersion: "1.0.0",
    dependsOn: [],
    bindings: {},
    ...(outcome ? { outcome } : {}),
  });
  return {
    registry,
    commands,
    calls: () => calls,
    createRun: (outcome?: RecipeOutcome) =>
      commands.createRun(replayActor, replayContext, [node(outcome)], {}),
    preview: (outcome: RecipeOutcome) =>
      recipes.preview(replayActor, {
        schemaVersion: 1,
        id: "probe-once",
        title: "Probe once",
        description: "",
        inputs: {},
        invocations: [
          {
            id: "check",
            use: { kind: "operation", id: "probe.check", version: "1.0.0" },
            dependsOn: [],
            bindings: {},
            outcome,
          },
        ],
        outputs: {},
      }),
    advance: async (runId: string, commandId: string) =>
      commands.advance(
        replayActor,
        runId,
        "check",
        (await commands.snapshot(replayActor, runId)).revision,
        commandId,
      ),
    outbox: () =>
      store.transaction(async (tx) =>
        (
          await tx.list<{ task: string; status: string }>(
            replayActor.tenantId,
            "outbox",
          )
        ).map((entry) => [entry.id, entry.value.task, entry.value.status]),
      ),
  };
}

for (const replay of ["read-only", "upstream-idempotency-key"] as const)
  test(`a recipe retry is allowed for an operation registered replay "${replay}"`, async (t) => {
    const f = replayFixture(t, replay);
    assert.deepEqual((await f.preview(retryOutcome)).diagnostics, []);
    const run = await f.createRun(retryOutcome);
    assert.equal(run.status, "active");
  });

for (const replay of ["reconciliation", undefined] as const)
  test(`a recipe retry is refused for an operation registered ${replay ? `replay "${replay}"` : "with no replay"}`, async (t) => {
    const f = replayFixture(t, replay);
    assert.deepEqual((await f.preview(retryOutcome)).diagnostics, [
      { code: "retry-not-replay-safe", node: "check" },
    ]);
    await assert.rejects(f.createRun(retryOutcome), /denied/);
  });

for (const replay of [
  "reconciliation",
  "upstream-idempotency-key",
  undefined,
] as const)
  test(`an uncertain step of an operation registered ${replay ? `replay "${replay}"` : "with no replay"} waits for its reconciliation: a new id is refused`, async (t) => {
    const f = replayFixture(t, replay, ["throw", "complete"]);
    const run = await f.createRun();
    assert.equal((await f.advance(run.id, "first")).state, "uncertain");
    assert.deepEqual(await f.outbox(), [
      ["reconciliation:first", "reconciliation-required", "pending"],
    ]);
    await assert.rejects(f.advance(run.id, "second"), /denied/);
    assert.equal(f.calls(), 1);
    assert.deepEqual(await f.outbox(), [
      ["reconciliation:first", "reconciliation-required", "pending"],
    ]);
  });

test("a read-only step that completes under a new id resolves the reconciliation entries its uncertain calls left", async (t) => {
  const f = replayFixture(t, "read-only", ["throw", "uncertain", "complete"]);
  const run = await f.createRun();
  assert.equal((await f.advance(run.id, "first")).state, "uncertain");
  assert.equal((await f.advance(run.id, "second")).state, "uncertain");
  assert.deepEqual(await f.outbox(), [
    ["reconciliation:first", "reconciliation-required", "pending"],
    ["reconciliation:second", "reconciliation-required", "pending"],
  ]);
  const third = await f.advance(run.id, "third");
  assert.deepEqual([third.state, third.verified], ["complete", true]);
  assert.equal(f.calls(), 3);
  assert.deepEqual(await f.outbox(), [
    ["reconciliation:first", "reconciliation-required", "resolved"],
    ["reconciliation:second", "reconciliation-required", "resolved"],
  ]);
});

test("a read-only step that fails under a new id leaves the reconciliation entry pending", async (t) => {
  const f = replayFixture(t, "read-only", ["throw", "failed"]);
  const run = await f.createRun();
  assert.equal((await f.advance(run.id, "first")).state, "uncertain");
  assert.equal((await f.advance(run.id, "second")).state, "failed");
  assert.deepEqual(await f.outbox(), [
    ["reconciliation:first", "reconciliation-required", "pending"],
  ]);
});

test("every operation registered in the default server registries has an effective replay, listed", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  t.after(() => store.close());
  const configuration = async () => ({ version: "v1" });
  const runtime = createGitHubRuntime({
    store,
    identity: { authenticate: async () => replayActor },
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
    stripe: { configuration },
    supabase: { configuration },
    jira: { configuration },
    allowTarget: async () => true,
    authorize: async () => true,
  });
  const registry = runtime.registry as OperationRegistry & {
    replays?(): { id: string; version: string; replay: Replay }[];
  };
  assert.equal(
    typeof registry.replays,
    "function",
    "the registry lists each registration with its effective replay",
  );
  const listed = registry.replays!();
  t.diagnostic(
    listed
      .map((entry) => `${entry.id}@${entry.version} ${entry.replay}`)
      .join("\n"),
  );
  const catalog = registry.catalog();
  assert.ok(catalog.length > 0);
  assert.deepEqual(
    listed.map((entry) => `${entry.id}@${entry.version}`).sort(),
    catalog.map((contract) => `${contract.id}@${contract.version}`).sort(),
  );
  for (const entry of listed) {
    const declared = registry.get(entry.id, entry.version)!.replay;
    assert.equal(entry.replay, declared ?? "reconciliation", entry.id);
  }
});
