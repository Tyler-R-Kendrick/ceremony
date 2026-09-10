import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PactV3, SpecificationVersion } from "@pact-foundation/pact";
import { z } from "zod";
import {
  CeremonyController,
  CeremonyDatabase,
  CeremonyEnvironment,
  PrivateCredentialBroker,
  serviceRegistrations,
} from "../../src/server/index.js";

function fixture(t: TestContext, provider: string) {
  const network = globalThis.fetch;
  // Mutation runs must never turn a missing injected transport into a live request.
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new URL(String(input)).hostname, "127.0.0.1");
      return network(input, init);
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "ceremony-services-pact-"));
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  const env = new CeremonyEnvironment(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });
  const pact = new PactV3({
    consumer: "ceremony-services",
    provider,
    dir,
    logLevel: "error",
    spec: SpecificationVersion.SPECIFICATION_VERSION_V4,
  });
  const events: string[] = [];
  const consumer = (url: string, origin: string) =>
    serviceRegistrations(db, env, {
      fetch: (input, init) => {
        const source = new URL(String(input));
        assert.equal(source.origin, origin);
        assert.equal(init?.redirect, "error");
        return fetch(`${url}${source.pathname}${source.search}`, init);
      },
      onStep: (event) => {
        events.push(event.status);
        assert.equal(JSON.stringify(event).includes("synthetic"), false);
      },
    });
  return { pact, db, env, consumer, events };
}
for (const status of [200, 401]) {
  test(`Pact: Supabase rejects ${status === 200 ? "mismatched" : "revoked"} issued session evidence`, async (t) => {
    const { pact, db, env, consumer, events } = fixture(t, "supabase-auth");
    pact
      .given("the project user has valid credentials")
      .uponReceiving("password grant before fresh user verification")
      .withRequest({
        method: "POST",
        path: "/auth/v1/token",
        query: { grant_type: "password" },
        headers: { apikey: "sb_publishable_synthetic" },
        body: {
          email: "alice@example.com",
          password: "synthetic-password",
          gotrue_meta_security: {},
        },
      })
      .willRespondWith({
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_type: "bearer",
          expires_in: 3600,
          user: { id: "synthetic-user" },
        },
      });
    pact
      .given(
        status === 200
          ? "the issued session identifies a different user"
          : "the issued session has been revoked",
      )
      .uponReceiving("fresh verification rejects the issued project session")
      .withRequest({
        method: "GET",
        path: "/auth/v1/user",
        headers: {
          apikey: "sb_publishable_synthetic",
          authorization: "Bearer synthetic-access",
        },
      })
      .willRespondWith({
        status,
        headers: { "content-type": "application/json" },
        body:
          status === 200
            ? { id: "different-user" }
            : { message: "synthetic private provider detail" },
      });
    await pact.executeTest(async ({ url }) => {
      const registration = consumer(url, "https://synthetic.supabase.co")[1]!;
      const adapter = registration.createAdapter({
        owner: "alice",
        instanceId: "verification-failure",
        method: registration.manifest.methods[0]!,
      });
      await assert.rejects(
        adapter.submit(
          {
            projectUrl: "https://synthetic.supabase.co",
            publishableKey: "sb_publishable_synthetic",
            email: "alice@example.com",
            password: "synthetic-password",
          },
          false,
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith("Supabase") &&
          !error.message.includes("private provider"),
      );
      assert.deepEqual(db.keys("connection:"), []);
      assert.deepEqual(db.keys("service-result:"), []);
      assert.deepEqual(env.read("alice"), {});
      assert.deepEqual(events, ["success", "failure"]);
    });
  });
}
for (const accepted of [true, false]) {
  test(`Pact: Stripe SDK ${accepted ? "verifies and resumes private access" : "rejects invalid credentials"}`, async (t) => {
    const { pact, db, env, consumer, events } = fixture(t, "stripe-rest");
    pact
      .given(
        accepted ? "the key has balance read permission" : "the key is invalid",
      )
      .uponReceiving("read balance with the secret key")
      .withRequest({
        method: "GET",
        path: "/v1/balance",
        headers: { authorization: "Bearer sk_test_synthetic" },
      })
      .willRespondWith({
        status: accepted ? 200 : 401,
        headers: { "content-type": "application/json" },
        body: accepted
          ? { object: "balance", available: [], pending: [], livemode: false }
          : {
              error: {
                type: "invalid_request_error",
                message: "synthetic private provider detail",
              },
            },
      });
    await pact.executeTest(async ({ url }) => {
      env.update("alice", {
        revision: 0,
        values: { STRIPE_SECRET_KEY: "sk_test_synthetic" },
      });
      const registrations = consumer(url, "https://api.stripe.com");
      const makeController = () =>
        new CeremonyController(registrations, new Map(), Date.now, {
          database: db,
          broker: new PrivateCredentialBroker(db),
        });
      const controller = makeController();
      const start = controller.connect("alice", "stripe");
      assert.equal(start.step, "intro");
      assert.deepEqual(start.fields, []);
      const done = await controller.act("alice", start.id, {
        action: "begin",
        revision: start.revision,
      });
      assert.equal(done.step, accepted ? "complete" : "error");
      assert.equal(JSON.stringify(done).includes("synthetic"), false);
      assert.deepEqual(events, [accepted ? "success" : "failure"]);
      if (accepted) {
        const resumed = makeController().connect("alice", "stripe");
        assert.equal(resumed.id, done.id);
        assert.equal(resumed.step, "complete");
        assert.equal(makeController().connect("bob", "stripe").step, "input");
      } else {
        const retry = await controller.act("alice", done.id, {
          action: "retry",
          revision: done.revision,
        });
        assert.deepEqual(
          retry.fields.map((field) => field.name),
          ["token"],
        );
        assert.equal(db.keys("connection:").length, 0);
      }
    });
  });
  test(`Pact: Supabase SDK ${accepted ? "signs in and reuses inline project setup" : "rejects invalid credentials"}`, async (t) => {
    const { pact, db, env, consumer, events } = fixture(t, "supabase-auth");
    pact
      .given(
        accepted
          ? "the project user has valid credentials"
          : "the project user has invalid credentials",
      )
      .uponReceiving("password grant for an existing project user")
      .withRequest({
        method: "POST",
        path: "/auth/v1/token",
        query: { grant_type: "password" },
        headers: {
          apikey: "sb_publishable_synthetic",
          "content-type": "application/json;charset=UTF-8",
        },
        body: {
          email: "alice@example.com",
          password: "synthetic-password",
          gotrue_meta_security: {},
        },
      })
      .willRespondWith({
        status: accepted ? 200 : 400,
        headers: { "content-type": "application/json" },
        body: accepted
          ? {
              access_token: "synthetic-access",
              refresh_token: "synthetic-refresh",
              token_type: "bearer",
              expires_in: 3600,
              user: { id: "synthetic-user", email: "alice@example.com" },
            }
          : {
              error_code: "invalid_credentials",
              msg: "synthetic private provider detail",
            },
      });
    if (accepted)
      pact
        .given("the issued session identifies the project user")
        .uponReceiving("fresh verification of the issued project session")
        .withRequest({
          method: "GET",
          path: "/auth/v1/user",
          headers: {
            apikey: "sb_publishable_synthetic",
            authorization: "Bearer synthetic-access",
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "content-type": "application/json" },
          body: { id: "synthetic-user", email: "alice@example.com" },
        });
    await pact.executeTest(async ({ url }) => {
      const registration = consumer(url, "https://synthetic.supabase.co")[1]!;
      const context = {
        owner: "alice",
        instanceId: "supabase-run",
        method: registration.manifest.methods[0]!,
      };
      const adapter = registration.createAdapter(context);
      assert.deepEqual(
        adapter.initial!().fields!.map((f) => f.name),
        ["projectUrl", "publishableKey", "email", "password"],
      );
      const result = adapter.submit(
        {
          projectUrl: "https://synthetic.supabase.co",
          publishableKey: "sb_publishable_synthetic",
          email: "alice@example.com",
          password: "synthetic-password",
        },
        false,
      );
      if (accepted) {
        const done = await result;
        assert.equal(done.step, "complete");
        assert.equal(JSON.stringify(done).includes("synthetic"), false);
        assert.equal(
          env.read("alice").SUPABASE_URL,
          "https://synthetic.supabase.co",
        );
        assert.equal(
          JSON.stringify(env.read("alice")).includes("synthetic-password"),
          false,
        );
        assert.equal(
          registration.createAdapter(context).initial!().step,
          "complete",
        );
        assert.deepEqual(
          registration.createAdapter({ ...context, instanceId: "next" })
            .initial!().fields!.map((f) => f.name),
          ["email", "password"],
        );
        const stored = db.get(
          `connection:${done.outcome!.connectionRef}`,
          z.object({
            owner: z.string(),
            secret: z.record(z.string(), z.unknown()),
          }),
        )!;
        assert.equal(stored.owner, "alice");
        assert.equal(stored.secret.access_token, "synthetic-access");
        assert.equal(stored.secret.password, undefined);
      } else {
        await assert.rejects(
          result,
          (error: Error) =>
            !error.message.includes("synthetic") &&
            error.message.includes("Supabase"),
        );
        assert.deepEqual(env.read("alice"), {});
        assert.equal(db.keys("connection:").length, 0);
      }
      assert.deepEqual(events, accepted ? ["success", "success"] : ["failure"]);
    });
  });
}

