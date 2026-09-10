import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  jiraAuth,
  JiraAuthFailure,
  type JiraOAuthConfiguration,
} from "../src/server/jira-auth.js";

const configuration: JiraOAuthConfiguration = {
  clientId: "fixture-client",
  clientSecret: "fixture-client-secret",
  callbackUrl: "https://app.example/jira/callback",
  siteUrl: "https://fixture.atlassian.net",
  scopes: ["read:jira-user"],
};
const state = "synthetic-state-bound-to-private-run-12345";
const cloudId = "8594f221-9797-5f78-1fa4-485e198d7cd0";
const rejected = (error: unknown) =>
  error instanceof JiraAuthFailure &&
  error.code === "verification-rejected" &&
  !error.message.includes("private-canary");

test("Jira 3LO uses SDK state validation, JSON code exchange and site-bound identity HTTP verification", async (t) => {
  const network = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new URL(String(input)).hostname, "127.0.0.1");
      return network(input, init);
    },
  );
  let mode = "valid",
    exchanges = 0,
    reads = 0,
    users = 0;
  const consumed = new Set<string>();
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/oauth/token") {
      exchanges++;
      assert.equal(req.method, "POST");
      assert.equal(req.headers["content-type"], "application/json");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(
        JSON.stringify(body) ===
          JSON.stringify({
            redirect_uri: configuration.callbackUrl,
            code: body.code,
            grant_type: "authorization_code",
            client_id: configuration.clientId,
            client_secret: configuration.clientSecret,
          }),
        true,
      );
      assert.match(body.code, /^one-use-code(?:-[a-z]+)?$/);
      if (consumed.has(body.code)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      consumed.add(body.code);
      if (mode === "lost") {
        res.destroy();
        return;
      }
      res.end(
        JSON.stringify({
          access_token: "fixture-access",
          token_type: mode === "badtype" ? "invalid" : "Bearer",
          expires_in: mode === "badexpiry" ? 0 : 3600,
          scope:
            mode === "broader" || mode === "allscopes"
              ? "read:jira-user read:jira-work"
              : "read:jira-user",
        }),
      );
      return;
    }
    assert.equal(req.headers.authorization === "Bearer fixture-access", true);
    if (mode === "unavailable" || mode === "denied") {
      res.statusCode = mode === "denied" ? 401 : 503;
      res.end(JSON.stringify({ message: "private-canary" }));
      return;
    }
    if (mode === "oversized") {
      res.end(JSON.stringify({ content: "x".repeat(65536) }));
      return;
    }
    if (req.url === "/oauth/token/accessible-resources") {
      reads++;
      const resource = {
        id: cloudId,
        url: configuration.siteUrl,
        scopes: [
          mode === "missing-scope"
            ? "read:confluence-content.all"
            : "read:jira-user",
          ...(mode === "allscopes" ? ["read:jira-work"] : []),
        ],
        name: "private-canary",
        avatarUrl: "https://private.example",
      };
      res.end(
        JSON.stringify(
          mode === "wrong-site"
            ? [{ ...resource, url: "https://other.atlassian.net" }]
            : mode === "ambiguous"
              ? [
                  resource,
                  { ...resource, id: "1324a887-45db-1bf4-1e99-ef0ff456d421" },
                ]
              : [resource],
        ),
      );
      return;
    }
    assert.equal(req.url, `/ex/jira/${cloudId}/rest/api/3/myself`);
    users++;
    res.end(
      JSON.stringify({
        accountId:
          mode === "unknown"
            ? "unknown"
            : mode === "wrong-account"
              ? "other"
              : "fixture-user",
        active: mode !== "inactive",
        accountType: mode === "app" ? "app" : "atlassian",
        displayName: "private-canary",
        emailAddress: "private-canary",
      }),
    );
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
  let now = Date.now();
  const options: Parameters<typeof jiraAuth>[1] = {
    signal: controller.signal,
    now: () => now,
    fetch: (input, init) => {
      const url = new URL(String(input));
      assert.ok(
        ["https://auth.atlassian.com", "https://api.atlassian.com"].includes(
          url.origin,
        ),
      );
      assert.equal(init?.redirect, "error");
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
    },
  };
  const client = jiraAuth(configuration, options);
  const authorization = new URL(client.authorizationUrl(state));
  assert.equal(authorization.origin, "https://auth.atlassian.com");
  assert.equal(authorization.searchParams.get("audience"), "api.atlassian.com");
  assert.equal(authorization.searchParams.get("prompt"), "consent");
  assert.equal(authorization.searchParams.get("scope"), "read:jira-user");
  assert.equal(authorization.href.includes(configuration.clientSecret), false);
  const callback = `${configuration.callbackUrl}?state=${state}&code=one-use-code`;
  for (const url of [
    callback.replace("app.example", "foreign.example"),
    callback.replace("/jira/callback", "/other"),
    callback.replace(state, "foreign-state"),
    `${callback}&state=${state}`,
    `${callback}#private-canary`,
    `${callback}&padding=${"x".repeat(8192)}`,
    callback.replace("one-use-code", "invalid%0Acode"),
    `${configuration.callbackUrl}?state=${state}&error=access_denied`,
  ]) {
    assert.throws(() => client.validateCallback(url, state), rejected);
    await assert.rejects(client.exchange(url, state), rejected);
  }
  client.validateCallback(callback, state);
  assert.equal(exchanges, 0);
  const session = await client.exchange(callback, state);
  assert.equal(exchanges, 1);
  await assert.rejects(client.exchange(callback, state), rejected);
  const verified = await client.verify(session, "fixture-user");
  assert.deepEqual(verified, {
    cloudId,
    accountId: "fixture-user",
    expiresAt: session.expiresAt,
  });
  assert.equal(JSON.stringify(verified).includes("private-canary"), false);
  assert.equal(reads, 1);
  assert.equal(users, 1);
  assert.deepEqual(await client.verify(session), verified);
  const twoScopes = jiraAuth(
    { ...configuration, scopes: ["read:jira-user", "read:jira-work"] },
    options,
  );
  const beforePartial: number = users;
  await assert.rejects(
    twoScopes.verify({
      ...session,
      scopes: ["read:jira-user", "read:jira-work"],
    }),
    rejected,
  );
  assert.equal(users, beforePartial);
  mode = "allscopes";
  const fullSession = await twoScopes.exchange(`${callback}-allscopes`, state);
  assert.equal((await twoScopes.verify(fullSession)).accountId, "fixture-user");
  mode = "valid";
  for (mode of ["wrong-site", "missing-scope", "ambiguous"]) {
    const before: number = users;
    await assert.rejects(client.verify(session), rejected);
    assert.equal(users, before);
  }
  for (mode of ["wrong-account", "inactive", "app", "denied"])
    await assert.rejects(client.verify(session, "fixture-user"), rejected);
  mode = "unknown";
  await assert.rejects(client.verify(session), rejected);
  for (mode of ["broader", "badtype", "badexpiry"])
    await assert.rejects(
      client.exchange(`${callback}-${mode}`, state),
      rejected,
    );
  for (mode of ["unavailable", "oversized"])
    await assert.rejects(
      client.verify(session),
      (error: unknown) =>
        error instanceof JiraAuthFailure &&
        error.code === "provider-unavailable",
    );
  mode = "lost";
  await assert.rejects(
    client.exchange(`${callback}-lost`, state),
    (error: unknown) =>
      error instanceof JiraAuthFailure && error.code === "provider-unavailable",
  );
  const before: number = reads;
  now = session.expiresAt;
  await assert.rejects(client.verify(session), rejected);
  assert.equal(reads, before);
});

