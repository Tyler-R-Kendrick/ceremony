import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
  registerAuthoredOperations,
  saveAuthoredAccountIntent,
  readAccountBrowser,
  authoredOauthKey,
  publicAuthoredIdentity,
  readAuthoredBlocker,
  authoredCeremonyKey,
  readPendingRegistration,
} from "../src/server/authored-operations.js";
import type {
  AuthorizationBrowser,
  AuthorizationBrowserInput,
} from "../src/server/browser-executor.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { hostedHttp } from "../src/server/hosted/http.js";
import { writeAuthoredApp } from "../src/server/authored-app.js";

async function fixture(
  registering = false,
  device = false,
  collision: false | "username-in-use" | "email-in-use" = false,
) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "owner",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const provider = "https://provider.example";
  const origin = "https://ceremony.example";
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
        manifest: { name: "Novel", methods: [] },
        definition: {},
        discovery: {
          origin: provider,
          issuer: provider,
          clientId: "fixture-client",
          authorizationEndpoint: `${provider}/authorize`,
          ...(device
            ? { deviceAuthorizationEndpoint: `${provider}/device` }
            : {}),
          tokenEndpoint: `${provider}/token`,
          userinfoEndpoint: `${provider}/userinfo`,
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
  const inputs: AuthorizationBrowserInput[] = [];
  let authorization: URL | undefined;
  let codeEntered = false;
  let tokenCalls = 0;
  let deviceCalls = 0;
  let tokenFailure = false;
  let signupProbes = 0;
  let closed = 0;
  let beforeCallback: (() => void) | undefined;
  let browserExpired = false;
  const account = {
    username: "chosen-account",
    email: "chosen@example.test",
    password: "synthetic-generated-password",
  };
  const browser: AuthorizationBrowser = {
    complete: async (input) => {
      inputs.push(input);
      if (!input.resumeSession) {
        authorization = new URL(input.startUrls?.at(-1) ?? input.startUrl);
        if (input.generateAccount) await input.vault?.stage?.(account);
      }
      if (!codeEntered)
        return {
          status: "blocked",
          reason: collision && input.generateAccount ? collision : "challenge",
          sessionPending: !collision && Boolean(input.sessionKey),
        };
      assert.equal(input.resumeSession, true);
      assert.equal(input.sessionKey, inputs[0]?.sessionKey);
      if (browserExpired)
        return { status: "blocked", reason: "session-expired" };
      assert.ok(authorization);
      const callback = new URL(input.redirectUri);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!,
      );
      if (registering) await input.vault?.put(account);
      beforeCallback?.();
      return { status: "callback", url: callback.href };
    },
    screenshot: async () => new Uint8Array([1, 2, 3]),
    interact: async (key, action) => {
      assert.equal(key, inputs[0]?.sessionKey);
      if ("code" in action && action.code === "123456") codeEntered = true;
      return true;
    },
    close: async () => {
      closed++;
    },
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, provider);
    if (url.pathname === "/device") {
      deviceCalls++;
      return Response.json({
        device_code: "fixture-device",
        user_code: "USER-CODE",
        verification_uri: `${provider}/activate`,
        expires_in: 600,
        interval: 5,
      });
    }
    if (url.pathname === "/token") {
      tokenCalls++;
      if (tokenFailure) throw new Error("Synthetic token response lost");
      const form = new URLSearchParams(String(init?.body));
      if (
        form.get("grant_type") ===
        "urn:ietf:params:oauth:grant-type:device_code"
      ) {
        assert.equal(form.get("device_code"), "fixture-device");
        if (tokenCalls === 1)
          return Response.json(
            { error: "authorization_pending" },
            { status: 400 },
          );
        return Response.json({
          access_token: "fixture-token",
          token_type: "Bearer",
        });
      }
      assert.equal(form.get("code"), "fixture-code");
      assert.equal(
        createHash("sha256")
          .update(form.get("code_verifier")!)
          .digest("base64url"),
        authorization?.searchParams.get("code_challenge"),
      );
      return Response.json({
        access_token: "fixture-token",
        token_type: "Bearer",
      });
    }
    if (url.pathname === "/userinfo")
      return Response.json({
        sub: "provider-subject",
        preferred_username: account.username,
        email: account.email,
        email_verified: true,
      });
    signupProbes++;
    return new Response("", { status: registering ? 200 : 404 });
  };
  const registry = new OperationRegistry(authoredVocabulary);
  registerAuthoredOperations(registry, { store, browser, fetch: fetcher });
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
        id: "auth",
        operationId: "authored.authorize-user",
        operationVersion: "1.0.0",
        dependsOn: ["app"],
        bindings: { app: { from: "output", node: "app", name: "app" } },
      },
    ],
    {},
  );
  await saveAuthoredAccountIntent(store, actor, run.id, {
    identifier: registering ? account.email : account.username,
    status: registering ? "available" : "existing",
  });
  if (device) {
    await store.transaction((tx) =>
      tx.put(authoredCeremonyKey(actor, run.id), { kind: "device" }, null),
    );
    // Both protocols must be usable, otherwise fallback masks a lost selection.
    await writeAuthoredApp(store, actor, run.id, {
      clientId: "fixture-client",
      redirectRegistered: true,
      flows: ["oauth-code", "device"],
    });
  }
  if (collision)
    await store.transaction((tx) =>
      tx.put(
        authoredCeremonyKey(actor, run.id),
        { kind: "account-registration" },
        null,
      ),
    );
  const advance = async (nodeId: string) => {
    const snapshot = await commands.snapshot(actor, run.id);
    await commands.advance(
      actor,
      run.id,
      nodeId,
      snapshot.revision,
      `advance:${snapshot.revision}`,
    );
  };
  await advance("app");
  await advance("auth");
  const context: OperationContext = {
    ...runContext,
    actor,
    runId: run.id,
    nodeId: "auth",
    commandId: "human",
    effectId: "human",
    signal: new AbortController().signal,
  };
  const humanUrl = `${origin}/api/v1/teaching/novel/${run.id}/human`;
  const handleHuman = async (request: Request) => {
    const record = await store.transaction((tx) =>
      tx.get<RunRecord>({ tenant: actor.tenantId, kind: "run", id: run.id }),
    );
    assert.ok(record);
    return authoredHuman(
      store,
      context,
      record,
      request,
      origin,
      () => advance("auth"),
      { connectorId: "novel", name: "Novel", browser, fetch: fetcher },
    );
  };
  const runtime = createTeachingRuntime({
    store,
    registry,
    origin,
    identity: { authenticate: async () => actor },
    authorize: async () => true,
    context: async () => runContext,
    human: async (_actor, _runId, request) => handleHuman(request),
  });
  return {
    store,
    actor,
    run,
    inputs,
    human: (init?: RequestInit, query = "") =>
      handleHuman(new Request(`${humanUrl}${query}`, init)),
    hosted: (init: RequestInit, url = humanUrl) =>
      hostedHttp(new Request(url, init), runtime, async () => {}),
    context,
    failToken: () => {
      tokenFailure = true;
    },
    beforeCallback: (callback: () => void) => {
      beforeCallback = callback;
    },
    expireBrowser: () => {
      browserExpired = true;
    },
    counts: () => ({ tokenCalls, signupProbes, closed, deviceCalls }),
    ticket: () =>
      store.transaction((tx) =>
        tx.get<Record<string, unknown>>(authoredOauthKey(actor, run.id)),
      ),
  };
}

