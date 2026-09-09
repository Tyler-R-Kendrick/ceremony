import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { teachingIdentityFixture } from "./fixtures/teaching-identity.js";
import { hostedHttp } from "../src/server/hosted/http.js";
import {
  createOidcIdentity,
  persistentIdentityStore,
} from "../src/server/oidc-identity.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  createTeachingRuntime,
  type TeachingRuntime,
} from "../src/server/teaching-runtime.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";

test("OPS-IDN: mounted hosted config and native JSON login/callback/logout use actual signed OIDC HTTP", async () => {
  const provider = await teachingIdentityFixture();
  const { issuer } = provider;
  let runtime: TeachingRuntime | undefined;
  let origin = "";
  const app = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const response = await hostedHttp(
      new Request(`${origin}${req.url}`, {
        method: req.method!,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }),
      runtime!,
      async () => {},
    );
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") res.setHeader(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const appAddress = app.address();
  if (!appAddress || typeof appAddress === "string")
    throw new Error("Fixture unavailable");
  origin = `http://127.0.0.1:${appAddress.port}`;
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  try {
    const identity = await createOidcIdentity(
      {
        origin,
        issuer,
        clientId: "client",
        development: true,
        mapClaims: async (claims) => ({
          tenantId: "tenant",
          subjectId: claims.sub,
          capabilities: ["executor"],
        }),
      },
      persistentIdentityStore(store),
    );
    runtime = createTeachingRuntime({
      store,
      identity,
      origin,
      registry: new OperationRegistry(),
      authorize: async () => true,
      context: async () => ({
        provider: "github",
        profile: "github-app",
        target: "fixture",
        environment: "test",
        origin,
        configurationVersion: "v1",
      }),
    });
    const config = await fetch(`${origin}/api/config`);
    assert.equal(config.status, 200);
    const contents = await config.json();
    assert.equal(contents.teachingAvailable, true);
    assert.equal(contents.liveManifests[0].id, "github");
    assert.equal(config.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${origin}/api/auth/login`)).status, 400);
    const login = (requestOrigin = origin, body = "{}") =>
      fetch(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { origin: requestOrigin, "content-type": "application/json" },
        body,
        redirect: "manual",
      });
    assert.equal((await login("https://foreign.example")).status, 403);
    assert.equal(
      (await login(origin, JSON.stringify({ owner: "admin" }))).status,
      400,
    );
    assert.equal((await login(origin, "x".repeat(1025))).status, 400);
    const begun = await login();
    assert.equal(begun.status, 200);
    const authorizationUrl = (await begun.json()).authorizationUrl;
    assert.equal(new URL(authorizationUrl).origin, issuer);
    const loginCookie = begun.headers.getSetCookie()[0]!.split(";")[0]!;
    assert.ok(begun.headers.getSetCookie()[0]!.includes("HttpOnly"));
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    const callback = await fetch(consent.headers.get("location")!, {
      headers: { cookie: loginCookie },
      redirect: "manual",
    });
    assert.equal(callback.status, 303);
    assert.equal(provider.tokenCalls, 1);
    const sessionCookie = callback.headers.getSetCookie()[0]!.split(";")[0]!;
    const savedEnvironment = await fetch(`${origin}/api/environment`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        revision: 0,
        values: { PRIVATE_TEST: "synthetic-canary" },
      }),
    });
    assert.equal(savedEnvironment.status, 200);
    const environmentMetadata = await savedEnvironment.json();
    assert.deepEqual(environmentMetadata.names, ["PRIVATE_TEST"]);
    assert.equal(
      JSON.stringify(environmentMetadata).includes("synthetic-canary"),
      false,
    );
    const environmentRead = await fetch(`${origin}/api/environment`, {
      headers: { cookie: sessionCookie },
    });
    assert.deepEqual((await environmentRead.json()).names, ["PRIVATE_TEST"]);
    assert.equal(
      (
        await fetch(`${origin}/api/v1/teaching/capabilities`, {
          headers: { cookie: sessionCookie },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(consent.headers.get("location")!, {
          headers: { cookie: loginCookie },
          redirect: "manual",
        })
      ).status,
      403,
    );
    assert.equal(provider.tokenCalls, 1);
    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.equal((await logout.json()).signedOut, true);
    assert.ok(logout.headers.get("clear-site-data")?.includes("storage"));
    assert.ok(logout.headers.getSetCookie()[0]!.includes("Max-Age=0"));
    assert.equal(
      (
        await fetch(`${origin}/api/environment`, {
          headers: { cookie: sessionCookie },
        })
      ).status,
      401,
    );
    const signedOut = await fetch(`${origin}/api/v1/teaching/capabilities`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(signedOut.status, 200);
    assert.equal((await signedOut.json()).authenticated, false);
    assert.equal(
      (
        await fetch(`${origin}/api/v1/teaching/runs/private`, {
          headers: { cookie: sessionCookie },
        })
      ).status,
      401,
    );
  } finally {
    await store.close();
    app.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => app.close(() => resolve())),
      provider.close(),
    ]);
  }
});