test("service inputs reject unsafe origins and malformed keys before any network request", async (t) => {
  const { db, env } = fixture(t, "unused");
  let calls = 0;
  const registrations = serviceRegistrations(db, env, {
    fetch: async () => {
      calls++;
      throw new Error("Unexpected network call");
    },
  });
  for (const projectUrl of [
    "http://localhost",
    "http://synthetic.supabase.co",
    "https://127.0.0.1",
    "https://evil.example",
    "https://evil.synthetic.supabase.co",
    "https://x.supabase.co.evil.example",
    "https://u:p@x.supabase.co",
    "https://x.supabase.co:444",
    "https://x.supabase.co/path",
    "https://x.supabase.co?q=1",
    "https://x.supabase.co#fragment",
  ]) {
    const registration = registrations[1]!;
    const adapter = registration.createAdapter({
      owner: "alice",
      instanceId: "guard",
      method: registration.manifest.methods[0]!,
    });
    await assert.rejects(
      adapter.submit(
        {
          projectUrl,
          publishableKey: "synthetic",
          email: "alice@example.com",
          password: "private",
        },
        false,
      ),
      /Supabase/,
    );
  }
  const stripe = registrations[0]!;
  const adapter = stripe.createAdapter({
    owner: "alice",
    instanceId: "stripe",
    method: stripe.manifest.methods[0]!,
  });
  await assert.rejects(
    adapter.submit({ token: "demo-api-key" }, false),
    /Stripe/,
  );
  await assert.rejects(
    adapter.callback(new URL("https://example.com")),
    /callback/,
  );
  assert.equal(await adapter.poll(), undefined);
  adapter.cancel();
  assert.equal(calls, 0);
});
