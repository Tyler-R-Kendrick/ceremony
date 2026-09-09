import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as oauth from "oauth4webapi";
import {
  authenticatedActor,
  requireCapability,
  requireOwnership,
  type ActorContext,
} from "../src/server/identity.js";
import {
  assertRequestBoundary,
  authorizeEffect,
  boundedJson,
  effectAuthorizationDigest,
  exactOrigin,
  reserveRequest,
  type AuthorizedEffect,
} from "../src/server/authorization.js";
import {
  createOidcIdentity,
  persistentIdentityStore,
} from "../src/server/oidc-identity.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};
test("IDN AC-18 AC-19 actor ownership, capability, source forgery and effect binding", async () => {
  const request = new Request("https://app.example", {
    headers: { "x-owner": "admin", "x-source": "human" },
  });
  await assert.rejects(
    authenticatedActor(request, { authenticate: async () => null }),
    /unauthenticated/,
  );
  assert.equal(
    (await authenticatedActor(request, { authenticate: async () => actor }))
      .subjectId,
    "subject",
  );
  assert.doesNotThrow(() => requireCapability(actor, "executor"));
  assert.throws(() => requireCapability(actor, "publisher"), /denied/);
  assert.doesNotThrow(() =>
    requireCapability({ ...actor, capabilities: ["admin"] }, "publisher"),
  );
  assert.doesNotThrow(() => requireOwnership(actor, actor));
  for (const resource of [
    { tenantId: "other", subjectId: actor.subjectId },
    { tenantId: actor.tenantId, subjectId: "other" },
  ])
    assert.throws(() => requireOwnership(actor, resource), /denied/);
  const effect: AuthorizedEffect = {
    tenantId: actor.tenantId,
    subjectId: actor.subjectId,
    runId: "run",
    operationId: "github.install",
    operationVersion: "1.0.0",
    target: "organization",
    configurationVersion: "v1",
    scopes: ["read"],
    argumentsDigest: "a".repeat(64),
  };
  const grant = {
    tenantId: actor.tenantId,
    subjectId: actor.subjectId,
    digest: effectAuthorizationDigest(effect),
    expiresAt: 100,
    revoked: false,
  };
  assert.doesNotThrow(() => authorizeEffect(actor, effect, grant, 99));
  for (const [name, value] of Object.entries({
    tenantId: "other",
    subjectId: "other",
    runId: "other",
    operationId: "other",
    operationVersion: "2.0.0",
    target: "other",
    configurationVersion: "v2",
    scopes: ["write"],
    argumentsDigest: "b".repeat(64),
  }))
    assert.throws(
      () => authorizeEffect(actor, { ...effect, [name]: value }, grant, 99),
      /denied/,
    );
  assert.throws(() => authorizeEffect(actor, effect, grant, 100), /denied/);
  assert.throws(
    () => authorizeEffect(actor, effect, { ...grant, revoked: true }, 99),
    /denied/,
  );
});
test("IDN AC-26 exact origin, real body ceiling and shared rate reservation", async () => {
  assert.equal(exactOrigin("https://app.example"), "https://app.example");
  assert.equal(
    exactOrigin("http://127.0.0.1:4173", true),
    "http://127.0.0.1:4173",
  );
  for (const origin of [
    "https://app.example/",
    "http://app.example",
    "http://127.0.0.1:4173",
  ])
    assert.throws(() => exactOrigin(origin));
  const options = { origin: "https://app.example", maxBytes: 5 };
  const req = (origin: string, contentType = "application/json", body = "{}") =>
    new Request(options.origin, {
      method: "POST",
      headers: { origin, "content-type": contentType },
      body,
    });
  assert.doesNotThrow(() =>
    assertRequestBoundary(req(options.origin), options),
  );
  assert.doesNotThrow(() =>
    assertRequestBoundary(new Request(options.origin), options),
  );
  assert.throws(
    () => assertRequestBoundary(new Request("https://other.example"), options),
    /invalid_request/,
  );
  for (const length of ["6", "invalid"])
    assert.throws(
      () =>
        assertRequestBoundary(
          new Request(options.origin, {
            method: "POST",
            headers: {
              origin: options.origin,
              "content-type": "application/json",
              "content-length": length,
            },
          }),
          options,
        ),
      /invalid_request/,
    );
  await assert.rejects(
    boundedJson(new Request(options.origin)),
    /invalid_request/,
  );
  await assert.rejects(
    boundedJson(req(options.origin, "application/json", "{")),
    /invalid_request/,
  );
  for (const origin of ["null", "https://evil.example"])
    assert.throws(() => assertRequestBoundary(req(origin), options), /denied/);
  assert.throws(
    () => assertRequestBoundary(req(options.origin, "text/plain"), options),
    /invalid_request/,
  );
  await assert.rejects(
    boundedJson(req(options.origin, "application/json", '"12345"'), 5),
    /invalid_request/,
  );
  assert.deepEqual(await boundedJson(req(options.origin)), {});
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  try {
    await reserveRequest(store, actor, 1);
    await assert.rejects(reserveRequest(store, actor, 0), /invalid_request/);
    await assert.rejects(reserveRequest(store, actor, 1), /rate_limited/);
    await reserveRequest(store, { ...actor, subjectId: "another" }, 1);
  } finally {
    await store.close();
  }
});

