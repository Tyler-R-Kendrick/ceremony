import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  beginAuthorization,
  clientMetadataDocument,
} from "../src/server/authored-oauth.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/registry.js";
import {
  authoredVocabulary,
  registerAuthoredOperations,
  saveAuthoredAccountIntent,
} from "../src/server/authored-operations.js";

const provider = "https://provider.example";
const origin = "https://ceremony.example";
test("public client metadata does not require DPoP without a selected policy", () => {
  assert.equal(
    clientMetadataDocument({
      clientId: "fixture-client",
      redirectUri: `${origin}/return`,
      scope: "openid",
      name: "Fixture",
    }).dpop_bound_access_tokens,
    false,
  );
});
for (const required of [false, true])
  test(`missing PAR metadata respects policy without opting into DPoP (required: ${required})`, async () => {
    const discovery = {
      origin: provider,
      authorizationEndpoint: `${provider}/authorize`,
      tokenEndpoint: `${provider}/token`,
      requirePushedAuthorizationRequests: required,
    };
    const starting = beginAuthorization({
      discovery,
      clientId: "fixture-client",
      redirectUri: `${origin}/return`,
      scope: "openid",
    });
    if (required) await assert.rejects(starting);
    else {
      const result = await starting;
      assert.equal(Boolean(result.dpopJwk), false);
      assert.equal(
        new URL(result.location).searchParams.get("code_challenge_method"),
        "S256",
      );
    }
  });

for (const required of [false, true])
  for (const fault of ["missing", "503", "disconnect"] as const)
    test(`authorization starter preserves PAR policy (${required ? "required" : "optional"}, ${fault})`, async () => {
      let calls = 0;
      const discovery = {
        origin: provider,
        authorizationEndpoint: `${provider}/authorize`,
        tokenEndpoint: `${provider}/token`,
        ...(fault === "missing"
          ? {}
          : { pushedAuthorizationRequestEndpoint: `${provider}/par` }),
        requirePushedAuthorizationRequests: required,
        dpopSigningAlgorithms: ["ES256"],
      };
      const starting = beginAuthorization({
        discovery,
        clientId: "fixture-client",
        redirectUri: `${origin}/return`,
        scope: "openid",
        dpop: true,
        fetch: async (url) => {
          assert.equal(String(url), `${provider}/par`);
          calls++;
          if (fault === "disconnect")
            throw new Error("Synthetic transport loss");
          return new Response("Unavailable", { status: 503 });
        },
      });
      if (required) await assert.rejects(starting);
      else {
        const result = await starting;
        const query = new URL(result.location).searchParams;
        assert.equal(query.has("request_uri"), false);
        assert.equal(query.get("code_challenge_method"), "S256");
        assert.equal(query.get("state"), result.state);
        assert.equal(
          query.get("code_challenge"),
          createHash("sha256").update(result.verifier).digest("base64url"),
        );
        assert.ok(result.dpopJwk);
      }
      assert.equal(calls, fault === "missing" ? 0 : 1);
    });

for (const required of [false, true])
  test(`successful ${required ? "required" : "optional"} PAR uses only the provider request URI`, async () => {
    let calls = 0;
    let challenge = "";
    const discovery = {
      origin: provider,
      authorizationEndpoint: `${provider}/authorize`,
      tokenEndpoint: `${provider}/token`,
      pushedAuthorizationRequestEndpoint: `${provider}/par`,
      requirePushedAuthorizationRequests: required,
      dpopSigningAlgorithms: ["ES256"],
    };
    const result = await beginAuthorization({
      discovery,
      clientId: "fixture-client",
      redirectUri: `${origin}/return`,
      scope: "openid",
      fetch: async (url, init) => {
        calls++;
        assert.equal(String(url), `${provider}/par`);
        assert.equal(init?.method, "POST");
        assert.ok(new Headers(init?.headers).get("dpop"));
        challenge = new URLSearchParams(String(init?.body)).get(
          "code_challenge",
        )!;
        return Response.json(
          { request_uri: "urn:fixture:request", expires_in: 600 },
          { status: 201 },
        );
      },
    });
    const query = new URL(result.location).searchParams;
    assert.deepEqual(
      [...query],
      [
        ["client_id", "fixture-client"],
        ["request_uri", "urn:fixture:request"],
      ],
    );
    assert.equal(
      challenge,
      createHash("sha256").update(result.verifier).digest("base64url"),
    );
    assert.equal(calls, 1);
    assert.ok(result.dpopJwk);
  });

