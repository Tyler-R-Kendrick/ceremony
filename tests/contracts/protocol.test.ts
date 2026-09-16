import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPair } from "jose";
import { PactV3, Matchers, SpecificationVersion } from "@pact-foundation/pact";
import {
  createProtocolAdapter,
  MemoryCredentialStore,
  type ProtocolConfig,
} from "../../src/server/adapters.js";
import { createNeonAdapter } from "../../src/server/neon.js";
import { manifests } from "../../examples/manifests.js";
import { Agent2Human } from "../../src/server/a2h.js";
import { CeremonyDatabase } from "../../src/server/storage.js";
import { effectAuthorizationDigest } from "../../src/server/authorization.js";

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

test("Pact: OAuth callback exchanges its code with the original PKCE verifier", async (t) => {
  const pact = contract(t, "oauth-code-provider");
  const method = manifests[0]!.methods.find(
    (method) => method.kind === "oauth-code",
  )!;
  const body = new URLSearchParams({
    redirect_uri: "https://ceremony.example/callback",
    code: "synthetic-code",
    code_verifier: "a".repeat(43),
    grant_type: "authorization_code",
    client_id: "ceremony",
  }).toString();
  await pact
    .given(
      "the authorization code is approved for this client and redirect URI",
    )
    .uponReceiving("exchange the code using PKCE")
    .withRequestMatchingRules(
      {
        method: "POST",
        path: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      {
        body: {
          path: "$.code_verifier",
          rules: [Matchers.regex("^[A-Za-z0-9_-]{43,128}$", "a".repeat(43))],
        },
      },
    )
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
      let challenge = "";
      t.mock.method(
        globalThis,
        "fetch",
        (input: string | URL | Request, init?: RequestInit) => {
          const source = new URL(String(input));
          assert.equal(source.origin, "https://provider.example");
          const verifier = new URLSearchParams(String(init?.body)).get(
            "code_verifier",
          )!;
          assert.equal(
            createHash("sha256").update(verifier).digest("base64url"),
            challenge,
          );
          return originalFetch(
            `${url}${source.pathname}${source.search}`,
            init,
          );
        },
      );
      const adapter = createProtocolAdapter(
        method,
        config("https://provider.example"),
        new MemoryCredentialStore(),
      );
      const authorization = new URL((await adapter.begin()).authorizationUrl!);
      challenge = authorization.searchParams.get("code_challenge")!;
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      const callback = new URL("https://ceremony.example/callback");
      callback.search = new URLSearchParams({
        state: authorization.searchParams.get("state")!,
        code: "synthetic-code",
      }).toString();
      assert.equal((await adapter.callback(callback)).step, "complete");
      await assert.rejects(adapter.callback(callback), /no longer valid/);
    });
});

