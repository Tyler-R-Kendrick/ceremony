import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createDevIssuer } from "../examples/issuer.js";

const origin = "https://tunnel.example";
const audience = `${origin}/mcp`;
const redirectUri = "https://client.example/callback";

const issuer = () =>
  createDevIssuer({ origin, audiences: [audience], subject: "tester" });

const get = (path: string) => new Request(`${origin}${path}`);
const post = (path: string, body: unknown, form = false) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": form
        ? "application/x-www-form-urlencoded"
        : "application/json",
    },
    body: form ? String(body) : JSON.stringify(body),
  });

async function register(dev: Awaited<ReturnType<typeof createDevIssuer>>) {
  const response = await dev.handle(
    post("/oauth/register", {
      redirect_uris: [redirectUri],
      client_name: "Test chat client",
    }),
  );
  assert.equal(response?.status, 201);
  return (await response!.json()).client_id as string;
}

async function authorize(
  dev: Awaited<ReturnType<typeof createDevIssuer>>,
  clientId: string,
  verifier: string,
) {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const response = await dev.handle(
    get(
      `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(audience)}`,
    ),
  );
  assert.equal(response?.status, 200);
  const html = await response!.text();
  return new URL(
    /href="([^"]*code=[^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&"),
  ).searchParams.get("code")!;
}

const exchange = (
  dev: Awaited<ReturnType<typeof createDevIssuer>>,
  clientId: string,
  code: string,
  verifier: string,
) =>
  dev.handle(
    post(
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      true,
    ),
  );

test("discovery names every endpoint a client needs and is served under both well-known names", async () => {
  const dev = await issuer();
  for (const path of [
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ]) {
    const response = await dev.handle(get(path));
    assert.equal(response?.status, 200);
    const body = await response!.json();
    assert.equal(body.issuer, origin);
    assert.equal(body.registration_endpoint, `${origin}/oauth/register`);
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  }
});

test("a registered client completes the flow and receives a verifiable access token", async () => {
  const dev = await issuer();
  const clientId = await register(dev);
  const verifier = randomBytes(32).toString("base64url");
  const code = await authorize(dev, clientId, verifier);
  const response = await exchange(dev, clientId, code, verifier);
  assert.equal(response?.status, 200);
  const body = await response!.json();

  const jwks = await (await dev.handle(get("/.well-known/jwks.json")))!.json();
  const { payload, protectedHeader } = await jwtVerify(
    body.access_token,
    createLocalJWKSet(jwks),
    { issuer: origin, audience },
  );
  // RFC 9068: a resource server must be able to tell an access token from an
  // ID token by its type alone.
  assert.equal(protectedHeader.typ, "at+jwt");
  assert.equal(payload.sub, "tester");
  assert.equal(payload.client_id, clientId);
  assert.deepEqual(payload.ceremony_roles, ["executor"]);
});

test("a code is spent even when the exchange that spent it failed", async () => {
  const dev = await issuer();
  const clientId = await register(dev);
  const verifier = randomBytes(32).toString("base64url");
  const code = await authorize(dev, clientId, verifier);

  const wrong = await exchange(dev, clientId, code, "not-the-verifier");
  assert.equal(wrong?.status, 400);
  // The verifier is right this time; the code must still be gone.
  const replay = await exchange(dev, clientId, code, verifier);
  assert.equal(replay?.status, 400);
});

test("a code cannot be redeemed twice", async () => {
  const dev = await issuer();
  const clientId = await register(dev);
  const verifier = randomBytes(32).toString("base64url");
  const code = await authorize(dev, clientId, verifier);
  assert.equal((await exchange(dev, clientId, code, verifier))?.status, 200);
  assert.equal((await exchange(dev, clientId, code, verifier))?.status, 400);
});

test("authorization refuses an unknown client, a foreign redirect, plain PKCE and an unasked-for audience", async () => {
  const dev = await issuer();
  const clientId = await register(dev);
  const challenge = createHash("sha256").update("v").digest("base64url");
  const cases = [
    `/oauth/authorize?client_id=nobody&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`,
    `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent("https://attacker.example/steal")}&code_challenge=${challenge}&code_challenge_method=S256`,
    `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=plain`,
    `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent("https://elsewhere.example/mcp")}`,
  ];
  for (const path of cases)
    assert.equal((await dev.handle(get(path)))?.status, 400, path);
});

test("registration without a redirect uri is refused", async () => {
  const dev = await issuer();
  const response = await dev.handle(
    post("/oauth/register", { client_name: "No redirect" }),
  );
  assert.equal(response?.status, 400);
});

test("a path this issuer does not own is left alone", async () => {
  const dev = await issuer();
  assert.equal(await dev.handle(get("/api/config")), undefined);
});
