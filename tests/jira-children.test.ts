import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { ProtectedCommandService } from "../src/server/commands.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  validateRecipe,
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/index.js";
import {
  AsyncJiraChildren,
  jiraConnectionRecipe,
  jiraManifest,
  jiraVocabulary,
} from "../src/server/teaching.js";
import type { JiraOAuthConfiguration } from "../src/server/jira-auth.js";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { teachingHttp } from "../src/server/teaching-http.js";

async function fixture(t: TestContext) {
  const token = randomBytes(32).toString("hex");
  const config: JiraOAuthConfiguration = {
    clientId: "fixture-client",
    clientSecret: randomBytes(32).toString("hex"),
    callbackUrl:
      "https://app.example/api/v1/teaching/jira/authorization-return",
    siteUrl: "https://fixture.atlassian.net",
    scopes: ["read:jira-user"],
  };
  const behavior = {
    configured: true,
    version: "v1",
    revoked: false,
    wrongSite: false,
    lost: false,
    accountId: "fixture-user",
    beforeUser: undefined as (() => Promise<void>) | undefined,
  };
  const effects = { exchanges: 0, sites: 0, users: 0 };
  const consumed = new Set<string>();
  const cloudId = "8594f221-9797-5f78-1fa4-485e198d7cd0";
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/oauth/token") {
      effects.exchanges++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(
        body.client_id === config.clientId &&
          body.client_secret === config.clientSecret,
        true,
      );
      assert.equal(body.redirect_uri, config.callbackUrl);
      assert.equal(req.method, "POST");
      if (consumed.has(body.code)) {
        res.statusCode = 400;
        res.end('{"error":"invalid_grant"}');
        return;
      }
      consumed.add(body.code);
      if (behavior.lost) {
        res.destroy();
        return;
      }
      res.end(
        JSON.stringify({
          access_token: token,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read:jira-user",
        }),
      );
      return;
    }
    assert.equal(
      req.headers.authorization === `Bearer ${token}`,
      true,
      "Only the provider transport receives the token",
    );
    assert.equal(req.method, "GET");
    if (req.url === "/oauth/token/accessible-resources") {
      effects.sites++;
      res.end(
        JSON.stringify([
          {
            id: cloudId,
            url: behavior.wrongSite
              ? "https://other.atlassian.net"
              : config.siteUrl,
            scopes: ["read:jira-user"],
          },
        ]),
      );
      return;
    }
    assert.equal(req.url, `/ex/jira/${cloudId}/rest/api/3/myself`);
    effects.users++;
    await behavior.beforeUser?.();
    if (behavior.revoked) {
      res.statusCode = 401;
      res.end('{"message":"private-provider-error"}');
      return;
    }
    res.end(
      JSON.stringify({
        accountId: behavior.accountId,
        active: true,
        accountType: "atlassian",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "alice",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const binding = {
    provider: "jira",
    profile: "jira-3lo",
    target: config.siteUrl,
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
  };
  const options = {
    configuration: async () => ({
      version: behavior.version,
      ...(behavior.configured ? { app: config } : {}),
    }),
    authorize: async () => {},
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
  const children = new AsyncJiraChildren(store, options);
  const registry = new OperationRegistry(jiraVocabulary);
  children.register(registry);
  const validated = await validateRecipe(
    jiraConnectionRecipe,
    registry,
    async () => {
      throw new Error("Unexpected child");
    },
  );
  assert.deepEqual(validated.diagnostics, []);
  const commands = new ProtectedCommandService(
    store,
    registry,
    async (actor, run) =>
      actor.subjectId === run.subjectId &&
      behavior.version === run.configurationVersion,
  );
  const create = async (principal = actor) =>
    commands.createRun(
      principal,
      binding,
      validated.leaves.map((node) => {
        assert.equal(node.use.kind, "operation");
        return {
          id: node.id,
          operationId: node.use.id,
          operationVersion: node.use.version,
          dependsOn: node.dependsOn,
          bindings: node.bindings,
        };
      }),
      {},
    );
  const context = (
    runId: string,
    nodeId = "session",
    principal = actor,
  ): OperationContext => ({
    actor: principal,
    ...binding,
    runId,
    nodeId,
    commandId: "human",
    effectId: "human",
    signal: AbortSignal.timeout(30000),
  });
  const advance = async (runId: string, nodeId: string, principal = actor) =>
    commands.advance(
      principal,
      runId,
      nodeId,
      (await commands.snapshot(principal, runId)).revision,
      `step:${randomUUID()}`,
    );
  const callback = async (runId: string) => {
    const url = new URL(await children.authorization.humanUrl(context(runId)));
    return new URL(
      `${config.callbackUrl}?state=${url.searchParams.get("state")}&code=${randomUUID()}`,
    );
  };
  return {
    store,
    actor,
    children,
    registry,
    commands,
    create,
    advance,
    context,
    callback,
    effects,
    behavior,
    token,
    config,
    fetch: options.fetch,
  };
}

for (const configured of [true, false])
  test(`Jira mounted handlers preserve the parent through ${configured ? "shared configuration" : "private owner setup"} and provider verification`, async (t) => {
    const f = await fixture(t);
    f.actor.capabilities.push("admin");
    f.behavior.configured = configured;
    let actor = f.actor;
    const runtime = createGitHubRuntime({
      store: f.store,
      identity: { authenticate: async () => actor },
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "v1",
      authorize: async (actor, run) => actor.subjectId === run.subjectId,
      jira: {
        configuration: async () => ({
          version: f.behavior.version,
          siteUrl: f.config.siteUrl,
          ...(f.behavior.configured
            ? {
                clientId: f.config.clientId,
                clientSecret: f.config.clientSecret,
              }
            : {}),
        }),
        fetch: f.fetch,
      },
    });
    const request = (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      teachingHttp(
        new Request(`https://app.example/api/v1/teaching${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: "https://app.example",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        runtime,
      );
    const started = await request("/runs", { connectorId: "jira" });
    assert.equal(started.status, 200);
    const run = await started.json();
    assert.equal(run.status, "active");
    const path = `/jira/${run.id}/human`;
    assert.deepEqual(f.effects, { exchanges: 0, sites: 0, users: 0 });
    if (!configured) {
      const page = await request(path);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("cache-control"), "no-store");
      const html = await page.text();
      assert.equal(html.includes("Configure Jira for this session"), true);
      assert.equal(html.includes("Set up the shared Jira integration"), false);
      assert.equal(html.includes(f.config.clientSecret), false);
      actor = { ...f.actor, capabilities: ["executor"] };
      const nonOwner = await request(path);
      assert.equal(
        (await nonOwner.text()).includes('name="clientSecret"'),
        false,
      );
      actor = f.actor;
      const admission = await (
        await request(path, undefined, { accept: "application/json" })
      ).json();
      const body = {
        ticket: admission.ticket,
        values: {
          clientId: f.config.clientId,
          clientSecret: f.config.clientSecret,
        },
      };
      actor = { ...f.actor, sessionId: "other-session" };
      assert.equal((await request(path)).status, 403);
      assert.equal((await request(path, body)).status, 403);
      actor = f.actor;
      assert.equal(
        (
          await request(path, {
            ...body,
            values: { ...body.values, scopes: ["admin"] },
          })
        ).status,
        400,
      );
      const saved = await request(path, body);
      assert.equal(saved.status, 200);
      assert.equal((await request(path, body)).status, 403);
      assert.equal(
        (await runtime.commands.snapshot(actor, run.id)).nodes[0]!.verified,
        true,
      );
      assert.equal(f.effects.exchanges, 0);
    }
    const handoff = await request(path);
    assert.equal(handoff.status, 303);
    const authorization = new URL(handoff.headers.get("location")!);
    assert.equal(authorization.origin, "https://auth.atlassian.com");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      f.config.callbackUrl,
    );
    const callback = `/jira/authorization-return?state=${authorization.searchParams.get("state")}&code=${randomUUID()}`;
    const site = f.config.siteUrl;
    f.config.siteUrl = "https://other.atlassian.net";
    assert.equal((await request(callback)).status, 403);
    assert.equal(f.effects.exchanges, 0);
    f.config.siteUrl = site;
    actor = { ...f.actor, subjectId: "other" };
    assert.equal((await request(callback)).status, 403);
    assert.equal(f.effects.exchanges, 0);
    actor = f.actor;
    const returned = await request(callback);
    assert.equal(returned.status, 303);
    const destination = new URL(returned.headers.get("location")!);
    assert.equal(destination.searchParams.get("teachingRun"), run.id);
    assert.equal(destination.searchParams.get("connector"), "jira");
    assert.equal(
      (await runtime.commands.snapshot(actor, run.id)).status,
      "complete",
    );
    assert.deepEqual(f.effects, { exchanges: 1, sites: 1, users: 1 });
    assert.equal((await request(callback)).status, 403);
    assert.equal((await request(path)).status, 403);
    assert.equal(f.effects.exchanges, 1);
    // A restored subject in a new login must not inherit a prior session's private setup or consent.
    actor = { ...f.actor, sessionId: "fresh-login" };
    const fresh = await request("/runs", { connectorId: "jira" });
    assert.equal(fresh.status, 200);
    const freshRun = await fresh.json();
    assert.notEqual(freshRun.id, run.id);
    assert.equal(freshRun.status, "active");
    assert.equal(freshRun.nodes[configured ? 1 : 0].state, "awaiting-human");
    assert.equal(
      (await request(`/jira/${freshRun.id}/human`)).status,
      configured ? 303 : 200,
    );
    assert.equal(f.effects.exchanges, 1);
    actor = f.actor;
    assert.equal(
      (await runtime.commands.snapshot(actor, run.id)).status,
      "complete",
    );
  });

test("Jira composes shared app, private OAuth receipt and fresh site-bound access through real HTTP", async (t) => {
  const f = await fixture(t);
  const run = await f.create();
  await assert.rejects(f.advance(run.id, "session"));
  await assert.rejects(f.advance(run.id, "access"));
  await f.advance(run.id, "app");
  await f.advance(run.id, "session");
  assert.equal(f.effects.exchanges, 0);
  const callback = await f.callback(run.id);
  await f.children.authorization.acceptCallback(f.context(run.id), callback);
  assert.equal(f.effects.exchanges, 0);
  await f.advance(run.id, "session");
  assert.equal(f.effects.exchanges, 1);
  assert.equal((await f.commands.snapshot(f.actor, run.id)).status, "active");
  await f.advance(run.id, "access");
  assert.deepEqual(f.effects, { exchanges: 1, sites: 1, users: 1 });
  assert.equal(
    jiraManifest.methods[0]!.contract!.completion.verifier,
    f.registry.require("jira.verify-access", "1.0.0").contract.verifier,
    "The manifest must name the verifier that accepts current-user evidence",
  );
  assert.equal((await f.commands.snapshot(f.actor, run.id)).status, "complete");
  await f.commands.snapshot(f.actor, run.id);
  assert.equal(f.effects.users, 1, "Pure snapshot must not poll the provider");
  await f.commands.revalidate(f.actor, run.id);
  assert.equal(f.effects.users, 2, "Explicit reuse verifies access afresh");
  const again = await f.create();
  for (const node of ["app", "session", "access"])
    await f.advance(again.id, node);
  assert.equal(
    f.effects.exchanges,
    1,
    "A compatible private session needs no new consent",
  );
  assert.equal(f.effects.users, 3);
  const other = { ...f.actor, subjectId: "bob", sessionId: "other-session" };
  const foreign = await f.create(other);
  await f.advance(foreign.id, "app", other);
  await f.advance(foreign.id, "session", other);
  assert.equal(
    (await f.commands.snapshot(other, foreign.id)).nodes[1]!.state,
    "awaiting-human",
  );
  const publicRecords = await f.store.transaction(async (tx) => ({
    events: await tx.list(f.actor.tenantId, "event"),
    audit: await tx.list(f.actor.tenantId, "audit"),
  }));
  for (const value of [
    f.token,
    f.config.clientSecret,
    callback.searchParams.get("state")!,
    callback.searchParams.get("code")!,
  ])
    assert.equal(
      JSON.stringify(publicRecords).includes(value),
      false,
      "Protocol material cannot enter the semantic ledger",
    );
});

test("Jira missing owner configuration blocks downstream operations and fabricated handler invocations", async (t) => {
  const f = await fixture(t);
  f.behavior.configured = false;
  const run = await f.create();
  await f.advance(run.id, "app");
  assert.equal(
    (await f.commands.snapshot(f.actor, run.id)).nodes[0]!.state,
    "awaiting-human",
  );
  await assert.rejects(f.advance(run.id, "session"));
  await assert.rejects(f.children.authorization.humanUrl(f.context(run.id)));
  const forged = await f.registry
    .require("jira.verify-access", "1.0.0")
    .handler(f.context(run.id, "access"), {});
  assert.equal(forged.state, "failed");
  assert.deepEqual(f.effects, { exchanges: 0, sites: 0, users: 0 });
});

test("Jira wrong site and revoked or switched accounts cannot produce reusable access", async (t) => {
  const f = await fixture(t);
  const run = await f.create();
  await f.advance(run.id, "app");
  await f.advance(run.id, "session");
  await f.children.authorization.acceptCallback(
    f.context(run.id),
    await f.callback(run.id),
  );
  await f.advance(run.id, "session");
  f.behavior.wrongSite = true;
  await f.advance(run.id, "access");
  assert.equal((await f.commands.snapshot(f.actor, run.id)).status, "active");
  assert.equal(f.effects.users, 0);
  f.behavior.wrongSite = false;
  await f.advance(run.id, "access");
  assert.equal((await f.commands.snapshot(f.actor, run.id)).status, "complete");
  f.behavior.accountId = "another-user";
  await f.commands.revalidate(f.actor, run.id);
  assert.equal((await f.commands.snapshot(f.actor, run.id)).status, "active");
  f.behavior.accountId = "fixture-user";
  f.behavior.revoked = true;
  await f.advance(run.id, "access");
  assert.equal(
    (await f.commands.snapshot(f.actor, run.id)).nodes[2]!.verified,
    false,
  );
  f.behavior.version = "v2";
  await assert.rejects(f.advance(run.id, "access"));
});

test("Jira code-response loss remains uncertain and never silently creates another authorization attempt", async (t) => {
  const f = await fixture(t);
  const run = await f.create();
  await f.advance(run.id, "app");
  await f.advance(run.id, "session");
  await f.children.authorization.acceptCallback(
    f.context(run.id),
    await f.callback(run.id),
  );
  f.behavior.lost = true;
  await f.advance(run.id, "session");
  assert.equal(
    (await f.commands.snapshot(f.actor, run.id)).nodes[1]!.state,
    "uncertain",
  );
  await assert.rejects(f.advance(run.id, "session"));
  await assert.rejects(f.advance(run.id, "access"));
  assert.equal(f.effects.exchanges, 1);
});

test("Jira owner setup is a private prerequisite in the same parent, never an account or access assertion", async (t) => {
  const f = await fixture(t);
  f.behavior.configured = false;
  const owner: ActorContext = {
    ...f.actor,
    capabilities: ["executor", "admin"],
  };
  const run = await f.create(owner);
  await f.advance(run.id, "app", owner);
  const revision = (await f.commands.snapshot(owner, run.id)).revision;
  const context = f.context(run.id, "app", owner);
  const input = {
    clientId: f.config.clientId,
    clientSecret: f.config.clientSecret,
  };
  await assert.rejects(
    f.children.configureApp(
      { ...context, actor: { ...owner, actorKind: "agent" } },
      revision,
      input,
    ),
    { code: "denied" },
  );
  await assert.rejects(
    f.children.configureApp({ ...context, actor: f.actor }, revision, input),
    { code: "denied" },
  );
  await assert.rejects(
    f.children.configureApp(context, revision, { ...input, scopes: ["admin"] }),
  );
  for (const patch of [
    { target: "https://other.atlassian.net" },
    { origin: "https://other.example" },
  ])
    await assert.rejects(
      f.children.configureApp({ ...context, ...patch }, revision, input),
      { code: "denied" },
    );
  await assert.rejects(f.children.configureApp(context, revision - 1, input));
  assert.equal(
    (await f.store.transaction((tx) => tx.list(owner.tenantId, "artifact")))
      .length,
    0,
  );
  await f.children.configureApp(context, revision, input);
  assert.equal(
    (await f.commands.snapshot(owner, run.id)).nodes[0]!.verified,
    false,
  );
  assert.deepEqual(f.effects, { exchanges: 0, sites: 0, users: 0 });
  await assert.rejects(f.children.configureApp(context, revision, input));
  await f.advance(run.id, "app", owner);
  await f.advance(run.id, "session", owner);
  const sessionContext = f.context(run.id, "session", owner);
  const authUrl = new URL(
    await f.children.authorization.humanUrl(sessionContext),
  );
  const callback = new URL(
    `${f.config.callbackUrl}?state=${authUrl.searchParams.get("state")}&code=${randomUUID()}`,
  );
  await f.children.authorization.acceptCallback(sessionContext, callback);
  await f.advance(run.id, "session", owner);
  await f.advance(run.id, "access", owner);
  assert.equal((await f.commands.snapshot(owner, run.id)).status, "complete");
  assert.deepEqual(f.effects, { exchanges: 1, sites: 1, users: 1 });
  const ledger = await f.store.transaction(async (tx) => ({
    events: await tx.list(owner.tenantId, "event"),
    audit: await tx.list(owner.tenantId, "audit"),
  }));
  assert.equal(JSON.stringify(ledger).includes(f.config.clientSecret), false);
});

test("Jira verification rejects foreign context, missing evidence and expired artifacts", async (t) => {
  const f = await fixture(t);
  const run = await f.create();
  await f.advance(run.id, "app");
  const operation = f.registry.require("jira.prepare-app", "1.0.0");
  const artifacts = await f.store.transaction((tx) =>
    tx.list<Record<string, unknown>>(f.actor.tenantId, "artifact"),
  );
  assert.equal(artifacts.length, 1);
  const app = artifacts[0]!;
  const result = { state: "complete" as const, outputs: { app: app.id } };
  const context = f.context(run.id, "app");
  assert.equal(await operation.verify!(context, result), true);
  assert.equal(
    await operation.verify!(context, { state: "awaiting-human", outputs: {} }),
    false,
  );
  for (const patch of [
    { runId: "missing-run" },
    { target: "https://other.atlassian.net" },
    { origin: "https://other.example" },
    { environment: "production" },
    { configurationVersion: "v2" },
    { actor: { ...f.actor, subjectId: "other" } },
    { actor: { ...f.actor, sessionId: "other" } },
    { actor: { ...f.actor, tenantId: "other" } },
    { signal: AbortSignal.abort() },
  ])
    await assert.rejects(operation.verify!({ ...context, ...patch }, result));
  await assert.rejects(
    operation.verify!(context, {
      state: "complete",
      outputs: { app: `jira:app:${"0".repeat(64)}` },
    }),
  );
  f.behavior.version = "v2";
  await assert.rejects(operation.verify!(context, result));
  f.behavior.version = "v1";
  const originalCallback = f.config.callbackUrl;
  f.config.callbackUrl = "https://other.example/callback";
  await assert.rejects(operation.verify!(context, result));
  f.config.callbackUrl = originalCallback;
  const originalSite = f.config.siteUrl;
  f.config.siteUrl = "https://other.atlassian.net";
  await assert.rejects(operation.verify!(context, result));
  f.config.siteUrl = originalSite;
  const key = {
    tenant: f.actor.tenantId,
    kind: "artifact" as const,
    id: app.id,
  };
  await f.store.transaction(async (tx) => {
    await tx.put(key, { ...app.value, expires: await tx.now() }, app.revision);
  });
  assert.equal(await operation.verify!(context, result), false);
  await f.store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(
      key,
      { ...app.value, scope: "0".repeat(64) },
      current!.revision,
    );
  });
  assert.equal(await operation.verify!(context, result), false);
  assert.deepEqual(f.effects, { exchanges: 0, sites: 0, users: 0 });
});

test("Jira token and connection verifiers require their distinct protected evidence", async (t) => {
  const f = await fixture(t);
  const run = await f.create();
  await f.advance(run.id, "app");
  await f.advance(run.id, "session");
  await f.children.authorization.acceptCallback(
    f.context(run.id),
    await f.callback(run.id),
  );
  await f.advance(run.id, "session");
  await f.advance(run.id, "access");
  for (const [kind, node, operationId, omitted] of [
    ["session", "session", "jira.authorize-user", "session"],
    ["connection", "access", "jira.verify-access", "accountId"],
    ["connection", "access", "jira.verify-access", "cloudId"],
    ["connection", "access", "jira.verify-access", "session"],
  ] as const) {
    const record = (
      await f.store.transaction((tx) =>
        tx.list<Record<string, unknown>>(f.actor.tenantId, "artifact"),
      )
    ).find((record) => record.id.startsWith(`jira:${kind}:`))!;
    const key = {
      tenant: f.actor.tenantId,
      kind: "artifact" as const,
      id: record.id,
    };
    const changed = { ...record.value };
    delete changed[omitted];
    await f.store.transaction((tx) => tx.put(key, changed, record.revision));
    assert.equal(
      await f.registry.require(operationId, "1.0.0").verify!(
        f.context(run.id, node),
        { state: "complete", outputs: { [kind]: record.id } },
      ),
      false,
    );
    await f.store.transaction(async (tx) => {
      const current = await tx.get(key);
      await tx.put(key, record.value, current!.revision);
    });
  }
  assert.deepEqual(f.effects, { exchanges: 1, sites: 1, users: 1 });
});

test("Jira superseded workers cannot persist reusable access after a provider response", async (t) => {
  const f = await fixture(t);
  const run = await f.create();
  await f.advance(run.id, "app");
  await f.advance(run.id, "session");
  await f.children.authorization.acceptCallback(
    f.context(run.id),
    await f.callback(run.id),
  );
  await f.advance(run.id, "session");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.behavior.beforeUser = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.advance(run.id, "access");
  const rejected = assert.rejects(pending);
  const timeout = setTimeout(
    () => entered.reject(new Error("Provider was not reached")),
    5000,
  );
  try {
    await entered.promise;
    await f.store.transaction(async (tx) => {
      const key = {
        tenant: f.actor.tenantId,
        kind: "run" as const,
        id: run.id,
      };
      await tx.cancel(key);
      await tx.claim(key, "replacement-worker", 60000);
    });
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await rejected;
  }
  const artifacts = await f.store.transaction((tx) =>
    tx.list(f.actor.tenantId, "artifact"),
  );
  assert.equal(
    artifacts.some((record) => record.id.startsWith("jira:connection:")),
    false,
    "A superseded result must not become an artifact reusable by another parent",
  );
  assert.equal(
    (await f.commands.snapshot(f.actor, run.id)).nodes[2]!.verified,
    false,
  );
});
