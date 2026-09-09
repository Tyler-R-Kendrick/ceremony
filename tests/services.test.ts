import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  CeremonyController,
  CeremonyDatabase,
  CeremonyEnvironment,
  serviceManifests,
  serviceRegistrations,
  serviceWorkflows,
} from "../src/server/index.js";

function fixture(
  t: TestContext,
  transport: typeof fetch = async () => {
    throw new Error("Unexpected network");
  },
) {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  const env = new CeremonyEnvironment(db);
  t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("External network forbidden");
  });
  const registrations = serviceRegistrations(db, env, { fetch: transport });
  return {
    db,
    env,
    registrations,
    adapter: (index: number, instanceId = "run") =>
      registrations[index]!.createAdapter({
        owner: "alice",
        instanceId,
        method: registrations[index]!.manifest.methods[0]!,
      }),
  };
}

test("characterization: live service manifests, workflows and missing-setup presentation", (t) => {
  const { adapter } = fixture(t);
  t.assert.snapshot(serviceManifests);
  t.assert.snapshot(serviceWorkflows);
  t.assert.snapshot([adapter(0).initial!(), adapter(1).initial!()]);
});

test("atomic: service resume prefers completed work and excludes other services, owners, terminal and expired attempts", (t) => {
  const now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { db, registrations } = fixture(t);
  const controller = new CeremonyController(registrations);
  const source = controller.start("alice", "stripe", "api-key");
  const store = (id: string, step = "input", extra = {}, owner = "alice") =>
    db.put(`instance:${id}`, {
      owner,
      snapshot: { ...source, id, step, ...extra },
    });
  store("other-service", "complete", { connectorId: "supabase" });
  store("other-owner", "complete", {}, "bob");
  for (const step of ["cancelled", "error", "expired"]) store(step, step);
  store("at-expiry", "complete", { expiresAt: now });
  store("past-expiry", "complete", { expiresAt: now - 1 });
  const resume = () => registrations[0]!.resume!("alice", "api-key");
  assert.equal(resume(), undefined);
  store("a-pending");
  assert.equal(resume(), "a-pending");
  // SQLite can return primary-key order; put completed work after pending work.
  store("z-complete", "complete");
  assert.equal(resume(), "z-complete");
  store("zz-pending-after");
  assert.equal(resume(), "z-complete");
  t.mock.method(db, "keys", () => ["instance:disappeared"]);
  assert.equal(resume(), undefined);
});

test("atomic: saved service results expire at the exact boundary and configured project fields are omitted", (t) => {
  const now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { db, env, adapter } = fixture(t);
  const outcome = {
    connectionRef: "saved-reference",
    ownership: "authenticated",
    scopes: [],
  };
  for (const expiresAt of [now - 1, now, now + 1]) {
    db.put("service-result:alice:run", { outcome, expiresAt });
    assert.equal(
      adapter(0).initial!().step,
      expiresAt > now ? "complete" : "input",
    );
  }
  env.update("alice", {
    revision: 0,
    values: {
      SUPABASE_URL: "https://synthetic.supabase.co",
      SUPABASE_ANON_KEY: "legacy-key",
    },
  });
  assert.deepEqual(
    adapter(1, "new").initial!().fields!.map((f) => f.name),
    ["email", "password"],
  );
});

test("atomic: missing credentials and invalid key prefixes never invoke SDK transport", async (t) => {
  let calls = 0;
  const { adapter } = fixture(t, async () => {
    calls++;
    throw new Error("Unexpected transport");
  });
  for (const token of ["", "prefixsk_test_key", "pk_test_key"])
    await assert.rejects(adapter(0).submit({ token }, false), /Stripe/);
  await assert.rejects(adapter(0).begin(), /Stripe/);
  const valid = {
    projectUrl: "https://synthetic.supabase.co",
    publishableKey: "synthetic",
    email: "alice@example.com",
    password: "private",
  };
  for (const field of ["projectUrl", "publishableKey", "email", "password"]) {
    const values: Record<string, string> = { ...valid };
    delete values[field];
    await assert.rejects(adapter(1).submit(values, false), /Supabase/);
  }
  assert.equal(calls, 0);
});

test("chaos: malformed Stripe success cannot persist a connection", async (t) => {
  const { adapter, db } = fixture(t, async () =>
    Response.json({ object: "customer" }),
  );
  await assert.rejects(
    adapter(0).submit({ token: "rk_test_synthetic" }, false),
    /Stripe/,
  );
  assert.deepEqual(db.keys("connection:"), []);
});

test("chaos: malformed and expired Supabase success cannot persist credentials or setup", async (t) => {
  const now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const valid = {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    expires_in: 3600,
    expires_at: now / 1000 + 3600,
    token_type: "bearer",
    user: { id: "synthetic-user" },
  };
  let response: Record<string, unknown> = {};
  const { adapter, db, env } = fixture(t, async () => Response.json(response));
  const bad: Record<string, unknown>[] = [
    { ...valid, expires_at: "invalid-expiry" },
    { ...valid, access_token: 123 },
    { ...valid, refresh_token: 123 },
    { ...valid, expires_at: now / 1000 },
    { ...valid, expires_at: now / 1000 - 1 },
  ];
  for (const field of ["access_token", "refresh_token", "user"]) {
    const value: Record<string, unknown> = { ...valid };
    delete value[field];
    bad.push(value);
  }
  for (const value of bad) {
    response = value;
    await assert.rejects(
      adapter(1).submit(
        {
          projectUrl: "https://synthetic.supabase.co",
          publishableKey: "synthetic-key",
          email: "alice@example.com",
          password: "synthetic-password",
        },
        false,
      ),
      /Supabase/,
    );
    assert.deepEqual(db.keys("connection:"), []);
    assert.deepEqual(env.read("alice"), {});
  }
});

test("behavior: verified Stripe credentials stay private and outcomes do not invent scopes", async (t) => {
  let requests = 0;
  const { adapter, db } = fixture(t, async () => {
    requests++;
    return Response.json({ object: "balance", available: [], pending: [] });
  });
  const completion = adapter(0).submit({ token: "rk_test_synthetic" }, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  const result = await completion;
  assert.equal(result.step, "complete");
  assert.deepEqual(result.outcome!.scopes, []);
  const connection = db.get(
    `connection:${result.outcome!.connectionRef}`,
    z.object({ owner: z.string(), secret: z.object({ token: z.string() }) }),
  )!;
  assert.equal(connection.owner, "alice");
  assert.equal(connection.secret.token, "rk_test_synthetic");
  assert.equal(JSON.stringify(result).includes("synthetic"), false);
});

test("behavior: Supabase session exchange does not start a background refresh loop", async (t) => {
  const interval = globalThis.setInterval;
  const timers: ReturnType<typeof setInterval>[] = [];
  t.mock.method(
    globalThis,
    "setInterval",
    (...args: Parameters<typeof setInterval>) => {
      const timer = interval(...args);
      timers.push(timer);
      return timer;
    },
  );
  t.after(() => timers.forEach(clearInterval));
  const { adapter, env } = fixture(t, async () =>
    Response.json({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_in: 3600,
      token_type: "bearer",
      user: { id: "synthetic-user" },
    }),
  );
  env.update("alice", {
    revision: 0,
    values: {
      SUPABASE_URL: "https://synthetic.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "synthetic-key",
    },
  });
  const result = await adapter(1).submit(
    { email: "alice@example.com", password: "synthetic-password" },
    false,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.step, "complete");
  assert.deepEqual(result.outcome!.scopes, []);
  assert.equal(timers.length, 0);
});
