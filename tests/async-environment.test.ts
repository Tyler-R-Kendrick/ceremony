import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  AsyncCeremonyEnvironment,
  resolveGitHubEnvironment,
  resolveSupabaseEnvironment,
} from "../src/server/async-environment.js";
import { CeremonyEnvironment } from "../src/server/environment.js";
import { CeremonyDatabase } from "../src/server/storage.js";
import {
  SQLiteCeremonyStore,
  PostgresCeremonyStore,
} from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { postgresFixture } from "./fixtures/postgres.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};
const keys = { current: "test", keys: { test: randomBytes(32) } };
test("Supabase project configuration versions track shared-session edits without hashing key values", async () => {
  const store = new SQLiteCeremonyStore(":memory:", keys);
  const asyncEnv = new AsyncCeremonyEnvironment(store);
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  const legacy = new CeremonyEnvironment(db);
  try {
    const adapters = [
      {
        resolve: () => asyncEnv.resolveSupabase(actor, "v1"),
        edit: (value: unknown) => asyncEnv.update(actor, value),
      },
      {
        resolve: async () =>
          legacy.supabaseConfiguration("owner", actor.sessionId, "v1"),
        edit: async (value: unknown) => legacy.update("owner", value),
      },
    ];
    for (const env of adapters) {
      const empty = await env.resolve();
      await env.edit({ revision: 0, values: { UNRELATED: "one" } });
      assert.deepEqual(await env.resolve(), empty);
      await env.edit({
        revision: 1,
        values: {
          SUPABASE_URL: "https://synthetic.supabase.co",
          SUPABASE_ANON_KEY: "synthetic-legacy",
        },
      });
      const project = await env.resolve();
      assert.notEqual(project.version, empty.version);
      assert.equal(project.projectUrl, "https://synthetic.supabase.co");
      assert.equal(project.publishableKey === "synthetic-legacy", true);
      await env.edit({ revision: 2, values: { UNRELATED: "two" } });
      assert.deepEqual(await env.resolve(), project);
      await env.edit({
        revision: 3,
        values: { SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable" },
      });
      const rotated = await env.resolve();
      assert.notEqual(rotated.version, project.version);
      assert.equal(rotated.publishableKey === "synthetic-publishable", true);
      await env.edit({
        revision: 4,
        remove: [
          "SUPABASE_PUBLISHABLE_KEY",
          "SUPABASE_ANON_KEY",
          "SUPABASE_URL",
        ],
      });
      const removed = await env.resolve();
      assert.notEqual(removed.version, rotated.version);
      assert.equal(removed.projectUrl, undefined);
      assert.equal(removed.publishableKey, undefined);
    }
    const metadata = { sessionId: "session", revision: 3 };
    const first = resolveSupabaseEnvironment(
      {
        ...metadata,
        values: { SUPABASE_PUBLISHABLE_KEY: "first-private-key" },
      },
      "v1",
    );
    const second = resolveSupabaseEnvironment(
      {
        ...metadata,
        values: { SUPABASE_PUBLISHABLE_KEY: "second-private-key" },
      },
      "v1",
    );
    assert.equal(first.version, second.version);
    for (const change of [{ sessionId: "other" }, { revision: 4 }])
      assert.notEqual(
        resolveSupabaseEnvironment({ ...metadata, ...change, values: {} }, "v1")
          .version,
        first.version,
      );
    assert.notEqual(
      resolveSupabaseEnvironment({ ...metadata, values: {} }, "v2").version,
      first.version,
    );
  } finally {
    await store.close();
    db.close();
  }
});
test("Stripe configuration revision changes only for its key and never includes a key-derived digest", async () => {
  const store = new SQLiteCeremonyStore(":memory:", keys);
  const env = new AsyncCeremonyEnvironment(store);
  try {
    const initial = await env.resolveStripe(actor, "v1");
    await env.update(actor, { revision: 0, values: { UNRELATED: "value" } });
    assert.deepEqual(await env.resolveStripe(actor, "v1"), initial);
    await env.update(actor, {
      revision: 1,
      values: { STRIPE_SECRET_KEY: "synthetic-key" },
    });
    const configured = await env.resolveStripe(actor, "v1");
    assert.notEqual(configured.version, initial.version);
    assert.equal(configured.token, "synthetic-key");
    await env.update(actor, { revision: 2, values: { UNRELATED: "changed" } });
    assert.deepEqual(await env.resolveStripe(actor, "v1"), configured);
    await env.update(actor, { revision: 3, remove: ["STRIPE_SECRET_KEY"] });
    const removed = await env.resolveStripe(actor, "v1");
    assert.notEqual(removed.version, configured.version);
    assert.equal(removed.token, undefined);
    assert.notEqual(
      (await env.resolveStripe({ ...actor, sessionId: "other" }, "v1")).version,
      initial.version,
    );
  } finally {
    await store.close();
  }
});
test("AC-20: asynchronous native Environment is session-scoped, encrypted and names-only", async () => {
  const store = new SQLiteCeremonyStore(":memory:", keys);
  const env = new AsyncCeremonyEnvironment(store);
  try {
    assert.deepEqual(await env.describe(actor), { revision: 0, names: [] });
    const result = await env.update(actor, {
      revision: 0,
      dotenv: 'SHARED_TOKEN="synthetic-private-token"\nSECOND=two',
      values: { THIRD: "three" },
    });
    assert.deepEqual(result, {
      revision: 1,
      names: ["SECOND", "SHARED_TOKEN", "THIRD"],
    });
    assert.equal(
      JSON.stringify(result).includes("synthetic-private-token"),
      false,
    );
    assert.equal(
      (await env.read(actor)).values.SHARED_TOKEN === "synthetic-private-token",
      true,
    );
    for (const changes of [
      { tenantId: "other" },
      { subjectId: "other" },
      { sessionId: "other" },
    ])
      assert.deepEqual(await env.describe({ ...actor, ...changes }), {
        revision: 0,
        names: [],
      });
    await assert.rejects(
      env.update(actor, { revision: 0, values: { SECOND: "changed" } }),
      /conflict/,
    );
    assert.deepEqual(
      await env.update(actor, { revision: 1, remove: ["SECOND"] }),
      { revision: 2, names: ["SHARED_TOKEN", "THIRD"] },
    );
    await assert.rejects(
      env.update({ ...actor, actorKind: "agent" }, { revision: 2, values: {} }),
      /denied/,
    );
    await assert.rejects(
      env.describe({ ...actor, capabilities: [] }),
      /denied/,
    );
  } finally {
    await store.close();
  }
});
test("AC-22/26: Environment rejects malformed or oversized input without reflecting protected values", async () => {
  const store = new SQLiteCeremonyStore(":memory:", keys);
  const env = new AsyncCeremonyEnvironment(store);
  try {
    for (const input of [
      { revision: 0, values: { "bad-name": "private" } },
      { revision: 0, dotenv: "# no assignments" },
      { revision: 0, values: { KEY: "x".repeat(16385) } },
      { revision: 0, owner: "foreign" },
      {
        revision: 0,
        values: Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`KEY_${i}`, "x"]),
        ),
      },
      {
        revision: 0,
        values: {
          A: "x".repeat(16000),
          B: "x".repeat(16000),
          C: "x".repeat(16000),
          D: "x".repeat(16000),
        },
      },
    ])
      await assert.rejects(
        env.update(actor, input),
        (error) =>
          error instanceof Error && error.message === "invalid_request",
      );
    assert.deepEqual(await env.describe(actor), { revision: 0, names: [] });
  } finally {
    await store.close();
  }
});
test("AC-36: GitHub setup resolves shared private environment and binds metadata revision/session", async () => {
  assert.equal(
    resolveGitHubEnvironment(
      { revision: 0, sessionId: "first", values: {} },
      "v1",
    ).configurationVersion,
    "v1",
  );
  assert.equal(
    resolveGitHubEnvironment(
      { revision: 0, sessionId: "second", values: {} },
      "v1",
    ).configurationVersion,
    "v1",
  );
  assert.notEqual(
    resolveGitHubEnvironment(
      { revision: 1, sessionId: "first", values: {} },
      "v1",
    ).configurationVersion,
    "v1",
  );
  const values = {
    GITHUB_APP_ID: "42",
    GITHUB_APP_SLUG: "fixture",
    GITHUB_APP_OWNER: "owner",
    GITHUB_APP_PRIVATE_KEY: "synthetic-pem",
  };
  const one = resolveGitHubEnvironment(
    { revision: 1, sessionId: "session", values },
    "v1",
  );
  assert.equal(one.app?.id, 42);
  assert.equal(one.app?.pem === values.GITHUB_APP_PRIVATE_KEY, true);
  assert.notEqual(
    resolveGitHubEnvironment(
      { revision: 2, sessionId: "session", values },
      "v1",
    ).configurationVersion,
    one.configurationVersion,
  );
  assert.notEqual(
    resolveGitHubEnvironment({ revision: 1, sessionId: "other", values }, "v1")
      .configurationVersion,
    one.configurationVersion,
  );
  assert.notEqual(
    resolveGitHubEnvironment(
      { revision: 1, sessionId: "session", values },
      "v2",
    ).configurationVersion,
    one.configurationVersion,
  );
  assert.equal(
    resolveGitHubEnvironment(
      { revision: 1, sessionId: "session", values: {} },
      "v1",
    ).app,
    undefined,
  );
  assert.throws(
    () =>
      resolveGitHubEnvironment(
        { revision: 1, sessionId: "session", values: { GITHUB_APP_ID: "42" } },
        "v1",
      ),
    /incomplete-github-configuration/,
  );
  assert.throws(
    () =>
      resolveGitHubEnvironment(
        {
          revision: 1,
          sessionId: "session",
          values: { ...values, GITHUB_APP_ID: "invalid" },
        },
        "v1",
      ),
    /invalid_request/,
  );
});
test("AC-27: independent PostgreSQL Environment edits enforce revision CAS", async () => {
  const fixture = await postgresFixture();
  const a = new PostgresCeremonyStore(fixture.config, keys);
  const b = new PostgresCeremonyStore(fixture.config, keys);
  try {
    await a.migrate();
    const first = new AsyncCeremonyEnvironment(a),
      second = new AsyncCeremonyEnvironment(b);
    const results = await Promise.allSettled([
      first.update(actor, { revision: 0, values: { A: "first" } }),
      second.update(actor, { revision: 0, values: { A: "second" } }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.equal((await first.describe(actor)).revision, 1);
    assert.ok((await first.resolveGitHub(actor, "v1")).configurationVersion);
  } finally {
    await a.close();
    await b.close();
    await fixture.close();
  }
});

test("AC-36: unrelated session edits preserve GitHub configuration while key rotation invalidates it", async () => {
  const store = new SQLiteCeremonyStore(":memory:", keys);
  const env = new AsyncCeremonyEnvironment(store);
  try {
    await env.update(actor, {
      revision: 0,
      values: { STRIPE_KEY: "synthetic" },
    });
    assert.equal(
      (await env.resolveGitHub(actor, "v1")).configurationVersion,
      "v1",
    );
    await env.update(actor, {
      revision: 1,
      values: {
        GITHUB_APP_ID: "42",
        GITHUB_APP_SLUG: "fixture",
        GITHUB_APP_OWNER: "owner",
        GITHUB_APP_PRIVATE_KEY: "synthetic-pem",
      },
    });
    const before = (await env.resolveGitHub(actor, "v1")).configurationVersion;
    await env.update(actor, { revision: 2, values: { STRIPE_KEY: "changed" } });
    assert.equal(
      (await env.resolveGitHub(actor, "v1")).configurationVersion,
      before,
    );
    await env.update(actor, {
      revision: 3,
      values: { GITHUB_APP_PRIVATE_KEY: "rotated-pem" },
    });
    assert.notEqual(
      (await env.resolveGitHub(actor, "v1")).configurationVersion,
      before,
    );
    await env.update(actor, {
      revision: 4,
      remove: [
        "GITHUB_APP_ID",
        "GITHUB_APP_SLUG",
        "GITHUB_APP_OWNER",
        "GITHUB_APP_PRIVATE_KEY",
      ],
    });
    assert.notEqual(
      (await env.resolveGitHub(actor, "v1")).configurationVersion,
      "v1",
    );
  } finally {
    await store.close();
  }
});
