import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/registry.js";
import {
  ProtectedCommandService,
  type RunRecord,
} from "../src/server/commands.js";
import { authoredHuman } from "../src/server/authored-human.js";
import {
  authoredVocabulary,
  discoveredAuthSchema,
  publicAuthoredIdentity,
  registerAuthoredOperations,
} from "../src/server/authored-operations.js";
import {
  authorizationParamsSchema,
  beginAuthorization,
} from "../src/server/authored-oauth.js";
import { readAuthoredApp } from "../src/server/authored-app.js";
import { installedDiscovery } from "../src/server/authored-operations.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/*
 * Declared authorization-request extras and confidential clients for
 * authored OAuth connectors. Extras are an allowlist that can never replace a
 * protocol parameter; a client secret is collected on the native page, kept
 * in custody and appears only in the token request's client authentication.
 */

const provider = "https://provider.example";
const origin = "https://ceremony.example";
const discovery = {
  origin: provider,
  issuer: provider,
  authorizationEndpoint: `${provider}/authorize`,
  tokenEndpoint: `${provider}/token`,
};

test("declared authorization parameters are added but can never replace protocol parameters", async () => {
  const started = await beginAuthorization({
    discovery,
    clientId: "real-client",
    redirectUri: `${origin}/callback`,
    scope: "openid",
    authorizationParams: {
      audience: "https://api.provider.example",
      prompt: "consent",
      access_type: "offline",
      // Only reachable by bypassing the schema; still must not win.
      state: "attacker-state",
      redirect_uri: "https://attacker.example/cb",
      client_id: "attacker-client",
      code_challenge: "attacker",
      scope: "admin",
      response_type: "token",
    } as Record<string, string>,
  });
  const url = new URL(started.location);
  assert.equal(
    url.searchParams.get("audience"),
    "https://api.provider.example",
  );
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("state"), started.state);
  assert.equal(url.searchParams.get("redirect_uri"), `${origin}/callback`);
  assert.equal(url.searchParams.get("client_id"), "real-client");
  assert.equal(url.searchParams.get("scope"), "openid");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.notEqual(url.searchParams.get("code_challenge"), "attacker");
  for (const name of [
    "state",
    "redirect_uri",
    "client_id",
    "scope",
    "code_challenge",
  ])
    assert.equal(url.searchParams.getAll(name).length, 1, name);
});

test("pushed authorization requests carry declared extras without letting them override the request", async () => {
  let pushed: URLSearchParams | undefined;
  const started = await beginAuthorization({
    discovery: {
      ...discovery,
      pushedAuthorizationRequestEndpoint: `${provider}/par`,
      requirePushedAuthorizationRequests: true,
    },
    clientId: "real-client",
    redirectUri: `${origin}/callback`,
    scope: "openid",
    authorizationParams: {
      audience: "api",
      state: "attacker",
    } as Record<string, string>,
    fetch: async (_input, init) => {
      pushed = new URLSearchParams(String(init?.body));
      return Response.json(
        { request_uri: "urn:example:request", expires_in: 60 },
        { status: 201 },
      );
    },
  });
  assert.equal(pushed?.get("audience"), "api");
  assert.equal(pushed?.get("state"), started.state);
  assert.equal(pushed?.getAll("state").length, 1);
});

test("the schema refuses reserved or unknown authorization parameter names", () => {
  for (const name of [
    "state",
    "code_challenge",
    "redirect_uri",
    "client_id",
    "response_type",
    "scope",
    "request_uri",
    "client_secret",
    "x-anything",
  ])
    assert.equal(
      authorizationParamsSchema.safeParse({ [name]: "value" }).success,
      false,
      name,
    );
  assert.equal(
    authorizationParamsSchema.safeParse({ audience: "a", prompt: "login" })
      .success,
    true,
  );
  assert.equal(
    authorizationParamsSchema.safeParse({ audience: "line\nbreak" }).success,
    false,
  );
  assert.equal(
    discoveredAuthSchema.safeParse({
      origin: provider,
      documents: [],
      methods: [],
      grantTypes: [],
      searchUsed: false,
      authorizationParams: { redirect_uri: "https://attacker.example" },
    }).success,
    false,
  );
});

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "owner",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};

