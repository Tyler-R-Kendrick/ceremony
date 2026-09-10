import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { SignJWT, jwtVerify } from "jose";
import {
  supabaseAuth,
  SupabaseAuthFailure,
} from "../src/server/supabase-auth.js";

test("Supabase SDK signup waits for confirmation and verifies an actual issued JWT over HTTP", async (t) => {
  const signingKey = new TextEncoder().encode(
    "synthetic-signing-key-for-local-protocol-test",
  );
  let confirmed = false;
  let signups = 0;
  let signins = 0;
  let lookups = 0;
  let rejectLookup = false;
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ aal: "aal1" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("fixture-user")
    .setExpirationTime(now + 3600)
    .sign(signingKey);
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(
        body.email === "user@example.com" &&
          body.password === "synthetic-password",
        true,
      );
      if (req.url === "/auth/v1/signup") {
        signups++;
        res.end(
          JSON.stringify({
            id: "fixture-user",
            confirmation_sent_at: new Date().toISOString(),
          }),
        );
      } else {
        assert.equal(req.url, "/auth/v1/token?grant_type=password");
        signins++;
        if (!confirmed) {
          res.statusCode = 400;
          res.setHeader("x-supabase-api-version", "2024-01-01");
          res.end(
            JSON.stringify({
              code: "email_not_confirmed",
              msg: "private fixture diagnostic",
            }),
          );
        } else
          res.end(
            JSON.stringify({
              access_token: token,
              refresh_token: "synthetic-refresh",
              expires_at: now + 3600,
              expires_in: 3600,
              token_type: "bearer",
              user: { id: "fixture-user" },
            }),
          );
      }
    } else {
      assert.equal(req.url, "/auth/v1/user");
      lookups++;
      const jwt = req.headers.authorization?.slice("Bearer ".length) ?? "";
      await jwtVerify(jwt, signingKey, { algorithms: ["HS256"] });
      res.statusCode = rejectLookup ? 401 : 200;
      res.end(
        JSON.stringify(
          rejectLookup
            ? { message: "private fixture diagnostic" }
            : { id: "fixture-user" },
        ),
      );
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
  const client = supabaseAuth(
    {
      projectUrl: "https://synthetic.supabase.co",
      publishableKey: "sb_publishable_synthetic",
    },
    {
      signal: new AbortController().signal,
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
  const credentials = {
    email: "user@example.com",
    password: "synthetic-password",
  };
  assert.deepEqual(
    await client.authenticate({ ...credentials, action: "sign-up" }),
    { state: "confirmation-required" },
  );
  await assert.rejects(
    client.authenticate({ ...credentials, action: "sign-in" }),
    (error: unknown) =>
      error instanceof SupabaseAuthFailure &&
      error.code === "confirmation-required",
  );
  assert.equal(signups, 1);
  confirmed = true;
  const issued = await client.authenticate({
    ...credentials,
    action: "sign-in",
  });
  assert.equal(issued.state, "session");
  if (issued.state !== "session") throw new Error("Missing test session");
  assert.equal(lookups, 0);
  assert.deepEqual(await client.verify(issued.session), {
    state: "verified",
    userId: "fixture-user",
    assurance: "aal1",
  });
  assert.deepEqual(await client.verify(issued.session, "aal2"), {
    state: "mfa-required",
  });
  rejectLookup = true;
  await assert.rejects(
    client.verify(issued.session),
    (error: unknown) =>
      error instanceof SupabaseAuthFailure &&
      error.code === "verification-rejected" &&
      !error.message.includes("private"),
  );
  assert.equal(signups, 1);
  assert.equal(signins, 2);
  assert.equal(lookups, 3);
});

test("Supabase SDK boundary rejects privileged project keys, unsafe origins and malformed inputs before transport", async () => {
  let calls = 0;
  const options = {
    signal: new AbortController().signal,
    fetch: async () => {
      calls++;
      throw new Error("private diagnostic");
    },
  };
  const valid = {
    projectUrl: "https://synthetic.supabase.co",
    publishableKey: "sb_publishable_synthetic",
  };
  for (const project of [
    { ...valid, projectUrl: "http://synthetic.supabase.co" },
    { ...valid, projectUrl: "https://supabase.co.attacker.example" },
    { ...valid, projectUrl: "https://synthetic.supabase.co/path" },
    { ...valid, projectUrl: "https://user:password@synthetic.supabase.co" },
    { ...valid, publishableKey: "sb_secret_synthetic" },
    { ...valid, publishableKey: "not-a-key" },
  ])
    assert.throws(() => supabaseAuth(project, options), SupabaseAuthFailure);
  const client = supabaseAuth(valid, options);
  await assert.rejects(
    client.authenticate({
      action: "sign-up",
      email: "not-email",
      password: "synthetic",
    }),
    SupabaseAuthFailure,
  );
  assert.equal(calls, 0);
});

test("Supabase SDK distinguishes pending, issued, rejected and insufficient-assurance outcomes without private errors", async () => {
  const now = 2_000_000_000_000;
  const key = new TextEncoder().encode("synthetic-protocol-key");
  const jwt = (claims: Record<string, unknown>) =>
    new SignJWT({
      sub: "fixture-user",
      exp: now / 1000 + 3600,
      aal: "aal2",
      ...claims,
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(key);
  const token = await jwt({});
  const value = {
    access_token: token,
    refresh_token: "synthetic-refresh",
    expires_at: now / 1000 + 3600,
    expires_in: 3600,
    token_type: "bearer",
    user: { id: "fixture-user" },
  };
  const controller = new AbortController();
  let response: unknown = value;
  let status = 200;
  let failTransport = false;
  let calls = 0;
  const client = supabaseAuth(
    {
      projectUrl: "https://synthetic.supabase.co",
      publishableKey: "sb_publishable_synthetic",
    },
    {
      signal: controller.signal,
      now: () => now,
      fetch: async () => {
        calls++;
        if (failTransport) throw new Error("synthetic-private-error");
        return Response.json(response, { status });
      },
    },
  );
  const credentials = {
    email: "user@example.com",
    password: "synthetic-password",
  };
  assert.equal(
    (await client.authenticate({ ...credentials, action: "sign-up" })).state,
    "session",
  );
  response = { id: "fixture-user" };
  assert.deepEqual(await client.verify(value, "aal2"), {
    state: "verified",
    userId: "fixture-user",
    assurance: "aal2",
  });
  for (const changes of [
    { sub: "other" },
    { exp: now / 1000 },
    { exp: "invalid" },
    { aal: "unknown" },
  ]) {
    await assert.rejects(
      client.verify({ ...value, access_token: await jwt(changes) }),
      SupabaseAuthFailure,
    );
  }
  await assert.rejects(
    client.verify({ ...value, access_token: "malformed" }),
    SupabaseAuthFailure,
  );
  const previous = calls;
  await assert.rejects(
    Reflect.apply(client.verify, client, [value, "aal3"]),
    SupabaseAuthFailure,
  );
  await assert.rejects(
    client.verify({ ...value, expires_at: now / 1000 }),
    SupabaseAuthFailure,
  );
  assert.equal(calls, previous);
  response = { id: "other" };
  await assert.rejects(client.verify(value), SupabaseAuthFailure);
  status = 400;
  response = { code: "invalid_credentials", msg: "synthetic-private-error" };
  await assert.rejects(
    client.authenticate({ ...credentials, action: "sign-in" }),
    (error: unknown) =>
      error instanceof SupabaseAuthFailure &&
      error.code === "verification-rejected",
  );
  failTransport = true;
  await assert.rejects(
    client.authenticate({ ...credentials, action: "sign-in" }),
    (error: unknown) =>
      error instanceof SupabaseAuthFailure &&
      error.code === "provider-unavailable",
  );
  await assert.rejects(
    client.verify(value),
    (error: unknown) =>
      error instanceof SupabaseAuthFailure &&
      !error.message.includes("synthetic"),
  );
  controller.abort();
  const beforeAbort = calls;
  await assert.rejects(
    client.authenticate({ ...credentials, action: "sign-up" }),
    SupabaseAuthFailure,
  );
  assert.equal(calls, beforeAbort);
});
