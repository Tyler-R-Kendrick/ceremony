import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  createHostedRuntime,
  getHostedRuntime,
} from "../src/server/hosted/runtime.js";
import type { RunRecord } from "../src/server/commands.js";
import { hostedHttp } from "../src/server/hosted/http.js";
import { postgresFixture } from "./fixtures/postgres.js";
import { teachingIdentityFixture } from "./fixtures/teaching-identity.js";
import { AsyncCeremonyEnvironment } from "../src/server/async-environment.js";

test("OPS-02 hosted factory fails closed before infrastructure on missing or unsafe configuration", async () => {
  const old = process.env.NODE_ENV,
    profile = process.env.CEREMONY_TEST_PROFILE;
  process.env.NODE_ENV = "production";
  process.env.CEREMONY_TEST_PROFILE = "true";
  try {
    const first = getHostedRuntime(),
      second = getHostedRuntime();
    assert.equal(first, second);
    await assert.rejects(first, /Hosted configuration unavailable/);
    await assert.rejects(
      getHostedRuntime(),
      /Hosted configuration unavailable/,
    );
  } finally {
    if (old === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = old;
    if (profile === undefined) delete process.env.CEREMONY_TEST_PROFILE;
    else process.env.CEREMONY_TEST_PROFILE = profile;
  }
  await assert.rejects(createHostedRuntime({}), /Missing or invalid/);
  await assert.rejects(
    createHostedRuntime({
      CEREMONY_TEST_PROFILE: "true",
      NODE_ENV: "production",
    }),
    /test runtime/,
  );
  const config = {
    CEREMONY_PUBLIC_ORIGIN: "http://remote.example",
    CEREMONY_DATABASE_URL: "unused",
    CEREMONY_VAULT_KEY: randomBytes(32).toString("hex"),
    CEREMONY_VAULT_KEY_ID: "test",
    CEREMONY_OIDC_ISSUER: "https://identity.example",
    CEREMONY_OIDC_CLIENT_ID: "client",
    CEREMONY_TENANT_ID: "tenant",
    CEREMONY_GITHUB_ACCOUNT: "fixture",
    CEREMONY_CONFIGURATION_VERSION: "v1",
  };
  await assert.rejects(
    createHostedRuntime({
      ...config,
      CEREMONY_JIRA_SETUP_OWNER_SUBJECT: "owner\nforged",
    }),
    /Missing or invalid/,
  );
  for (const origin of [
    "http://remote.example",
    "https://app.example/path",
    "https://app.example/",
    "https://user:pass@app.example",
  ])
    await assert.rejects(
      createHostedRuntime({ ...config, CEREMONY_PUBLIC_ORIGIN: origin }),
      /Exact production HTTPS/,
    );
  await assert.rejects(
    createHostedRuntime({
      ...config,
      NODE_ENV: "test",
      CEREMONY_TEST_PROFILE: "true",
    }),
    /Exact production HTTPS/,
  );
  await assert.rejects(
    createHostedRuntime({
      ...config,
      CEREMONY_PUBLIC_ORIGIN: "https://app.example",
    }),
    /Invalid hosted database/,
  );
  for (const database of [
    "https://db.example",
    "postgresql://db.example/db",
    "postgresql://db.example/db?sslmode=disable",
    "postgresql://db.example/db?sslmode=verify-full&sslmode=disable",
  ])
    await assert.rejects(
      createHostedRuntime({
        ...config,
        CEREMONY_PUBLIC_ORIGIN: "https://app.example",
        CEREMONY_DATABASE_URL: database,
      }),
      /verified TLS/,
    );
});

test("OPS-IDN production factory uses actual PostgreSQL and signed OIDC, no anonymous fallback; environment rotation revokes stale delegation", async () => {
  const database = await postgresFixture(),
    provider = await teachingIdentityFixture();
  const origin = "http://127.0.0.1:4198";
  const cfg = database.config;
  const env = {
    NODE_ENV: "test",
    CEREMONY_TEST_PROFILE: "true",
    CEREMONY_PUBLIC_ORIGIN: origin,
    CEREMONY_DATABASE_URL: `postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}`,
    CEREMONY_VAULT_KEY: randomBytes(32).toString("hex"),
    CEREMONY_VAULT_KEY_ID: "test",
    CEREMONY_OIDC_ISSUER: provider.issuer,
    CEREMONY_OIDC_CLIENT_ID: "client",
    CEREMONY_TENANT_ID: "tenant",
    CEREMONY_GITHUB_ACCOUNT: "fixture",
    CEREMONY_CONFIGURATION_VERSION: "v1",
  };
  const runtime = await createHostedRuntime(env);
  try {
    assert.equal(
      await runtime.identity.authenticate(
        new Request(origin, {
          headers: { "x-owner": "admin", "x-tenant": "tenant" },
        }),
      ),
      null,
    );
    const begun = await hostedHttp(
      new Request(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
      }),
      runtime,
      async () => {},
    );
    assert.equal(begun.status, 200);
    const location = (await begun.json()).authorizationUrl;
    const approved = await fetch(location, { redirect: "manual" });
    const callback = await hostedHttp(
      new Request(approved.headers.get("location")!, {
        headers: { cookie: begun.headers.getSetCookie()[0]!.split(";")[0]! },
      }),
      runtime,
      async () => {},
    );
    assert.equal(callback.status, 303);
    const sessionRequest = new Request(origin, {
      headers: { cookie: callback.headers.getSetCookie()[0]!.split(";")[0]! },
    });
    const actor = await runtime.identity.authenticate(sessionRequest);
    assert.ok(actor);
    assert.deepEqual(actor.capabilities, ["executor"]);
    assert.equal(actor.tenantId, "tenant");
    const run = await runtime.connect(actor, "github", false);
    assert.equal(run.status, "active");
    await assert.rejects(
      runtime.commands.snapshot({ ...actor, tenantId: "foreign" }, run.id),
    );
    await assert.rejects(
      runtime.commands.snapshot({ ...actor, subjectId: "foreign" }, run.id),
    );
    await assert.rejects(
      runtime.delegate({ ...actor, capabilities: [] }, run.id),
    );
    await runtime.delegate(actor, run.id);
    assert.equal((await runtime.agentActor(run.id)).subjectId, actor.subjectId);
    const runKey = { tenant: actor.tenantId, kind: "run" as const, id: run.id };
    for (const change of [
      { target: "foreign" },
      { origin: "https://foreign.example" },
      { configurationVersion: "rotated" },
    ]) {
      const saved = await runtime.store.transaction((tx) =>
        tx.get<RunRecord>(runKey),
      );
      assert.ok(saved);
      await runtime.store.transaction((tx) =>
        tx.put(runKey, { ...saved.value, ...change }, saved.revision),
      );
      await assert.rejects(runtime.agentActor(run.id));
      await runtime.store.transaction((tx) =>
        tx.put(runKey, saved.value, saved.revision + 1),
      );
    }
    const environment = new AsyncCeremonyEnvironment(runtime.store);
    await environment.update(actor, {
      revision: 0,
      values: { GITHUB_APP_ID: "123" },
    });
    await assert.rejects(runtime.agentActor(run.id));
    const revised = await environment.describe(actor);
    await environment.update(actor, {
      revision: revised.revision,
      remove: ["GITHUB_APP_ID"],
    });
    await assert.rejects(runtime.agentActor(run.id));
    const fresh = await runtime.connect(actor, "github", false);
    assert.notEqual(fresh.id, run.id);
    assert.equal(provider.tokenCalls, 1);
    await assert.rejects(
      createHostedRuntime({
        ...env,
        CEREMONY_OIDC_ISSUER: `${provider.issuer}/invalid`,
      }),
      /Hosted identity initialization failed/,
    );
    const optional = await createHostedRuntime({
      ...env,
      CEREMONY_OIDC_CLIENT_SECRET: "fixture-only",
      CEREMONY_MODEL: "fixture",
      CEREMONY_MODEL_URL: `${provider.issuer}/chat/completions`,
      CEREMONY_MODEL_KEY: "fixture-only",
      CEREMONY_CONTINUATION_URL: "https://task.example/continue",
      CEREMONY_CONTINUATION_TOKEN: "fixture-".repeat(8),
      CEREMONY_JIRA_SETUP_OWNER_SUBJECT: "designated-owner",
    });
    assert.equal(typeof optional.ownerSetup, "function");
    assert.equal(runtime.ownerSetup, undefined);
    await optional.store.close();
    const gateway = await createHostedRuntime({
      ...env,
      CEREMONY_MODEL: "fixture/model",
      CEREMONY_MODEL_GATEWAY: "true",
    });
    await gateway.store.close();
  } finally {
    await runtime.store.close();
    await provider.close();
    await database.close();
  }
});