async function confidentialFixture(
  method: "client_secret_basic" | "client_secret_post",
) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const runContext = {
    provider: "novel",
    profile: "authored",
    target: "novel",
    origin,
    environment: "test",
    configurationVersion: "v1",
  };
  await store.transaction((tx) =>
    tx.put(
      {
        tenant: actor.tenantId,
        kind: "artifact",
        id: "installed-connector:novel",
      },
      {
        author: actor.subjectId,
        session: actor.sessionId,
        manifest: { name: "Novel", methods: [{ kind: "oauth-code" }] },
        definition: {},
        discovery: {
          ...discovery,
          userinfoEndpoint: `${provider}/userinfo`,
          clientId: "confidential-client",
          tokenEndpointAuthMethod: method,
          authorizationParams: { audience: "https://api.provider.example" },
          popupOrigins: ["https://id.provider.example"],
          codeChallengeMethods: ["S256"],
          documents: [],
          methods: ["oauth-code"],
          grantTypes: [],
          searchUsed: false,
        },
      },
      null,
    ),
  );
  const tokenRequests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === "/token") {
      tokenRequests.push(request.clone());
      return Response.json({
        access_token: "fixture-access-token",
        token_type: "Bearer",
      });
    }
    if (url.pathname === "/userinfo")
      return Response.json({ sub: "subject-1", preferred_username: "owner" });
    // Published metadata knows the endpoints, never the author's client settings.
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: provider,
        authorization_endpoint: `${provider}/authorize`,
        token_endpoint: `${provider}/token`,
        code_challenge_methods_supported: ["S256"],
      });
    return new Response("", { status: 404 });
  };
  const registry = new OperationRegistry(authoredVocabulary);
  registerAuthoredOperations(registry, { store, fetch: fetcher });
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const run = await commands.createRun(
    actor,
    runContext,
    [
      {
        id: "app",
        operationId: "authored.prepare-app",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
      {
        id: "user",
        operationId: "authored.authorize-user",
        operationVersion: "1.0.0",
        dependsOn: ["app"],
        bindings: { app: { from: "output", node: "app", name: "app" } },
      },
    ],
    {},
  );
  const advance = async () => {
    const snapshot = await commands.snapshot(actor, run.id);
    for (const node of snapshot.nodes) {
      if (node.verified) continue;
      await commands.advance(
        actor,
        run.id,
        node.id,
        snapshot.revision,
        `advance:${node.id}:${snapshot.revision}`,
      );
      return;
    }
  };
  await advance();
  const humanUrl = `${origin}/api/v1/teaching/novel/${run.id}/human`;
  const pages: string[] = [];
  const human = async (init?: RequestInit, query = "") => {
    const record = await store.transaction((tx) =>
      tx.get<RunRecord>({ tenant: actor.tenantId, kind: "run", id: run.id }),
    );
    assert.ok(record);
    const snapshot = await commands.snapshot(actor, run.id);
    const pending = snapshot.nodes.find((node) => !node.verified);
    const context: OperationContext = {
      ...runContext,
      actor,
      runId: run.id,
      nodeId: pending?.id ?? "user",
      commandId: "human",
      effectId: "human",
      signal: new AbortController().signal,
    };
    const response = await authoredHuman(
      store,
      context,
      record,
      new Request(`${humanUrl}${query}`, init),
      origin,
      advance,
      { connectorId: "novel", name: "Novel", fetch: fetcher },
    );
    pages.push(
      `${response.status} ${response.headers.get("location") ?? ""} ${await response.clone().text()}`,
    );
    return response;
  };
  return { store, commands, run, human, advance, tokenRequests, pages };
}