test("Jira configuration rejects untrusted origins, ambiguous scopes and weak state before any provider request", () => {
  for (const change of [
    { siteUrl: "http://fixture.atlassian.net" },
    { siteUrl: "https://fixture.atlassian.net.evil.example" },
    { callbackUrl: "http://app.example/callback" },
    { callbackUrl: "https://app.example/callback?redirect=evil" },
    { callbackUrl: "https://user:password@app.example/callback" },
    { scopes: ["read:jira-user", "read:jira-user"] },
    { scopes: ["write:jira-work"] },
    { clientSecret: "private\ncanary" },
  ])
    assert.throws(
      () =>
        jiraAuth({ ...configuration, ...change } as JiraOAuthConfiguration, {
          signal: new AbortController().signal,
        }),
      (e: unknown) =>
        e instanceof JiraAuthFailure && e.code === "invalid-input",
    );
  const client = jiraAuth(configuration, {
    signal: new AbortController().signal,
  });
  assert.throws(() => client.authorizationUrl("weak"), /invalid-input/);
  const local = jiraAuth(
    { ...configuration, callbackUrl: "http://127.0.0.1:4173/callback" },
    {
      signal: new AbortController().signal,
      allowLoopbackHttp: true,
    },
  );
  assert.equal(
    new URL(local.authorizationUrl(state)).searchParams.get("redirect_uri"),
    "http://127.0.0.1:4173/callback",
  );
});
