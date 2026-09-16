import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createMcpIdentity } from "../src/server/mcp-identity.js";
import type { McpIdentityConfig } from "../src/server/mcp-identity.js";

const issuer = "https://identity.example";
const audience = "https://ceremony.example/mcp";
const metadata = { issuer, jwks_uri: `${issuer}/jwks` };
const mapClaims: McpIdentityConfig["mapClaims"] = async (claims) => ({
  tenantId: "tenant-fixture",
  subjectId: claims.sub,
  capabilities: ["executor"],
});
const requestFor = (token?: string) =>
  new Request(audience, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

test("MCP identity rejects unsafe issuer configuration before any discovery", async (t) => {
  const transport = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  for (const [url, development] of [
    ["https://user@identity.example", false],
    ["https://:password@identity.example", false],
    [`${issuer}?query=1`, false],
    [`${issuer}#fragment`, false],
    ["http://127.0.0.1", false],
    ["http://localhost", true],
    ["http://identity.example", true],
    ["ftp://127.0.0.1", true],
  ] as const)
    await assert.rejects(
      createMcpIdentity({ issuer: url, audience, development, mapClaims }),
      /invalid_request/,
    );
  for (const supplied of [
    { issuer: "https://other.example", jwks_uri: metadata.jwks_uri },
    { issuer },
  ])
    await assert.rejects(
      createMcpIdentity({ issuer, audience, metadata: supplied, mapClaims }),
      /invalid_request/,
    );
  assert.equal(transport.mock.callCount(), 0);
});

test("MCP signed access tokens bind audience and stable subject/client sessions", async (t) => {
  const key = await generateKeyPair("ES256");
  const wrongKey = await generateKeyPair("ES256");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "fixture",
    alg: "ES256",
  };
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    paths.push(url);
    assert.equal(url, metadata.jwks_uri);
    return Response.json({ keys: [jwk] });
  });
  let mappings = 0;
  const authenticate = await createMcpIdentity({
    issuer: `${issuer}/`,
    audience,
    metadata,
    mapClaims: async (claims) => {
      mappings++;
      return mapClaims(claims);
    },
  });
  const sign = (
    claims: Record<string, unknown> = {},
    signingKey = key.privateKey,
  ) =>
    new SignJWT({ client_id: "chat-one", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "fixture", typ: "at+jwt" })
      .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
      .setAudience(typeof claims.aud === "string" ? claims.aud : audience)
      .setSubject(typeof claims.sub === "string" ? claims.sub : "subject-one")
      .setJti(typeof claims.jti === "string" ? claims.jti : "access-one")
      .setIssuedAt()
      .setExpirationTime(typeof claims.exp === "number" ? claims.exp : "5m")
      .sign(signingKey);
  const valid = await sign();
  const actor = await authenticate("ignored-argument", requestFor(valid));
  assert.ok(actor);
  assert.deepEqual(
    { ...actor, sessionId: undefined },
    {
      tenantId: "tenant-fixture",
      subjectId: "subject-one",
      capabilities: ["executor"],
      actorKind: "agent",
      sessionId: undefined,
    },
  );
  assert.match(actor.sessionId, /^mcp:[a-f0-9]{32}$/);
  const refreshed = await authenticate(
    "",
    requestFor(await sign({ jti: "access-two" })),
  );
  assert.equal(refreshed?.sessionId, actor.sessionId);
  for (const claims of [{ client_id: "chat-two" }, { sub: "subject-two" }]) {
    const other = await authenticate("", requestFor(await sign(claims)));
    assert.ok(other);
    assert.notEqual(other.sessionId, actor.sessionId);
  }
  const beforeRejected = mappings;
  for (const token of [
    undefined,
    "not-a-jwt",
    await sign({ aud: "another-resource" }),
    await sign({ iss: "https://other.example" }),
    await sign({ exp: 1 }),
    await sign({}, wrongKey.privateKey),
    await sign({ sub: "" }),
    await sign({ client_id: "" }),
    await sign({ client_id: 17 }),
  ])
    assert.equal(await authenticate(valid, requestFor(token)), null);
  assert.equal(mappings, beforeRejected);
  assert.ok(paths.length > 0);
  for (const mapper of [
    async () => {
      throw new Error("Synthetic mapping failure");
    },
    async () => ({ tenantId: "", subjectId: "subject-one", capabilities: [] }),
  ]) {
    const rejectMapping = await createMcpIdentity({
      issuer,
      audience,
      metadata,
      mapClaims: mapper,
    });
    assert.equal(await rejectMapping("", requestFor(valid)), null);
  }
});

test("MCP discovery accepts only explicitly enabled loopback HTTP and exact issuer metadata", async (t) => {
  const localIssuer = "http://127.0.0.1:43117";
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    paths.push(url);
    assert.equal(url, `${localIssuer}/.well-known/openid-configuration`);
    return Response.json({
      issuer: localIssuer,
      jwks_uri: `${localIssuer}/jwks`,
    });
  });
  const authenticate = await createMcpIdentity({
    issuer: localIssuer,
    audience,
    development: true,
    mapClaims,
  });
  assert.equal(await authenticate("not-used", requestFor()), null);
  assert.deepEqual(paths, [`${localIssuer}/.well-known/openid-configuration`]);
  const supplied = await createMcpIdentity({
    issuer: `${issuer}/`,
    audience,
    metadata: { ...metadata, issuer: `${issuer}/` },
    mapClaims,
  });
  assert.equal(await supplied("not-used", requestFor()), null);
});