test("Pact: A2H gateway authentication failure cannot create a pending human request", async (t) => {
  const pact = contract(t, "a2h-gateway");
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const pair = await generateKeyPair("EdDSA");
  await pact
    .given("the gateway rejects the agent API key")
    .uponReceiving("discover the gateway with agent authentication")
    .withRequest({
      method: "GET",
      path: "/.well-known/a2h",
      headers: {
        "x-a2h-api-key": "synthetic-key",
        "content-type": "application/json",
      },
    })
    .willRespondWith({ status: 401 })
    .executeTest(async ({ url }) => {
      const agent = new Agent2Human(db, {
        gatewayOrigin: "https://gateway.example",
        agentId: "agent",
        keyId: "key",
        privateKey: pair.privateKey,
        gatewayKey: pair.publicKey,
        apiKey: "synthetic-key",
        recipient: () => ({
          principalId: "alice",
          type: "email",
          address: "mailto:alice@example.test",
        }),
        fetch: (input, init) => {
          const source = new URL(String(input));
          assert.equal(source.origin, "https://gateway.example");
          return fetch(`${url}${source.pathname}`, init);
        },
      });
      await assert.rejects(
        agent.authorize("alice", "run", "https://ceremony.example/human/run"),
        /delivery failed/,
      );
      assert.equal(db.keys("a2h:").length, 0);
    });
});
for (const status of [200, 503]) {
  test(`Pact: generic A2H delivery ${status} cannot accept an uncorrelated acknowledgement`, async (t) => {
    const pact = contract(t, "a2h-gateway");
    const db = new CeremonyDatabase(":memory:", randomBytes(32));
    t.after(() => db.close());
    const pair = await generateKeyPair("EdDSA");
    const effect = {
      tenantId: "tenant",
      subjectId: "alice",
      runId: "run",
      operationId: "jira.prepare-app",
      operationVersion: "1.0.0",
      target: "https://workspace.atlassian.net",
      configurationVersion: "v1",
      scopes: ["read:jira-user"],
      argumentsDigest: "a".repeat(64),
    };
    const headers = {
      "x-a2h-api-key": "synthetic-key",
      "content-type": "application/json",
    };
    pact
      .given("the gateway supports signed email authorization")
      .uponReceiving("discover generic ceremony authorization support")
      .withRequest({ method: "GET", path: "/.well-known/a2h", headers })
      .willRespondWith({
        status: 200,
        body: {
          a2h_supported: ["1.0"],
          channels: ["email"],
          max_ttl_sec: 600,
          auth: { methods: ["api_key"] },
        },
      });
    pact
      .given(
        status === 503
          ? "intent delivery is temporarily unavailable"
          : "the gateway returns an unrelated acknowledgement",
      )
      .uponReceiving("authorize the exact Jira app registration effect")
      .withRequest({
        method: "POST",
        path: "/v1/intent",
        headers,
        body: {
          a2h_version: "1.0",
          a2h_min_version: "1.0",
          type: "AUTHORIZE",
          agent_id: "agent",
          principal_id: "alice",
          ttl_sec: 600,
          interaction_id: Matchers.uuid(),
          message_id: Matchers.uuid(),
          created_at: Matchers.iso8601DateTimeWithMillis(),
          channel: {
            type: "email",
            address: "mailto:alice@example.test",
            nonce: Matchers.regex("^[A-Za-z0-9_-]{32}$", "a".repeat(32)),
            expires_at: Matchers.iso8601DateTimeWithMillis(),
            render: {
              title: "Jira needs your participation",
              body: "Review the app registration step for Jira in your authenticated ceremony: https://ceremony.example/human/run. Approval here does not replace provider consent or access verification. Enter credentials only in the private collector, never in your reply.",
            },
          },
          params: {
            purpose: "app-registration",
            connector_id: "jira",
            connector_name: "Jira",
            effect_digest: effectAuthorizationDigest(effect),
          },
          signature: Matchers.regex(
            "^[A-Za-z0-9_-]+\\.\\.[A-Za-z0-9_-]+$",
            "header..signature",
          ),
        },
      })
      .willRespondWith({
        status,
        ...(status === 200 ? { body: { interaction_id: "unrelated" } } : {}),
      });
    await pact.executeTest(async ({ url }) => {
      const agent = new Agent2Human(db, {
        gatewayOrigin: "https://gateway.example",
        agentId: "agent",
        keyId: "key",
        privateKey: pair.privateKey,
        gatewayKey: pair.publicKey,
        apiKey: "synthetic-key",
        recipient: () => ({
          principalId: "alice",
          type: "email",
          address: "mailto:alice@example.test",
        }),
        fetch: (input, init) => {
          const source = new URL(String(input));
          assert.equal(source.origin, "https://gateway.example");
          return fetch(`${url}${source.pathname}`, init);
        },
      });
      await assert.rejects(
        agent.authorize("alice", "run", "https://ceremony.example/human/run", {
          connectorId: "jira",
          connectorName: "Jira",
          purpose: "app-registration",
          effect,
        }),
        status === 200 ? /correlation failed/ : /delivery failed/,
      );
      assert.equal(db.keys("a2h-ceremony:").length, 1);
      assert.equal(db.keys("a2h:").length, 0);
    });
  });
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
