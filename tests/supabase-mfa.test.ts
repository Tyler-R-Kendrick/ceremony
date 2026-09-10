import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import {
  supabaseAuth,
  supabaseAuthWorkflows,
  SupabaseAuthFailure,
} from "../src/server/supabase-auth.js";

test("Supabase MFA Arazzo pointers match the official factorId path parameter", () => {
  for (const action of ["challenge", "verify"]) {
    const workflow = supabaseAuthWorkflows.workflows.find(
      (item) => item.workflowId === `mfa-${action}`,
    );
    assert.equal(
      workflow?.steps[0]?.operationPath,
      `{$sourceDescriptions.auth.url}#/paths/~1factors~1{factorId}~1${action}/post`,
    );
  }
});

test("Supabase TOTP uses SDK HTTP, binds enrolled factors and verifies new aal2 access", async (t) => {
  const key = new TextEncoder().encode("synthetic-mfa-signing-key");
  let clock = Date.now();
  const expires = Math.floor(clock / 1000) + 3600;
  const token = (aal: string, sub = "fixture-user") =>
    new SignJWT({ aal })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub)
      .setExpirationTime(expires)
      .sign(key);
  const initial = await token("aal1");
  const elevated = await token("aal2");
  const factorId = randomUUID();
  const challengeId = randomUUID();
  let factorStatus = "verified";
  let factorType = "totp";
  let rejected = false;
  let issued = elevated;
  let responseUser = "fixture-user";
  let challengeExpires = Math.floor(clock / 1000) + 300;
  let challengeType = "totp";
  let challenges = 0;
  let verifications = 0;
  let requests = 0;
  let advanceOnLookup = 0;
  let consumed = false;
  const user = () => ({
    id: "fixture-user",
    factors: [{ id: factorId, factor_type: factorType, status: factorStatus }],
  });
  const server = createServer(async (req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    try {
      const jwt = req.headers.authorization?.slice(7) ?? "";
      await jwtVerify(jwt, key, { algorithms: ["HS256"] });
      if (req.url === "/auth/v1/user" && req.method === "GET") {
        clock += advanceOnLookup;
        res.statusCode = rejected ? 401 : 200;
        res.end(
          JSON.stringify(
            rejected ? { message: "private-provider-diagnostic" } : user(),
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(req.method, "POST");
      assert.equal(jwt === initial, true);
      if (req.url === `/auth/v1/factors/${factorId}/challenge`) {
        assert.deepEqual(body, { factorId });
        challenges++;
        res.end(
          JSON.stringify({
            id: challengeId,
            type: challengeType,
            expires_at: challengeExpires,
          }),
        );
      } else {
        assert.equal(req.url, `/auth/v1/factors/${factorId}/verify`);
        verifications++;
        if (
          consumed ||
          body.challenge_id !== challengeId ||
          body.code !== "123456"
        ) {
          res.statusCode = 400;
          res.end(JSON.stringify({ message: "private-provider-diagnostic" }));
        } else {
          consumed = true;
          res.end(
            JSON.stringify({
              access_token: issued,
              refresh_token: "synthetic-refresh",
              expires_in: 3600,
              token_type: "bearer",
              user: { id: responseUser },
            }),
          );
        }
      }
    } catch {
      res.statusCode = 500;
      res.end(JSON.stringify({ message: "fixture-protocol-rejected" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const client = supabaseAuth(
    {
      projectUrl: "https://synthetic.supabase.co",
      publishableKey: "sb_publishable_synthetic",
    },
    {
      signal: controller.signal,
      now: () => clock,
      fetch: (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://synthetic.supabase.co");
        assert.equal(init?.redirect, "error");
        return fetch(
          `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
          init,
        );
      },
    },
  );
  const session = {
    access_token: initial,
    refresh_token: "synthetic-refresh",
    expires_at: expires,
    user: { id: "fixture-user" },
  };
  const denied = (error: unknown) =>
    error instanceof SupabaseAuthFailure &&
    ["invalid-input", "verification-rejected", "provider-unavailable"].includes(
      error.code,
    ) &&
    !error.message.includes("private");
  await assert.rejects(client.challengeTotp(session, "../other"), denied);
  assert.equal(requests, 0);
  await assert.rejects(client.challengeTotp(session, randomUUID()), denied);
  factorStatus = "unverified";
  await assert.rejects(client.challengeTotp(session, factorId), denied);
  factorStatus = "verified";
  factorType = "phone";
  await assert.rejects(client.challengeTotp(session, factorId), denied);
  factorType = "totp";
  rejected = true;
  await assert.rejects(client.challengeTotp(session, factorId), denied);
  rejected = false;
  assert.equal(challenges, 0);
  const challenge = await client.challengeTotp(session, factorId);
  assert.deepEqual(challenge, {
    id: challengeId,
    factorId,
    userId: "fixture-user",
    expiresAt: challengeExpires * 1000,
  });
  const beforeInvalid = requests;
  for (const invalid of ["", "12345", "1234567", "abcdef"])
    await assert.rejects(
      client.verifyTotp(session, challenge, invalid),
      denied,
    );
  await assert.rejects(
    client.verifyTotp(
      session,
      { ...challenge, userId: "another-user" },
      "123456",
    ),
    denied,
  );
  await assert.rejects(
    client.verifyTotp(session, { ...challenge, expiresAt: clock }, "123456"),
    denied,
  );
  assert.equal(requests, beforeInvalid);
  factorStatus = "unverified";
  await assert.rejects(client.verifyTotp(session, challenge, "123456"), denied);
  factorStatus = "verified";
  assert.equal(verifications, 0);
  await assert.rejects(client.verifyTotp(session, challenge, "654321"), denied);
  const result = await client.verifyTotp(session, challenge, "123456");
  assert.equal(result.access_token === elevated, true);
  assert.equal((await client.verify(result, "aal2")).state, "verified");
  await assert.rejects(client.verifyTotp(session, challenge, "123456"), denied);
  assert.equal(verifications, 3);
  for (const badToken of [
    initial,
    await token("aal2", "another-user"),
    "not-a-jwt",
  ]) {
    consumed = false;
    issued = badToken;
    await assert.rejects(
      client.verifyTotp(session, challenge, "123456"),
      denied,
    );
  }
  consumed = false;
  issued = elevated;
  responseUser = "another-user";
  await assert.rejects(client.verifyTotp(session, challenge, "123456"), denied);
  responseUser = "fixture-user";
  const beforeExpiry = verifications;
  advanceOnLookup = 301000;
  await assert.rejects(client.verifyTotp(session, challenge, "123456"), denied);
  assert.equal(verifications, beforeExpiry);
  advanceOnLookup = 0;
  await assert.rejects(client.challengeTotp(session, factorId), denied);
  challengeExpires = Math.floor(clock / 1000) + 300;
  challengeType = "phone";
  await assert.rejects(client.challengeTotp(session, factorId), denied);
  controller.abort();
  const beforeAbort = requests;
  await assert.rejects(client.challengeTotp(session, factorId), denied);
  assert.equal(requests, beforeAbort);
});
