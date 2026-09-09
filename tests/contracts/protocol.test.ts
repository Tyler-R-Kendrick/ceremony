import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PactV3, Matchers, SpecificationVersion } from "@pact-foundation/pact";
import {
  createProtocolAdapter,
  MemoryCredentialStore,
  type ProtocolConfig,
} from "../../src/server/adapters.js";
import { createNeonAdapter } from "../../src/server/neon.js";
import { manifests } from "../../examples/manifests.js";

function contract(t: TestContext, provider: string) {
  const dir = mkdtempSync(join(tmpdir(), "ceremony-protocol-pact-"));
  t.after(() => rmSync(dir, { recursive: true }));
  // Pact's fluent V4 withCompleteRequest is unimplemented in 17.1.4.
  // The supported V3 builder still emits V4 contracts and accepts text bodies.
  return new PactV3({
    spec: SpecificationVersion.SPECIFICATION_VERSION_V4,
    consumer: "ceremony-auth",
    provider,
    dir,
    logLevel: "error",
  });
}
function config(origin: string): ProtocolConfig {
  return {
    issuer: origin,
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    deviceEndpoint: `${origin}/device`,
    resource: `${origin}/resource`,
    clientId: "ceremony",
    callbackUrl: "https://ceremony.example/callback",
    credentialEndpoint: `${origin}/credentials`,
    identityEndpoint: `${origin}/identity`,
    claimEndpoint: `${origin}/claim`,
    allowLoopbackHttp: true,
  };
}
for (const kind of ["basic", "api-key", "form"] as const) {
  for (const status of [200, 401])
    test(`Pact: configured ${kind} backend returns ${status}`, async (t) => {
      const pact = contract(t, "configured-auth-backend");
      const method = manifests
        .flatMap((m) => m.methods)
        .find((m) => m.kind === kind)!;
      const values = Object.fromEntries(
        method.fields.map((field) => [
          field.name,
          field.name === "email" ? "alice@example.test" : "synthetic",
        ]),
      );
      await pact
        .given(
          `the ${kind} credentials are ${status === 200 ? "accepted" : "rejected"}`,
        )
        .uponReceiving(`authenticate using ${kind}`)
        .withRequest({
          method: "POST",
          path: "/credentials",
          ...(kind === "form"
            ? {
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams(values).toString(),
              }
            : {
                headers: {
                  authorization:
                    kind === "basic"
                      ? `Basic ${Buffer.from("synthetic:synthetic").toString("base64")}`
                      : "Bearer synthetic",
                },
              }),
        })
        .willRespondWith({
          status,
          headers: { "content-type": "application/json" },
          body:
            status === 200
              ? {
                  access_token: "synthetic-token",
                  token_type: "Bearer",
                  scope: "read",
                }
              : { error: "invalid_credentials" },
        })
        .executeTest(async ({ url }) => {
          const store = new MemoryCredentialStore();
          const adapter = createProtocolAdapter(method, config(url), store);
          assert.equal((await adapter.begin()).step, "input");
          if (status === 401)
            await assert.rejects(
              adapter.submit(values, false),
              /credentials were rejected/,
            );
          else {
            const result = await adapter.submit(values, false);
            assert.equal(result.step, "complete");
            assert.ok(result.outcome?.connectionRef);
            assert.ok(store.get(result.outcome.connectionRef));
            assert.doesNotMatch(JSON.stringify(result), /synthetic/);
          }
        });
    });
}
test("Pact: device authorization waits for its interval then exchanges the device code", async (t) => {
  const pact = contract(t, "oauth-device-provider");
  const method = manifests[0]!.methods.find(
    (method) => method.kind === "device",
  )!;
  pact
    .given("the client may initiate device authorization")
    .uponReceiving("create a device approval")
    .withRequest({
      method: "POST",
      path: "/device",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        scope: method.scopes.join(" "),
        client_id: "ceremony",
      }).toString(),
    })
    .willRespondWith({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        device_code: "synthetic-device",
        user_code: "ABCD",
        verification_uri: "https://provider.example/verify",
        expires_in: 600,
        interval: 1,
      },
    });
  await pact
    .given("the device approval has completed")
    .uponReceiving("exchange the approved device code")
    .withRequest({
      method: "POST",
      path: "/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "synthetic-device",
        client_id: "ceremony",
      }).toString(),
    })
    .willRespondWith({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        access_token: "synthetic-token",
        token_type: "Bearer",
        scope: "read:user",
      },
    })
    .executeTest(async ({ url }) => {
      const originalFetch = globalThis.fetch;
      t.mock.method(
        globalThis,
        "fetch",
        (input: string | URL | Request, init?: RequestInit) => {
          const source = new URL(String(input));
          assert.equal(source.origin, "https://provider.example");
          return originalFetch(
            `${url}${source.pathname}${source.search}`,
            init,
          );
        },
      );
      let now = 0;
      const adapter = createProtocolAdapter(
        method,
        config("https://provider.example"),
        new MemoryCredentialStore(),
        () => now,
      );
      assert.equal((await adapter.begin()).step, "waiting");
      assert.equal(await adapter.poll(), undefined);
      now = 1000;
      assert.equal((await adapter.poll())?.step, "complete");
    });
});
test("Pact: Neon anonymous registration exchanges its assertion before granting access", async (t) => {
  const pact = contract(t, "neon-claimable");
  pact
    .given("anonymous postgres registration is available")
    .uponReceiving("create an anonymous project identity")
    .withRequest({
      method: "POST",
      path: "/v1/agent/identity",
      headers: { "content-type": "application/json" },
      body: {
        type: "anonymous",
        capabilities: ["postgres"],
        source: "ceremony",
      },
    })
    .willRespondWith({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        identity_assertion: "synthetic-assertion",
        project: {
          id: "project-1",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      },
    });
  await pact
    .given("the anonymous assertion is valid")
    .uponReceiving("exchange anonymous identity for an access token")
    .withRequest({
      method: "POST",
      path: "/v1/oauth2/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=synthetic-assertion&resource=https%3A%2F%2Fclaimable.neon.tech%2F",
    })
    .willRespondWith({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        access_token: Matchers.like("synthetic-token"),
        token_type: "Bearer",
      },
    })
    .executeTest(async ({ url }) => {
      const originalFetch = globalThis.fetch;
      t.mock.method(
        globalThis,
        "fetch",
        (input: string | URL | Request, init?: RequestInit) => {
          const source = new URL(String(input));
          assert.equal(source.origin, "https://claimable.neon.tech");
          return originalFetch(
            `${url}${source.pathname}${source.search}`,
            init,
          );
        },
      );
      const result = await createNeonAdapter(
        new MemoryCredentialStore(),
      ).begin();
      assert.equal(result.step, "anonymous");
      assert.equal(result.outcome?.ownership, "anonymous");
      assert.doesNotMatch(JSON.stringify(result), /synthetic/);
    });
});