for (const reason of ["username-in-use", "email-in-use"] as const)
  test(`OAuth registration ${reason} permits explicit existing-account fallback without re-registering`, async (t) => {
    const f = await fixture(true, false, reason);
    t.after(() => f.store.close());
    assert.equal(f.inputs[0]?.generateAccount, true);
    const html = await (await f.human()).text();
    assert.equal(html.includes("Choose another"), true);
    assert.equal(html.includes("Recover interrupted registration"), false);
    assert.equal(
      await readPendingRegistration(f.store, f.context, "novel"),
      undefined,
    );
    const response = await f.human({
      method: "POST",
      body: new URLSearchParams({
        username: "chosen@example.test",
        mode: "existing",
      }),
    });
    assert.equal(response.status, 303);
    assert.equal(f.inputs.length, 2);
    assert.notEqual(f.inputs[1]?.generateAccount, true);
    assert.equal(
      await publicAuthoredIdentity(f.store, f.actor, f.run.id),
      undefined,
    );
  });

test("selected device ceremony uses one bound device grant without starting an OAuth-code browser", async (t) => {
  const f = await fixture(false, true);
  t.after(() => f.store.close());
  assert.equal(f.inputs.length, 0);
  assert.equal(await f.ticket(), undefined);
  const page = await f.human();
  assert.equal(page.status, 200);
  assert.match(await page.text(), /USER-CODE/);
  assert.equal(f.counts().deviceCalls, 1);
  const ticket = await f.ticket();
  assert.equal(ticket?.value.deviceCode, "fixture-device");
  assert.equal(ticket?.value.verifier, undefined);
  await f.human();
  assert.equal(f.counts().tokenCalls, 0);
  for (let poll = 1; poll <= 2; poll++) {
    await f.store.transaction(async (tx) => {
      const key = authoredOauthKey(f.actor, f.run.id);
      const current = await tx.get<Record<string, unknown>>(key);
      assert.ok(current);
      await tx.put(key, { ...current.value, nextPoll: 0 }, current.revision);
    });
    assert.equal((await f.human()).status, poll === 1 ? 200 : 303);
  }
  assert.equal(f.counts().deviceCalls, 1);
  assert.equal(f.inputs.length, 0);
  assert.equal(await f.ticket(), undefined);
  assert.equal(
    (await publicAuthoredIdentity(f.store, f.actor, f.run.id))?.handle,
    "chosen-account",
  );
});

