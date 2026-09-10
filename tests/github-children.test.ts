import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { jwtVerify } from "jose";
import {
  AsyncGitHubChildren,
  githubVocabulary,
  resolveGitHubInstallationRun,
} from "../src/server/recipes/github.js";
import {
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/registry.js";
import {
  SQLiteCeremonyStore,
  PostgresCeremonyStore,
} from "../src/server/persistence/index.js";
import { postgresFixture } from "./fixtures/postgres.js";

async function fixture(t: TestContext, configured = false) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = {
    id: 42,
    slug: "ceremony-fixture",
    owner: { login: "alice" },
    pem: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
  const counters = { conversion: 0, token: 0, verification: 0 };
  let conversionGate: (() => Promise<void>) | undefined;
  const behavior = {
    accountType: "User",
    lostConversion: false,
    wrongAccount: false,
    suspended: false,
    extraPermission: false,
    revoked: false,
  };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      const path = new URL(req.url!, "http://fixture").pathname;
      if (path === "/users/alice") {
        res.end(JSON.stringify({ login: "alice", type: behavior.accountType }));
        return;
      }
      if (path.startsWith("/app-manifests/")) {
        counters.conversion++;
        await conversionGate?.();
        if (behavior.lostConversion) {
          req.socket.destroy();
          return;
        }
        res.end(JSON.stringify(app));
        return;
      }
      if (path !== "/installation/repositories")
        await jwtVerify(req.headers.authorization!.slice(7), pair.publicKey, {
          issuer: "42",
          algorithms: ["RS256"],
        });
      if (path === "/app")
        res.end(
          JSON.stringify({
            ...app,
            pem: undefined,
            permissions: { contents: "read" },
          }),
        );
      else if (path === "/app/installations/7")
        res.end(
          JSON.stringify({
            id: 7,
            app_id: 42,
            account: { login: behavior.wrongAccount ? "mallory" : "alice" },
            suspended_at: behavior.suspended ? new Date().toISOString() : null,
            permissions: {
              contents: "read",
              ...(behavior.extraPermission ? { issues: "write" } : {}),
            },
          }),
        );
      else if (path === "/app/installations/7/access_tokens") {
        counters.token++;
        res.end(
          JSON.stringify({
            token: "synthetic-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: { contents: "read" },
          }),
        );
      } else if (path === "/installation/repositories") {
        assert.equal(
          req.headers.authorization,
          "Bearer synthetic-installation-token",
        );
        counters.verification++;
        res.end(JSON.stringify({ total_count: 1, repositories: [{ id: 9 }] }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    } catch {
      res.statusCode = 401;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(async () => {
    await store.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const options = {
    origin: "http://127.0.0.1:4173",
    environment: "local",
    configurationVersion: "v1",
    expectedAccount: "alice",
    ...(configured ? { app } : {}),
    authorize: async () => {
      if (behavior.revoked) throw new Error("Authorization denied");
    },
    fetch: ((input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      return fetch(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        init,
      );
    }) as typeof fetch,
  };
  const github = new AsyncGitHubChildren(store, options);
  const registry = new OperationRegistry(githubVocabulary);
  github.register(registry);
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
  async function callback(query: string, selected = context) {
    const human = await github.human(selected);
    const nonce = new URL(human.url).searchParams.get("state");
    return github.callback(
      selected,
      new URL(
        `${options.origin}/api/v1/teaching/github/${encodeURIComponent(selected.runId)}/callback?state=${nonce}&${query}`,
      ),
    );
  }
  return {
    store,
    options,
    github,
    registry,
    context,
    counters,
    behavior,
    callback,
    app,
    pauseConversion() {
      let started!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      conversionGate = async () => {
        started();
        await gate;
      };
      return { waiting, release };
    },
  };
}

test("AC-32: independent PostgreSQL parents share scoped setup and cancellation preserves the other subscriber", async (t) => {
  const f = await fixture(t);
  const pg = await postgresFixture();
  const keys = { current: "shared", keys: { shared: randomBytes(32) } };
  const aStore = new PostgresCeremonyStore(pg.config, keys),
    bStore = new PostgresCeremonyStore(pg.config, keys);
  try {
    await aStore.migrate();
    const a = new AsyncGitHubChildren(aStore, f.options),
      b = new AsyncGitHubChildren(bStore, f.options);
    const first = { ...f.context, runId: "run:first" },
      second = { ...f.context, runId: "run:second" };
    const foreign = {
      ...f.context,
      runId: "run:foreign",
      actor: { ...f.context.actor, subjectId: "foreign" },
    };
    const results = await Promise.all([
      a.prepare(first),
      b.prepare(second),
      b.prepare(foreign),
    ]);
    assert.ok(results.every((r) => r.state === "awaiting-human"));
    const firstHuman = await a.human(first),
      secondHuman = await b.human(second),
      foreignHuman = await b.human(foreign);
    assert.equal(
      new URL(firstHuman.url).searchParams.get("state"),
      new URL(secondHuman.url).searchParams.get("state"),
    );
    assert.notEqual(
      new URL(firstHuman.url).searchParams.get("state"),
      new URL(foreignHuman.url).searchParams.get("state"),
    );
    const paused = f.pauseConversion();
    const callback = b.callback(
      second,
      new URL(
        `${f.options.origin}/api/v1/teaching/github/${encodeURIComponent(second.runId)}/callback?state=${new URL(secondHuman.url).searchParams.get("state")}&code=once`,
      ),
    );
    await paused.waiting;
    await a.cancel(first);
    paused.release();
    await callback;
    assert.equal(f.counters.conversion, 1);
    await assert.rejects(a.prepare(first), /cancelled/);
    const prepared = await b.prepare(second);
    assert.equal(prepared.state, "complete");
    assert.equal((await b.prepare(foreign)).state, "awaiting-human");
    assert.equal(
      (await b.install(second, prepared.outputs.app)).state,
      "awaiting-human",
    );
    assert.equal((await b.human(second)).method, "GET");
    const nextFirst = {
      ...first,
      runId: "run:next-first",
      configurationVersion: "v2",
    };
    const nextSecond = {
      ...second,
      runId: "run:next-second",
      configurationVersion: "v2",
    };
    const nextA = new AsyncGitHubChildren(aStore, {
      ...f.options,
      configurationVersion: "v2",
    });
    const nextB = new AsyncGitHubChildren(bStore, {
      ...f.options,
      configurationVersion: "v2",
    });
    await nextA.prepare(nextFirst);
    await nextB.prepare(nextSecond);
    const originalHuman = await nextA.human(nextFirst);
    const originalCallback = new URL(
      `${f.options.origin}/api/v1/teaching/github/${encodeURIComponent(nextFirst.runId)}/callback?state=${new URL(originalHuman.url).searchParams.get("state")}&code=next-once`,
    );
    await nextA.cancel(nextFirst);
    assert.equal(
      await nextA.activeSetupSubscriber(nextFirst, originalCallback),
      nextSecond.runId,
    );
    await assert.rejects(
      nextA.activeSetupSubscriber(
        { ...nextFirst, actor: foreign.actor },
        originalCallback,
      ),
      /unavailable/,
    );
    const redirected = new URL(originalCallback);
    redirected.pathname = `/api/v1/teaching/github/${encodeURIComponent(nextSecond.runId)}/callback`;
    await nextB.callback(nextSecond, redirected);
    assert.equal((await nextB.prepare(nextSecond)).state, "complete");
    assert.equal(f.counters.conversion, 2);
    await assert.rejects(
      nextA.activeSetupSubscriber(nextFirst, originalCallback),
      /unavailable/,
    );
    await nextB.cancel(nextSecond);
    await assert.rejects(
      nextA.activeSetupSubscriber(nextFirst, originalCallback),
      /unavailable/,
    );
  } finally {
    await aStore.close();
    await bStore.close();
    await pg.close();
  }
});

test("real GitHub registration selects the account type endpoint and registers an installation setup URL", async (t) => {
  const f = await fixture(t);
  await f.github.prepare(f.context);
  const personal = await f.github.human(f.context);
  assert.equal(new URL(personal.url).pathname, "/settings/apps/new");
  assert.equal(personal.method, "POST");
  if (personal.method !== "POST") throw new Error("registration required");
  assert.equal(
    personal.manifest.setup_url,
    `${f.options.origin}/api/v1/teaching/github/installation-return`,
  );
  assert.equal(personal.manifest.url, f.options.origin);
  assert.equal("hook_attributes" in personal.manifest, false);
  assert.equal(personal.manifest.setup_on_update, true);
  assert.equal(
    "callback_urls" in personal.manifest,
    false,
    "App OAuth is not the installation handshake",
  );
  f.behavior.accountType = "Organization";
  const organization = await f.github.human(f.context);
  assert.equal(
    new URL(organization.url).pathname,
    "/organizations/alice/settings/apps/new",
  );
  f.behavior.accountType = "Bot";
  await assert.rejects(f.github.human(f.context));
  assert.equal(f.counters.conversion, 0);
});

test("expired unissued registration renews safely; issued registration enters recoverable uncertainty", async (t) => {
  const f = await fixture(t);
  await f.github.prepare(f.context);
  await assert.rejects(
    f.store.transaction((tx) => f.github.restartRegistration(f.context, tx)),
    /restart unavailable/,
  );
  const expire = () =>
    f.store.transaction(async (tx) => {
      const local = await tx.get<{ sharedSetup: string }>({
        tenant: "tenant",
        kind: "handoff",
        id: `github:${f.context.runId}`,
      });
      const key = {
        tenant: "tenant",
        kind: "handoff" as const,
        id: local!.value.sharedSetup,
      };
      const state = await tx.get<Record<string, unknown>>(key);
      await tx.put(key, { ...state!.value, expires: 0 }, state!.revision);
    });
  await expire();
  assert.equal((await f.github.prepare(f.context)).state, "awaiting-human");
  await f.github.human(f.context);
  await expire();
  assert.equal((await f.github.prepare(f.context)).state, "uncertain");
  assert.equal(
    (await f.github.prepare({ ...f.context, runId: "new-parent" })).state,
    "uncertain",
  );
  assert.equal(
    f.counters.conversion,
    0,
    "never repeat a possibly completed registration",
  );
  assert.equal(await f.github.registrationRestartAvailable(f.context), true);
  await f.store.transaction((tx) =>
    f.github.restartRegistration(f.context, tx),
  );
  assert.equal(await f.github.registrationRestartAvailable(f.context), false);
  assert.equal((await f.github.prepare(f.context)).state, "awaiting-human");
  await f.github.human(f.context);
  await expire();
  assert.equal((await f.github.prepare(f.context)).state, "uncertain");
  await f.github.recover(f.context, { appId: f.app.id, pem: f.app.pem });
  assert.equal((await f.github.prepare(f.context)).state, "complete");
});

test("installation return routing independently rejects forged actor, origin, state syntax, binding and expiry", async (t) => {
  const f = await fixture(t);
  const nonce = "a".repeat(43);
  const actor = f.context.actor;
  const origin = f.options.origin;
  const fixedNow = Date.now();
  const store = {
    close: async () => {},
    transaction: <T>(
      work: (
        tx: import("../src/server/persistence/index.js").AsyncTransaction,
      ) => Promise<T>,
    ) =>
      f.store.transaction((tx) => work({ ...tx, now: async () => fixedNow })),
  };
  const url = (state = nonce) =>
    new URL(
      `${origin}/api/v1/teaching/github/installation-return?state=${encodeURIComponent(state)}`,
    );
  const save = (state = nonce, changes = {}) =>
    f.store.transaction(async (tx) => {
      const key = {
        tenant: actor.tenantId,
        kind: "handoff" as const,
        id: `github-return:${createHash("sha256").update(state).digest("hex")}`,
      };
      const prior = await tx.get(key);
      await tx.put(
        key,
        {
          subject: actor.subjectId,
          runId: "authorized-parent",
          origin,
          expires: fixedNow + 1,
          ...changes,
        },
        prior?.revision ?? null,
      );
    });
  await save();
  assert.equal(
    await resolveGitHubInstallationRun(store, actor, origin, url()),
    "authorized-parent",
  );
  for (const changed of [
    { actorKind: "agent" as const },
    { actorKind: "system" as const },
    { subjectId: "foreign" },
    { tenantId: "foreign" },
  ])
    await assert.rejects(
      resolveGitHubInstallationRun(
        store,
        { ...actor, ...changed },
        origin,
        url(),
      ),
      /return unavailable/,
    );
  for (const target of [
    new URL(url().href.replace(origin, "https://foreign.example")),
    new URL(`${origin}/other?state=${nonce}`),
    new URL(`${url()}&state=${nonce}`),
    new URL(`${origin}/api/v1/teaching/github/installation-return`),
  ])
    await assert.rejects(
      resolveGitHubInstallationRun(store, actor, origin, target),
      /return unavailable/,
    );
  // Seed invalid tokens deliberately: otherwise a lookup miss masks a removed syntax guard.
  for (const invalid of [
    `!${nonce}`,
    `${nonce}!`,
    "a".repeat(42),
    "a".repeat(44),
  ]) {
    await save(invalid);
    await assert.rejects(
      resolveGitHubInstallationRun(store, actor, origin, url(invalid)),
      /return unavailable/,
    );
  }
  for (const change of [
    { origin: "https://foreign.example" },
    { subject: "foreign" },
    { expires: fixedNow },
    { expires: fixedNow - 1 },
  ]) {
    await save(nonce, change);
    await assert.rejects(
      resolveGitHubInstallationRun(store, actor, origin, url()),
      /return unavailable/,
    );
  }
});

test("installation callback and protected artifact commit atomically across storage failure", async (t) => {
  const f = await fixture(t, true);
  let fail = true;
  const child = new AsyncGitHubChildren(
    {
      close: async () => {},
      transaction: (work) =>
        f.store.transaction((tx) =>
          work({
            ...tx,
            put: async (key, value, revision) => {
              if (
                fail &&
                key.kind === "artifact" &&
                (value as { kind?: string }).kind === "installation"
              )
                throw new Error("injected artifact write failure");
              return tx.put(key, value, revision);
            },
          }),
        ),
    },
    f.options,
  );
  const app = await child.prepare(f.context);
  await child.install(f.context, app.outputs.app);
  const handoff = await child.human(f.context);
  const url = new URL(
    `${f.options.origin}/api/v1/teaching/github/${encodeURIComponent(f.context.runId)}/callback?state=${new URL(handoff.url).searchParams.get("state")}&installation_id=7`,
  );
  await assert.rejects(child.callback(f.context, url), /injected/);
  assert.equal(
    (await child.human(f.context)).url,
    handoff.url,
    "rollback keeps the same recoverable attempt",
  );
  fail = false;
  await child.callback(f.context, url);
  const installed = await child.install(f.context, app.outputs.app);
  assert.equal(installed.state, "complete");
  assert.equal(
    (await child.verifyAccess(f.context, installed.outputs.installation)).state,
    "complete",
  );
  assert.equal(f.counters.token, 1);
});

test("AC-32: cancelling all parents before handoff allows fresh setup without reviving previous state", async (t) => {
  const f = await fixture(t);
  await f.github.prepare(f.context);
  await f.github.cancel(f.context);
  const fresh = { ...f.context, runId: "run:fresh" };
  assert.equal((await f.github.prepare(fresh)).state, "awaiting-human");
  await assert.rejects(f.github.human(f.context), /unavailable/);
  await f.github.human(fresh);
  await f.github.cancel(fresh);
  await assert.rejects(
    f.github.prepare({ ...fresh, runId: "run:unsafe-restart" }),
    /reconciliation/,
  );
  assert.equal(f.counters.conversion, 0);
});

test("AC-26 AC-32: shared setup subscriber limits and revoked callback candidates fail without provider effects", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++)
    await f.github.prepare({ ...f.context, runId: `bounded:${i}` });
  await assert.rejects(
    f.github.prepare({ ...f.context, runId: "bounded:overflow" }),
    /subscriber limit/,
  );
  const first = { ...f.context, runId: "bounded:0" };
  const human = await f.github.human(first);
  const callback = new URL(
    `${f.options.origin}/api/v1/teaching/github/${encodeURIComponent(first.runId)}/callback?state=${new URL(human.url).searchParams.get("state")}&code=bounded`,
  );
  f.behavior.revoked = true;
  await assert.rejects(
    f.github.activeSetupSubscriber(first, callback),
    /unavailable/,
  );
  assert.equal(f.counters.conversion, 0);
});

test("AC-18 AC-36: altered persisted setup scope and expired handoff cannot be reused", async (t) => {
  const f = await fixture(t, true);
  const context = f.context;
  await f.store.transaction((tx) =>
    tx.put(
      {
        tenant: context.actor.tenantId,
        kind: "handoff",
        id: `github:${context.runId}`,
      },
      { scope: "wrong", phase: "registration", nonce: "nonce", expires: 0 },
      null,
    ),
  );
  await assert.rejects(f.github.prepare(context), /context changed/);
  await assert.rejects(f.github.human(context), /handoff unavailable/);
  await assert.rejects(f.github.cancel(context), /handoff unavailable/);
  await f.store.transaction((tx) =>
    tx.delete(
      {
        tenant: context.actor.tenantId,
        kind: "handoff",
        id: `github:${context.runId}`,
      },
      1,
    ),
  );
  const prepared = await f.github.prepare(context);
  await f.github.install(context, prepared.outputs.app);
  await f.store.transaction(async (tx) => {
    const key = {
      tenant: context.actor.tenantId,
      kind: "handoff" as const,
      id: `github:${context.runId}`,
    };
    const saved = await tx.get<Record<string, unknown>>(key);
    await tx.put(key, { ...saved!.value, expires: 0 }, saved!.revision);
  });
  await assert.rejects(f.github.human(context), /expired/);
  assert.equal(f.counters.conversion, 0);
});

test("PRV-07: three registered GitHub children execute real signed HTTP and reuse fresh-principal artifacts", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.github.prepare(f.context)).state, "awaiting-human");
  const human = await f.github.human(f.context);
  assert.equal(human.method, "POST");
  assert.equal(human.manifest?.url, f.context.origin);
  await f.callback("code=one-use");
  const app = await f.github.prepare(f.context);
  assert.equal(app.state, "complete");
  assert.equal(
    (await f.github.install(f.context, app.outputs.app)).state,
    "awaiting-human",
  );
  await f.callback("installation_id=7");
  const installation = await f.github.install(f.context, app.outputs.app);
  const access = await f.github.verifyAccess(
    f.context,
    installation.outputs.installation,
  );
  assert.equal(access.state, "complete");
  assert.deepEqual(f.counters, { conversion: 1, token: 1, verification: 1 });
  assert.equal(
    await f.registry.require("github.verify-access", "1.0.0").verify!(
      f.context,
      access,
    ),
    true,
  );
  const second = { ...f.context, runId: "another-run" };
  const reused = await f.github.prepare(second);
  assert.equal(reused.state, "complete");
  await f.github.verifyAccess(second, installation.outputs.installation);
  assert.equal(f.counters.token, 1);
  await assert.rejects(
    f.github.verifyAccess(
      { ...second, actor: { ...second.actor, subjectId: "other-subject" } },
      installation.outputs.installation,
    ),
    /unavailable/,
  );
  assert.equal(JSON.stringify(access).includes("token"), false);
});

test("PRV-02/05: lost one-use conversion enters uncertainty and cannot replay registration", async (t) => {
  const f = await fixture(t);
  await f.github.prepare(f.context);
  const human = await f.github.human(f.context);
  const callback = new URL(
    `${f.context.origin}/api/v1/teaching/github/${encodeURIComponent(f.context.runId)}/callback?state=${new URL(human.url).searchParams.get("state")}&code=lost`,
  );
  f.behavior.lostConversion = true;
  await assert.rejects(
    f.github.callback(f.context, callback),
    /reconciliation/,
  );
  await assert.rejects(f.github.callback(f.context, callback), /unavailable/);
  assert.equal((await f.github.prepare(f.context)).state, "uncertain");
  assert.equal(f.counters.conversion, 1);
  f.behavior.lostConversion = false;
  await f.github.recover(f.context, { appId: f.app.id, pem: f.app.pem });
  assert.equal((await f.github.prepare(f.context)).state, "complete");
  assert.equal(f.counters.conversion, 1);
  await assert.rejects(
    f.github.recover(f.context, { appId: f.app.id, pem: f.app.pem }),
    /unavailable/,
  );
});

test("PRV-03: wrong account, suspension, excessive permissions and stale context block installation", async (t) => {
  const f = await fixture(t, true);
  const app = await f.github.prepare(f.context);
  await f.github.install(f.context, app.outputs.app);
  for (const flag of [
    "wrongAccount",
    "suspended",
    "extraPermission",
  ] as const) {
    f.behavior[flag] = true;
    await assert.rejects(f.callback("installation_id=7"), /rejected/);
    f.behavior[flag] = false;
  }
  await assert.rejects(
    f.github.prepare({ ...f.context, configurationVersion: "changed" }),
    /unavailable/,
  );
  await assert.rejects(
    f.github.prepare({ ...f.context, target: "mallory" }),
    /unavailable/,
  );
  await assert.rejects(
    f.github.verifyAccess(f.context, "foreign"),
    /unavailable/,
  );
  f.behavior.revoked = true;
  await assert.rejects(f.callback("installation_id=7"), /denied/);
  assert.equal(f.counters.token, 0);
  assert.equal(f.counters.conversion, 0);
});

test("PRV cancellation fences pending human return and cannot revive a run", async (t) => {
  const f = await fixture(t);
  await f.github.prepare(f.context);
  const human = await f.github.human(f.context);
  await f.github.cancel(f.context);
  await assert.rejects(
    f.github.callback(
      f.context,
      new URL(
        `${f.context.origin}/api/v1/teaching/github/${encodeURIComponent(f.context.runId)}/callback?state=${new URL(human.url).searchParams.get("state")}&code=late`,
      ),
    ),
    /unavailable/,
  );
  await assert.rejects(f.github.prepare(f.context), /cancelled/);
  await assert.rejects(f.github.human(f.context), /unavailable/);
  assert.equal(f.counters.conversion, 0);
});

test("PRV registered handlers and verifier reject missing evidence and mismatched context", async (t) => {
  const f = await fixture(t);
  const prepare = f.registry.require("github.prepare-app", "1.0.0");
  const install = f.registry.require("github.authorize-installation", "1.0.0");
  const verify = f.registry.require("github.verify-access", "1.0.0");
  assert.equal(
    await prepare.verify!(f.context, { state: "awaiting-human", outputs: {} }),
    false,
  );
  assert.equal(
    await prepare.verify!(f.context, { state: "complete", outputs: {} }),
    false,
  );
  await assert.rejects(install.handler(f.context, {}), /prerequisite/);
  await assert.rejects(verify.handler(f.context, {}), /prerequisite/);
  assert.equal((await prepare.handler(f.context, {})).state, "awaiting-human");
  assert.equal((await prepare.handler(f.context, {})).state, "awaiting-human");
  for (const changed of [
    { origin: "https://different.example" },
    { environment: "production" },
    { configurationVersion: "v2" },
    { target: "invalid/account" },
  ])
    await assert.rejects(
      f.github.prepare({ ...f.context, ...changed }),
      /unavailable/,
    );
  await assert.rejects(
    f.github.human({
      ...f.context,
      actor: { ...f.context.actor, subjectId: "foreign" },
    }),
    /unavailable/,
  );
  await f.callback("code=valid");
  const app = await prepare.handler(f.context, {});
  assert.equal(await prepare.verify!(f.context, app), true);
  await assert.rejects(f.github.human(f.context), /unavailable/);
  await install.handler(f.context, { app: app.outputs.app });
  const first = await f.github.human(f.context);
  await install.handler(f.context, { app: app.outputs.app });
  assert.deepEqual(await f.github.human(f.context), first);
  await f.callback("installation_id=7");
  const installed = await install.handler(f.context, { app: app.outputs.app });
  assert.equal(await install.verify!(f.context, installed), true);
  const result = await verify.handler(f.context, {
    installation: installed.outputs.installation,
  });
  assert.equal(result.state, "complete");
  f.behavior.suspended = true;
  await assert.rejects(verify.verify!(f.context, result), /rejected/);
});

test("PRV host configuration rejects unsafe origins and supports authorized explicit target choice", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const options = {
    origin: "http://127.0.0.1:4173",
    environment: "local",
    configurationVersion: "v1",
    authorize: async () => {},
  };
  try {
    for (const origin of [
      "http://example.com",
      "https://example.com/path",
      "https://user:password@example.com",
      "http://localhost:4173",
    ])
      assert.throws(
        () => new AsyncGitHubChildren(store, { ...options, origin }),
        /Invalid/,
      );
    assert.throws(
      () =>
        new AsyncGitHubChildren(store, {
          ...options,
          expectedAccount: "bad/account",
        }),
      /Invalid/,
    );
    const github = new AsyncGitHubChildren(store, options);
    const context: OperationContext = {
      actor: {
        tenantId: "tenant",
        subjectId: "subject",
        sessionId: "session",
        actorKind: "human",
        capabilities: ["executor"],
      },
      runId: "fresh",
      nodeId: "node",
      commandId: "command",
      effectId: "effect",
      target: "chosen-account",
      origin: options.origin,
      environment: "local",
      configurationVersion: "v1",
      signal: new AbortController().signal,
    };
    assert.equal((await github.prepare(context)).state, "awaiting-human");
    await github.cancel({ ...context, runId: "never-started" });
    await assert.rejects(
      github.prepare({ ...context, runId: "never-started" }),
      /cancelled/,
    );
  } finally {
    await store.close();
  }
});

test("AC-33: cancellation while a one-shot conversion is in flight fences its late result", async (t) => {
  const f = await fixture(t);
  await f.github.prepare(f.context);
  const paused = f.pauseConversion();
  const completion = assert.rejects(
    f.callback("code=in-flight"),
    /reconciliation/,
  );
  await paused.waiting;
  await f.github.cancel(f.context);
  paused.release();
  await completion;
  await assert.rejects(f.github.prepare(f.context), /cancelled/);
  assert.equal(f.counters.conversion, 1);
  assert.equal(f.counters.token, 0);
});