test("IDN OIDC real HTTP signed-token login, PKCE, nonce, replay, logout and cross-device restoration", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  let issuer = "";
  let nonce = "";
  let challenge = "";
  let wrongNonce = false;
  let wrongAudience = false;
  let wrongSignature = false;
  let expiredToken = false;
  const wrongKey = (await generateKeyPair("RS256")).privateKey;
  let tokenCalls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration")
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
    if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      if (
        (await oauth.calculatePKCECodeChallenge(
          params.get("code_verifier") ?? "",
        )) !== challenge
      ) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid_grant" }));
      }
      tokenCalls++;
      const jwt = await new SignJWT({ nonce: wrongNonce ? "wrong" : nonce })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience(wrongAudience ? "other-client" : "client")
        .setSubject("oidc|123")
        .setIssuedAt()
        .setExpirationTime(expiredToken ? "-5m" : "5m")
        .sign(wrongSignature ? wrongKey : privateKey);
      return res.end(
        JSON.stringify({
          access_token: "fixture-token",
          token_type: "Bearer",
          id_token: jwt,
        }),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  try {
    const origin = "http://127.0.0.1:4173";
    const config = {
      issuer,
      origin,
      clientId: "client",
      development: true,
      mapClaims: async (claims: oauth.IDToken) => ({
        tenantId: "tenant",
        subjectId: claims.sub,
        capabilities: ["executor" as const],
      }),
    };
    const identity = await createOidcIdentity(
      config,
      persistentIdentityStore(store),
    );
    const begin = async () => {
      const result = await identity.login(
        new Request(`${origin}/api/auth/login`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
        }),
      );
      const url = new URL(result.headers.get("location")!);
      nonce = url.searchParams.get("nonce")!;
      challenge = url.searchParams.get("code_challenge")!;
      return new Request(
        `${origin}/api/auth/callback?code=code&state=${url.searchParams.get("state")}`,
        {
          headers: { cookie: result.headers.getSetCookie()[0]!.split(";")[0]! },
        },
      );
    };
    const callback = await begin();
    const result = await identity.callback(callback);
    const sessionCookie = result.headers.getSetCookie()[0]!.split(";")[0]!;
    const authenticated = new Request(origin, {
      headers: { cookie: sessionCookie },
    });
    const first = await identity.authenticate(authenticated);
    assert.equal(first?.subjectId, "oidc|123");
    assert.equal(tokenCalls, 1);
    await assert.rejects(identity.callback(callback), /denied/);
    assert.equal(tokenCalls, 1);
    const secondIdentity = await createOidcIdentity(
      config,
      persistentIdentityStore(store),
    );
    assert.deepEqual(await secondIdentity.authenticate(authenticated), first);
    const secondLogin = await secondIdentity.callback(await begin());
    const second = await secondIdentity.authenticate(
      new Request(origin, {
        headers: {
          cookie: secondLogin.headers.getSetCookie()[0]!.split(";")[0]!,
        },
      }),
    );
    assert.equal(second?.subjectId, first?.subjectId);
    assert.notEqual(second?.sessionId, first?.sessionId);
    wrongNonce = true;
    await assert.rejects(identity.callback(await begin()), /denied/);
    wrongNonce = false;
    wrongAudience = true;
    await assert.rejects(identity.callback(await begin()), /denied/);
    wrongAudience = false;
    wrongSignature = true;
    await assert.rejects(identity.callback(await begin()), /denied/);
    wrongSignature = false;
    expiredToken = true;
    await assert.rejects(identity.callback(await begin()), /denied/);
    expiredToken = false;
    const wrongState = await begin();
    const wrongStateUrl = new URL(wrongState.url);
    wrongStateUrl.searchParams.set("state", "forged");
    const before = tokenCalls;
    await assert.rejects(
      identity.callback(
        new Request(wrongStateUrl, { headers: wrongState.headers }),
      ),
      /denied/,
    );
    assert.equal(tokenCalls, before);
    await assert.rejects(
      identity.callback(new Request(wrongState.url)),
      /denied/,
    );
    await assert.rejects(
      identity.login(new Request(origin)),
      /invalid_request/,
    );
    await assert.rejects(
      identity.logout(new Request(origin)),
      /invalid_request/,
    );
    const duplicateCookie = new Request(origin, {
      headers: { cookie: `${sessionCookie}; ${sessionCookie}` },
    });
    assert.equal(await identity.authenticate(duplicateCookie), null);
    await identity.logout(
      new Request(origin, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: sessionCookie,
        },
      }),
    );
    assert.equal(await identity.authenticate(authenticated), null);
    assert.equal(
      await identity.authenticate(
        new Request(origin, { headers: { "x-owner": "admin" } }),
      ),
      null,
    );
    await assert.rejects(
      createOidcIdentity(
        { ...config, development: false },
        persistentIdentityStore(store),
      ),
    );
  } finally {
    await store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("IDN session expiration and atomic consume use shared storage clock", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  try {
    const identityStore = persistentIdentityStore(store);
    await identityStore.put("expired", { marker: true }, Date.now() - 1000);
    assert.equal(await identityStore.get("expired"), undefined);
    await identityStore.put("once", { marker: true }, Date.now() + 10000);
    const outcomes = await Promise.all([
      identityStore.take("once"),
      identityStore.take("once"),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    await identityStore.delete("missing");
  } finally {
    await store.close();
  }
});

test("IDN production cookie attributes and configuration fail closed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      issuer: "https://identity.example",
      authorization_endpoint: "https://identity.example/authorize",
      token_endpoint: "https://identity.example/token",
      jwks_uri: "https://identity.example/jwks",
    });
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const config = {
    origin: "https://app.example",
    issuer: "https://identity.example",
    clientId: "client",
    mapClaims: async () => ({
      tenantId: "tenant",
      subjectId: "subject",
      capabilities: ["executor" as const],
    }),
  };
  try {
    const identity = await createOidcIdentity(
      config,
      persistentIdentityStore(store),
    );
    const login = await identity.login(
      new Request(`${config.origin}/api/auth/login`, {
        method: "POST",
        headers: { origin: config.origin, "content-type": "application/json" },
      }),
    );
    const cookie = login.headers.getSetCookie()[0]!;
    for (const expected of [
      "__Host-ceremony_login=",
      "HttpOnly",
      "SameSite=Lax",
      "Secure",
      "Path=/",
    ])
      assert.ok(cookie.includes(expected));
    assert.equal(cookie.includes("Domain="), false);
    assert.equal(login.headers.get("cache-control"), "no-store");
    for (const sessionSeconds of [0, 86401, 1.5])
      await assert.rejects(
        createOidcIdentity(
          { ...config, sessionSeconds },
          persistentIdentityStore(store),
        ),
        /invalid_request/,
      );
    await assert.rejects(
      createOidcIdentity(
        { ...config, issuer: "https://user:password@identity.example" },
        persistentIdentityStore(store),
      ),
      /invalid_request/,
    );
    await assert.rejects(
      createOidcIdentity(
        { ...config, clientId: "" },
        persistentIdentityStore(store),
      ),
      /invalid_request/,
    );
    globalThis.fetch = async () =>
      Response.json({
        issuer: config.issuer,
        authorization_endpoint: "http://unsafe.example/authorize",
        token_endpoint: "https://identity.example/token",
        jwks_uri: "https://identity.example/jwks",
      });
    await assert.rejects(
      createOidcIdentity(config, persistentIdentityStore(store)),
      /invalid_request/,
    );
    globalThis.fetch = async () => Response.json({ issuer: config.issuer });
    await assert.rejects(
      createOidcIdentity(config, persistentIdentityStore(store)),
      /invalid_request/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
  }
});