test("hosted human forms retain origin, size, and content-type boundaries", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const origin = f.context.origin;
  const form = {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: "action=browser&code=123456",
  };
  for (const headers of [
    { ...form.headers, origin: "https://foreign.example" },
    { "content-type": form.headers["content-type"] },
    { ...form.headers, "sec-fetch-site": "cross-site" },
  ])
    assert.equal((await f.hosted({ ...form, headers })).status, 403);
  for (const headers of [
    { ...form.headers, "content-type": "text/plain" },
    { ...form.headers, "content-length": "262145" },
  ])
    assert.equal((await f.hosted({ ...form, headers })).status, 400);
  assert.equal(
    (await f.hosted({ ...form, body: "x".repeat(16_385) })).status,
    400,
  );
  for (const path of [
    "/api/environment",
    "/api/auth/login",
    "/api/v1/teaching/runs",
  ])
    assert.equal((await f.hosted(form, `${origin}${path}`)).status, 400);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.counts().tokenCalls, 0);
  assert.equal((await f.hosted(form)).status, 303);
  assert.equal(f.inputs.length, 2);
  assert.equal(f.counts().tokenCalls, 1);
});

test("private sign-in credentials resume the existing OAuth attempt without another registration", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const ticket = await f.ticket();
  const response = await f.human({
    method: "POST",
    body: new URLSearchParams({
      username: "chosen-account",
      password: "synthetic-supplied-password",
    }),
  });
  assert.equal(response.status, 303);
  assert.equal(f.inputs.length, 2);
  assert.deepEqual(f.inputs[1]?.credentials, {
    username: "chosen-account",
    password: "synthetic-supplied-password",
  });
  assert.equal(f.inputs[1]?.resumeSession, true);
  assert.notEqual(f.inputs[1]?.generateAccount, true);
  assert.equal((await f.ticket())?.value.state, ticket?.value.state);
  assert.equal(f.counts().tokenCalls, 0);
});