for (const method of ["client_secret_basic", "client_secret_post"] as const)
  test(`a confidential authored client (${method}) completes with the secret only in client authentication`, async (t) => {
    const secret = "synthetic-client-secret-value";
    const f = await confidentialFixture(method);
    t.after(() => f.store.close());
    const snapshot = await f.commands.snapshot(actor, f.run.id);
    assert.equal(snapshot.nodes[0]?.state, "awaiting-human");

    const page = await (await f.human()).text();
    assert.match(page, /name="client_secret" type="password"/);
    assert.match(page, /\/api\/v1\/teaching\/novel\/.*\/human/);
    const saved = await f.human({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_secret: secret }).toString(),
    });
    assert.equal(saved.status, 303);
    // The host's own advance continues the run to the next step.
    await f.advance();
    const afterApp = await f.commands.snapshot(actor, f.run.id);
    assert.equal(afterApp.nodes[0]?.verified, true);
    assert.equal(afterApp.nodes[1]?.state, "awaiting-human");
    const app = await readAuthoredApp(f.store, actor, f.run.id);
    assert.equal(app?.tokenEndpointAuthMethod, method);
    assert.equal(JSON.stringify(app).includes(secret), false);

    const start = await f.human();
    assert.equal(start.status, 303);
    const authorize = new URL(start.headers.get("location")!);
    assert.equal(
      authorize.origin + authorize.pathname,
      `${provider}/authorize`,
    );
    assert.equal(
      authorize.searchParams.get("audience"),
      "https://api.provider.example",
    );
    assert.equal(
      authorize.searchParams.get("client_id"),
      "confidential-client",
    );
    assert.equal(authorize.href.includes(secret), false);

    const done = await f.human(
      undefined,
      `?code=fixture-code&state=${authorize.searchParams.get("state")}`,
    );
    assert.equal(done.status, 303);
    assert.equal(f.tokenRequests.length, 1);
    const token = f.tokenRequests[0]!;
    const body = new URLSearchParams(await token.text());
    if (method === "client_secret_basic") {
      assert.equal(
        token.headers.get("authorization"),
        `Basic ${Buffer.from(`confidential-client:${secret}`).toString("base64")}`,
      );
      assert.equal(body.has("client_secret"), false);
    } else {
      assert.equal(body.get("client_secret"), secret);
      assert.equal(token.headers.get("authorization"), null);
    }
    assert.equal(
      (await publicAuthoredIdentity(f.store, actor, f.run.id))?.handle,
      "owner",
    );
    const final = await f.commands.snapshot(actor, f.run.id);
    assert.equal(final.status, "complete");
    // The secret is in none of the pages the person saw, and nowhere a run,
    // node, event or audit record can carry it.
    assert.equal(f.pages.join("\n").includes(secret), false);
    const records = await f.store.transaction(async (tx) => [
      ...(await tx.list(actor.tenantId, "run", 1000, "")),
      ...(await tx.list(actor.tenantId, "node", 1000, "")),
      ...(await tx.list(actor.tenantId, "event", 1000, "")),
      ...(await tx.list(actor.tenantId, "audit", 1000, "")),
      ...(await tx.list(actor.tenantId, "artifact", 1000, "")),
    ]);
    assert.equal(JSON.stringify({ final, records }).includes(secret), false);
  });

test("a confidential client without its secret never falls back to a public token request", async (t) => {
  const f = await confidentialFixture("client_secret_basic");
  t.after(() => f.store.close());
  // A secret for a different client ID is not this client's secret.
  const { saveAuthoredClientSecret } =
    await import("../src/server/authored-app.js");
  await saveAuthoredClientSecret(f.store, actor, "novel", {
    clientId: "some-other-client",
    secret: "not-this-one",
  });
  const page = await (await f.human()).text();
  assert.match(page, /name="client_secret"/);
  const snapshot = await f.commands.snapshot(actor, f.run.id);
  assert.equal(snapshot.nodes[0]?.state, "awaiting-human");
  assert.equal(f.tokenRequests.length, 0);
});

test("a native discovery refresh keeps the author's declared client settings", async (t) => {
  const f = await confidentialFixture("client_secret_post");
  t.after(() => f.store.close());
  // Asking for the native flow re-reads the provider's published metadata.
  const page = await (await f.human(undefined, "?flow=oauth-code")).text();
  assert.match(page, /name="client_secret"/);
  const saved = await installedDiscovery(f.store, actor, "novel");
  assert.equal(saved?.authorizationEndpoint, `${provider}/authorize`);
  assert.equal(saved?.clientId, "confidential-client");
  assert.equal(saved?.tokenEndpointAuthMethod, "client_secret_post");
  assert.deepEqual(saved?.authorizationParams, {
    audience: "https://api.provider.example",
  });
  // A declared sign-in window is the author's, not the provider's metadata.
  assert.deepEqual(saved?.popupOrigins, ["https://id.provider.example"]);
});