for (const required of [false, true])
  for (const algorithms of [undefined, [], ["RS256"], ["none"], ["HS256"]])
    test(`PAR does not imply ES256 DPoP (required: ${required}, advertised: ${JSON.stringify(algorithms)})`, async () => {
      let calls = 0;
      const result = await beginAuthorization({
        discovery: {
          origin: provider,
          authorizationEndpoint: `${provider}/authorize`,
          tokenEndpoint: `${provider}/token`,
          pushedAuthorizationRequestEndpoint: `${provider}/par`,
          requirePushedAuthorizationRequests: required,
          ...(algorithms ? { dpopSigningAlgorithms: algorithms } : {}),
        },
        clientId: "fixture-client",
        redirectUri: `${origin}/return`,
        scope: "openid",
        fetch: async (_url, init) => {
          calls++;
          assert.equal(new Headers(init?.headers).has("dpop"), false);
          return Response.json(
            { request_uri: "urn:fixture:request", expires_in: 600 },
            { status: 201 },
          );
        },
      });
      assert.equal(calls, 1);
      assert.equal(result.dpopJwk, undefined);
      assert.equal(
        new URL(result.location).searchParams.get("request_uri"),
        "urn:fixture:request",
      );
    });

for (const algorithms of [undefined, [], ["RS256"], ["none"], ["HS256"]])
  test(`explicit DPoP policy rejects unsupported advertised algorithms before any provider request (${JSON.stringify(algorithms)})`, async () => {
    let calls = 0;
    await assert.rejects(
      beginAuthorization({
        discovery: {
          origin: provider,
          authorizationEndpoint: `${provider}/authorize`,
          tokenEndpoint: `${provider}/token`,
          pushedAuthorizationRequestEndpoint: `${provider}/par`,
          ...(algorithms ? { dpopSigningAlgorithms: algorithms } : {}),
        },
        clientId: "fixture-client",
        redirectUri: `${origin}/return`,
        scope: "openid",
        dpop: true,
        fetch: async () => {
          calls++;
          throw new Error("Must not send unsupported proof");
        },
      }),
      /DPoP/,
    );
    assert.equal(calls, 0);
  });

for (const required of [false, true])
  test(`isolated OAuth propagates discovered PAR policy before opening a browser (required: ${required})`, async (t) => {
    const store = new SQLiteCeremonyStore(":memory:", {
      current: "test",
      keys: { test: randomBytes(32) },
    });
    t.after(() => store.close());
    const context: OperationContext = {
      actor: {
        tenantId: "tenant",
        subjectId: "owner",
        sessionId: "session",
        actorKind: "human",
        capabilities: ["executor"],
      },
      runId: "par-policy",
      nodeId: "authorize",
      commandId: "command",
      effectId: "effect",
      target: "novel",
      origin,
      configurationVersion: "v1",
      environment: "test",
      signal: new AbortController().signal,
    };
    await store.transaction((tx) =>
      tx.put(
        {
          tenant: context.actor.tenantId,
          kind: "artifact",
          id: "installed-connector:novel",
        },
        {
          author: context.actor.subjectId,
          session: context.actor.sessionId,
          manifest: { name: "Novel", methods: [] },
          definition: {},
          discovery: {
            origin: provider,
            clientId: "fixture-client",
            authorizationEndpoint: `${provider}/authorize`,
            tokenEndpoint: `${provider}/token`,
            pushedAuthorizationRequestEndpoint: `${provider}/par`,
            requirePushedAuthorizationRequests: required,
            documents: [],
            methods: ["oauth-code"],
            grantTypes: [],
            searchUsed: false,
          },
        },
        null,
      ),
    );
    await saveAuthoredAccountIntent(store, context.actor, context.runId, {
      identifier: "chosen-account",
      status: "existing",
    });
    let browserCalls = 0;
    let parCalls = 0;
    const registry = new OperationRegistry(authoredVocabulary);
    registerAuthoredOperations(registry, {
      store,
      fetch: async (url) => {
        assert.equal(String(url), `${provider}/par`);
        parCalls++;
        return new Response("Unavailable", { status: 503 });
      },
      browser: {
        complete: async () => {
          browserCalls++;
          return { status: "blocked", reason: "challenge" };
        },
      },
    });
    const result = await registry
      .require("authored.authorize-user", "1.0.0")
      .handler(context, { app: "fixture-app" });
    assert.equal(result.state, "awaiting-human");
    assert.equal(parCalls, 1);
    assert.equal(browserCalls, required ? 0 : 1);
  });