for (const registering of [false, true])
  test(`isolated OAuth human challenge resumes the same browser and PKCE attempt (registration: ${registering})`, async (t) => {
    const f = await fixture(registering);
    t.after(() => f.store.close());
    assert.ok(f.inputs[0]?.sessionKey);
    assert.equal(
      (await readAccountBrowser(f.store, f.actor, f.run.id))?.pending,
      true,
    );
    const ticket = await f.ticket();
    assert.ok(ticket);
    const probes = f.counts().signupProbes;
    const response = await f.human();
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /browser is paused for your input/);
    assert.equal(html.includes("synthetic-generated-password"), false);
    assert.equal(html.includes(String(ticket.value.verifier)), false);
    assert.equal(f.inputs.length, 1);
    assert.equal((await f.ticket())?.value.state, ticket.value.state);
    const completed = await f.human({
      method: "POST",
      body: new URLSearchParams({ action: "browser", code: "123456" }),
    });
    assert.equal(completed.status, 303);
    assert.deepEqual(await publicAuthoredIdentity(f.store, f.actor, f.run.id), {
      handle: "chosen-account",
      did: "provider-subject",
    });
    assert.equal(f.inputs.length, 2);
    assert.equal(f.counts().tokenCalls, 1);
    assert.equal(f.counts().signupProbes, probes);
    assert.equal(await f.ticket(), undefined);
    assert.equal(
      (await readAccountBrowser(f.store, f.actor, f.run.id))?.pending,
      false,
    );
    assert.equal((await f.human()).status, 200);
    assert.equal(f.counts().tokenCalls, 1);
  });

for (const [field, value] of [
  ["subject", "other-owner"],
  ["actorSession", "other-session"],
  ["runId", "other-run"],
  ["nodeId", "other-node"],
  ["configurationVersion", "other-configuration"],
  ["session", "other-client"],
  ["redirectUri", "https://other.example/return"],
  ["expires", 1],
] as const)
  test(`isolated OAuth continuation rejects a stale ${field} without opening another browser`, async (t) => {
    const f = await fixture();
    t.after(() => f.store.close());
    const ticket = await f.ticket();
    assert.ok(ticket);
    await f.store.transaction((tx) =>
      tx.put(
        authoredOauthKey(f.actor, f.run.id),
        { ...ticket.value, [field]: value },
        ticket.revision,
      ),
    );
    await f.human({
      method: "POST",
      body: new URLSearchParams({ action: "browser", code: "123456" }),
    });
    assert.equal(f.inputs.length, 1);
    assert.equal(f.counts().tokenCalls, 0);
    assert.equal(
      await publicAuthoredIdentity(f.store, f.actor, f.run.id),
      undefined,
    );
    assert.equal(
      await readAuthoredBlocker(f.store, f.actor, f.run.id),
      "session-expired",
    );
    assert.equal(
      (await readAccountBrowser(f.store, f.actor, f.run.id))?.pending,
      false,
    );
    assert.ok(f.counts().closed > 0);
    const html = await (await f.human()).text();
    assert.match(html, /expired/);
    assert.equal(f.inputs.length, 1);
  });

test("a missing isolated authorization ticket cannot restart the browser", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const ticket = await f.ticket();
  assert.ok(ticket);
  await f.store.transaction((tx) =>
    tx.delete(authoredOauthKey(f.actor, f.run.id), ticket.revision),
  );
  await f.human({
    method: "POST",
    body: new URLSearchParams({ action: "browser", code: "123456" }),
  });
  assert.equal(f.inputs.length, 1);
  assert.equal(await f.ticket(), undefined);
  assert.equal(f.counts().tokenCalls, 0);
  assert.equal(
    await readAuthoredBlocker(f.store, f.actor, f.run.id),
    "session-expired",
  );
});

