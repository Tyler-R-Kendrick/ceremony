import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { AsyncGitHubChildren } from "../src/server/recipes/github.js";
import type { OperationContext } from "../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";

// Cancel is two transactions: the run's (commands.ts cancel), then the
// hand-off's (github.ts cancel()). Between them, a GitHub call that was in
// flight when the run's cancel committed must not store anything. Each test
// holds one GitHub call open, commits the run's cancel, then lets GitHub
// answer, and checks the write that follows the call is refused.

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

async function fixture(t: TestContext, configured: boolean) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = {
    id: 42,
    slug: "ceremony-fixture",
    owner: { login: "alice" },
    pem: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
  let held: { path: string; started: () => void; gate: Promise<void> } | null =
    null;
  let lost = false;
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    if (held && held.path === path) {
      const current = held;
      held = null;
      current.started();
      await current.gate;
    }
    if (path === "/users/alice") return json({ login: "alice", type: "User" });
    if (path.startsWith("/app-manifests/")) {
      if (lost) throw new TypeError("connection closed");
      return json(app);
    }
    if (path === "/app")
      return json({
        id: app.id,
        slug: app.slug,
        owner: app.owner,
        permissions: { contents: "read" },
      });
    if (path === "/app/installations/7")
      return json({
        id: 7,
        app_id: 42,
        account: { login: "alice" },
        suspended_at: null,
        permissions: { contents: "read" },
      });
    if (path === "/app/installations/7/access_tokens")
      return json({
        token: "synthetic-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { contents: "read" },
      });
    if (path === "/installation/repositories")
      return json({ total_count: 1, repositories: [{ id: 9 }] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const options = {
    origin: "http://127.0.0.1:4173",
    environment: "local",
    configurationVersion: "v1",
    expectedAccount: "alice",
    ...(configured ? { app } : {}),
    authorize: async () => {},
    fetch: fake,
  };
  const github = new AsyncGitHubChildren(store, options);
  const context: OperationContext = {
    actor: {
      tenantId: "tenant",
      subjectId: "alice-subject",
      sessionId: "session",
      actorKind: "human",
      capabilities: ["executor"],
    },
    runId: "run:fixture",
    nodeId: "node",
    commandId: "command",
    effectId: "effect",
    target: "alice",
    configurationVersion: "v1",
    origin: options.origin,
    environment: "local",
    signal: new AbortController().signal,
  };
  const runKey = { tenant: "tenant", kind: "run" as const, id: context.runId };
  await store.transaction((tx) => tx.put(runKey, { status: "active" }, null));
  return {
    store,
    github,
    context,
    app,
    loseConversion(value: boolean) {
      lost = value;
    },
    /**
     * Holds the next GitHub call to `path` open, commits the run's cancel
     * while it is open (as commands.ts cancel does: status "cancelled"), then
     * lets GitHub answer.
     */
    async cancelDuring<T>(path: string, work: () => Promise<T>) {
      let started!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => (started = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      held = { path, started, gate };
      const outcome = work().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await waiting;
        await store.transaction(async (tx) => {
          const run = (await tx.get<Record<string, unknown>>(runKey))!;
          await tx.cancel(runKey);
          await tx.put(
            runKey,
            { ...run.value, status: "cancelled" },
            run.revision,
          );
        });
      } finally {
        release();
      }
      return outcome;
    },
    /** The stored artifact of this kind, if any. */
    async artifact(kind: "app" | "installation" | "connection") {
      const key = github["artifactKey"](context, kind);
      return store.transaction(async (tx) => (await tx.get(key))?.value);
    },
    /** The run's own hand-off record. */
    async handoff() {
      return store.transaction(
        async (tx) =>
          (await tx.get<Record<string, unknown>>(github["key"](context)))
            ?.value,
      );
    },
    /** The shared setup record the registration hand-off is kept in. */
    async setup() {
      return store.transaction(
        async (tx) =>
          (await tx.get<Record<string, unknown>>(github["setupKey"](context)))
            ?.value,
      );
    },
  };
}

function callbackUrl(
  context: OperationContext,
  handoffUrl: string,
  query: string,
) {
  const state = new URL(handoffUrl).searchParams.get("state");
  return new URL(
    `${context.origin}/api/v1/teaching/github/${encodeURIComponent(context.runId)}/callback?state=${state}&${query}`,
  );
}

test("a verified app is not saved once the run's cancel has committed", async (t) => {
  const f = await fixture(t, true);
  const outcome = await f.cancelDuring("/app", () =>
    f.github.prepare(f.context),
  );
  assert.match(String("error" in outcome && outcome.error), /cancelled/);
  assert.equal(await f.artifact("app"), undefined, "the app was saved");
});

test("an installation return stores nothing once the run's cancel has committed", async (t) => {
  const f = await fixture(t, true);
  const prepared = await f.github.prepare(f.context);
  await f.github.install(f.context, prepared.outputs.app);
  const human = await f.github.human(f.context);
  const outcome = await f.cancelDuring("/app/installations/7", () =>
    f.github.callback(
      f.context,
      callbackUrl(f.context, human.url, "installation_id=7"),
    ),
  );
  assert.match(String("error" in outcome && outcome.error), /cancelled/);
  assert.equal((await f.handoff())?.phase, "installation");
  assert.equal(
    await f.artifact("installation"),
    undefined,
    "the installation was stored",
  );
});

test("a verified connection is not saved once the run's cancel has committed", async (t) => {
  const f = await fixture(t, true);
  const prepared = await f.github.prepare(f.context);
  await f.github.install(f.context, prepared.outputs.app);
  const human = await f.github.human(f.context);
  await f.github.callback(
    f.context,
    callbackUrl(f.context, human.url, "installation_id=7"),
  );
  const installed = await f.github.install(f.context, prepared.outputs.app);
  assert.equal(installed.state, "complete");
  const outcome = await f.cancelDuring("/installation/repositories", () =>
    f.github.verifyAccess(f.context, installed.outputs.installation),
  );
  assert.match(String("error" in outcome && outcome.error), /cancelled/);
  assert.equal(
    await f.artifact("connection"),
    undefined,
    "the connection was saved",
  );
});

test("a recovered app is not stored once the run's cancel has committed", async (t) => {
  const f = await fixture(t, false);
  assert.equal((await f.github.prepare(f.context)).state, "awaiting-human");
  const human = await f.github.human(f.context);
  f.loseConversion(true);
  await assert.rejects(
    f.github.callback(
      f.context,
      callbackUrl(f.context, human.url, "code=lost"),
    ),
    /reconciliation/,
  );
  f.loseConversion(false);
  assert.equal((await f.setup())?.phase, "uncertain");
  const outcome = await f.cancelDuring("/app", () =>
    f.github.recover(f.context, { appId: f.app.id, pem: f.app.pem }),
  );
  assert.match(String("error" in outcome && outcome.error), /cancelled/);
  const setup = await f.setup();
  assert.equal(setup?.phase, "uncertain");
  assert.equal(setup?.app, undefined, "the recovered app was stored");
});