test("an isolated callback cannot be consumed through the native human return", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const ticket = await f.ticket();
  assert.ok(ticket);
  await assert.rejects(
    f.human(
      undefined,
      `?${new URLSearchParams({ code: "fixture-code", state: String(ticket.value.state) })}`,
    ),
    /denied/,
  );
  assert.equal((await f.ticket())?.revision, ticket.revision);
  assert.equal(f.counts().tokenCalls, 0);
  assert.equal(f.inputs.length, 1);
  assert.equal(
    (await readAccountBrowser(f.store, f.actor, f.run.id))?.pending,
    true,
  );
});

test("an uncertain isolated code exchange consumes the ticket and never replays on refresh", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.failToken();
  await f.human({
    method: "POST",
    body: new URLSearchParams({ action: "browser", code: "123456" }),
  });
  assert.equal(f.counts().tokenCalls, 1);
  assert.equal(await f.ticket(), undefined);
  assert.equal(
    await publicAuthoredIdentity(f.store, f.actor, f.run.id),
    undefined,
  );
  assert.equal(
    await readAuthoredBlocker(f.store, f.actor, f.run.id),
    "session-expired",
  );
  assert.match(await (await f.human()).text(), /expired/);
  assert.equal(f.inputs.length, 2);
  assert.equal(f.counts().tokenCalls, 1);
});

test("isolated continuation uses its issuer-bound discovery snapshot after installed metadata changes", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await f.store.transaction(async (tx) => {
    const key = {
      tenant: f.actor.tenantId,
      kind: "artifact" as const,
      id: "installed-connector:novel",
    };
    const installed = await tx.get<{ discovery: Record<string, unknown> }>(key);
    assert.ok(installed);
    await tx.put(
      key,
      {
        ...installed.value,
        discovery: {
          ...installed.value.discovery,
          tokenEndpoint: "https://other.example/token",
          userinfoEndpoint: "https://other.example/userinfo",
        },
      },
      installed.revision,
    );
  });
  await f.human({
    method: "POST",
    body: new URLSearchParams({ action: "browser", code: "123456" }),
  });
  assert.equal(
    (await publicAuthoredIdentity(f.store, f.actor, f.run.id))?.handle,
    "chosen-account",
  );
  assert.equal(f.counts().tokenCalls, 1);
});

for (const during of ["resume", "callback"] as const)
  test(`isolated authorization expires at the exact ${during} boundary`, async (t) => {
    const f = await fixture();
    t.after(() => f.store.close());
    const ticket = await f.ticket();
    assert.ok(ticket);
    const expires = Date.now() + 1000;
    await f.store.transaction((tx) =>
      tx.put(
        authoredOauthKey(f.actor, f.run.id),
        { ...ticket.value, expires },
        ticket.revision,
      ),
    );
    const elapse = () => {
      t.mock.method(Date, "now", () => expires);
    };
    if (during === "resume") elapse();
    else f.beforeCallback(elapse);
    await f.human({
      method: "POST",
      body: new URLSearchParams({ action: "browser", code: "123456" }),
    });
    assert.equal(f.counts().tokenCalls, 0);
    assert.equal(
      await publicAuthoredIdentity(f.store, f.actor, f.run.id),
      undefined,
    );
    assert.equal(
      await readAuthoredBlocker(f.store, f.actor, f.run.id),
      "session-expired",
    );
    assert.equal(f.inputs.length, during === "resume" ? 1 : 2);
  });

test("an expired isolated browser requires a new explicit attempt instead of replaying authorization", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.expireBrowser();
  await f.human({
    method: "POST",
    body: new URLSearchParams({ action: "browser", code: "123456" }),
  });
  assert.equal(f.inputs.length, 2);
  assert.equal(f.counts().tokenCalls, 0);
  assert.match(await (await f.human()).text(), /expired/);
  assert.equal(f.inputs.length, 2);
});
