import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createHostedRuntime,
  hostedRunPolicy,
  type HostedRuntime,
} from "../src/server/hosted/runtime.js";
import { createHostedMcp } from "../src/server/hosted/mcp.js";
import { hostedHttp } from "../src/server/hosted/http.js";
import { HostedTenancy } from "../src/server/hosted/tenancy.js";
import { AsyncCeremonyEnvironment } from "../src/server/async-environment.js";
import { SubscriptionRegistry } from "../src/server/connectors/events/subscriptions.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RunRecord } from "../src/server/commands.js";
import { postgresFixture } from "./fixtures/postgres.js";
import { teachingIdentityFixture } from "./fixtures/teaching-identity.js";
import {
  receiverBinding,
  signStandardWebhook,
  SECRET,
} from "./connectors/events/helpers.js";

/*
 * The hosted deployment as a multi-tenant platform: connector routes and
 * tools mounted over the same PostgreSQL store, tenant and roles taken from
 * signed claims, GitHub optional, and provider deliveries accepted only when
 * the operator enabled them. Everything runs against a real PostgreSQL server
 * and a local signed OIDC issuer; nothing reaches a provider.
 */

let database: Awaited<ReturnType<typeof postgresFixture>>;
let provider: Awaited<ReturnType<typeof teachingIdentityFixture>>;
const origin = "http://127.0.0.1:4199";
const opened: HostedRuntime[] = [];
// One key for the module: every runtime here shares one database.
const vaultKey = randomBytes(32).toString("hex");

before(async () => {
  database = await postgresFixture();
  provider = await teachingIdentityFixture();
});
after(async () => {
  for (const runtime of opened) await runtime.store.close();
  await provider.close();
  await database.close();
});

function environment(extra: Record<string, string | undefined> = {}) {
  const cfg = database.config;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    CEREMONY_TEST_PROFILE: "true",
    CEREMONY_PUBLIC_ORIGIN: origin,
    CEREMONY_DATABASE_URL: `postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}`,
    CEREMONY_VAULT_KEY: vaultKey,
    CEREMONY_VAULT_KEY_ID: "test",
    CEREMONY_OIDC_ISSUER: provider.issuer,
    CEREMONY_OIDC_CLIENT_ID: "client",
    CEREMONY_CONFIGURATION_VERSION: "v1",
  };
  for (const [name, value] of Object.entries(extra))
    if (value === undefined) delete env[name];
    else env[name] = value;
  return env;
}

async function hosted(env: NodeJS.ProcessEnv) {
  const runtime = await createHostedRuntime(env);
  opened.push(runtime);
  return runtime;
}

const serve = (runtime: HostedRuntime, request: Request) =>
  hostedHttp(
    request,
    runtime,
    async () => {},
    undefined,
    undefined,
    runtime.hosted.connectors?.runtime.http,
  );

/** Signs in through the mounted routes with whatever claims the issuer now carries. */
async function signIn(
  runtime: HostedRuntime,
  claims: Record<string, unknown>,
): Promise<{ actor: ActorContext | null; cookie?: string; status: number }> {
  provider.setClaims(claims);
  const begun = await serve(
    runtime,
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(begun.status, 200);
  const approved = await fetch((await begun.json()).authorizationUrl, {
    redirect: "manual",
  });
  const callback = await serve(
    runtime,
    new Request(approved.headers.get("location")!, {
      headers: { cookie: begun.headers.getSetCookie()[0]!.split(";")[0]! },
    }),
  );
  if (callback.status !== 303) return { actor: null, status: callback.status };
  const cookie = callback.headers.getSetCookie()[0]!.split(";")[0]!;
  return {
    actor: await runtime.identity.authenticate(
      new Request(origin, { headers: { cookie } }),
    ),
    cookie,
    status: callback.status,
  };
}

test("hosted starts without a GitHub account and then simply does not offer GitHub", async () => {
  const runtime = await hosted(environment({ CEREMONY_TENANT_ID: "tenant" }));
  assert.ok(!runtime.connectors.includes("github"));
  for (const connector of ["jira", "stripe", "supabase"])
    assert.ok(runtime.connectors.includes(connector), connector);
  const { actor, cookie } = await signIn(runtime, {});
  assert.ok(actor && cookie);
  await assert.rejects(runtime.connect(actor, "github", false));
  const stripe = await runtime.connect(actor, "stripe", false);
  assert.equal(stripe.provider, "stripe");
  const config = await serve(
    runtime,
    new Request(`${origin}/api/config`, { headers: { origin, cookie } }),
  );
  assert.equal(config.status, 200);
  const body = await config.json();
  assert.ok(!body.teachingConnectors.includes("github"));
  assert.ok(body.teachingConnectors.includes("stripe"));

  // With an account, GitHub is offered and pinned to it, as before.
  const pinned = await hosted(
    environment({
      CEREMONY_TENANT_ID: "tenant",
      CEREMONY_GITHUB_ACCOUNT: "fixture",
    }),
  );
  assert.ok(pinned.connectors.includes("github"));
  assert.equal(
    (await pinned.connect(actor, "github", false)).provider,
    "github",
  );
});

test("a tenant claim places each identity in its own tenant, and a missing claim is refused", async () => {
  const runtime = await hosted(
    environment({
      CEREMONY_TENANT_CLAIM: "org",
      CEREMONY_TENANT_ID: undefined,
    }),
  );
  const a = (await signIn(runtime, { org: "org-a" })).actor;
  const b = (await signIn(runtime, { org: "org-b" })).actor;
  assert.ok(a && b);
  assert.equal(a.tenantId, "org-a");
  assert.equal(b.tenantId, "org-b");
  // Same person at the issuer, two organizations: nothing crosses.
  assert.equal(a.subjectId, b.subjectId);
  const runA = await runtime.connect(a, "stripe", false);
  await assert.rejects(runtime.commands.snapshot(b, runA.id));
  const runB = await runtime.connect(b, "stripe", false);
  assert.notEqual(runB.id, runA.id);
  assert.equal((await runtime.commands.snapshot(a, runA.id)).id, runA.id);
  const env = new AsyncCeremonyEnvironment(runtime.store);
  await env.update(a, {
    revision: 0,
    values: { STRIPE_SECRET_KEY: "fixture-not-a-key" },
  });
  assert.deepEqual((await env.describe(b)).names, []);
  // Connector state is tenant-keyed too.
  const service = runtime.hosted.connectors!.runtime.service;
  assert.deepEqual(await service.listConnections(a), []);
  assert.deepEqual(await service.listConnections(b), []);

  // The workload dispatcher finds both tenants' pending work.
  assert.deepEqual(
    (await runtime.hosted.tenancy.tenants(runtime.store)).sort(),
    ["org-a", "org-b"],
  );

  // No claim, a malformed claim, or a claim naming a server tenant: no session.
  for (const claims of [
    {},
    { org: "" },
    { org: ["org-a"] },
    { org: "org a" },
    { org: "hosted" },
    { org: "identity" },
  ])
    assert.equal((await signIn(runtime, claims)).actor, null);

  // A host policy never admits an actor from a tenant it does not serve.
  const pinned = new HostedTenancy({ home: "tenant" });
  assert.equal(pinned.accepts("tenant"), true);
  assert.equal(pinned.accepts("org-a"), false);
  assert.equal(pinned.tenantFor({ org: "org-a" }), "tenant");
});

test("tenancy configuration fails closed", async () => {
  for (const extra of [
    { CEREMONY_TENANT_ID: undefined },
    { CEREMONY_TENANT_CLAIM: "bad claim" },
    { CEREMONY_ROLES_MAP: "not json" },
    { CEREMONY_ROLES_MAP: JSON.stringify({ group: ["superuser"] }) },
    { CEREMONY_CONNECTOR_CONFIGURATION: "CEREMONY_VAULT_KEY" },
    { CEREMONY_CONNECTOR_EVENTS: "yes" },
  ])
    await assert.rejects(
      createHostedRuntime(
        environment({ CEREMONY_TENANT_ID: "tenant", ...extra }),
      ),
      /Missing or invalid|initialization failed/,
    );
});

test("a roles claim maps to capabilities, and gates the authoring tools over MCP", async () => {
  const env = environment({
    CEREMONY_TENANT_ID: "tenant",
    CEREMONY_ROLES_CLAIM: "groups",
    CEREMONY_ROLES_MAP: JSON.stringify({
      "ceremony-authors": ["author", "executor"],
      "ceremony-admins": ["admin"],
    }),
  });
  const runtime = await hosted(env);
  assert.deepEqual(
    (await signIn(runtime, { groups: ["ceremony-authors", "unrelated"] })).actor
      ?.capabilities,
    ["author", "executor"],
  );
  assert.deepEqual(
    (await signIn(runtime, { groups: "unrelated ceremony-admins" })).actor
      ?.capabilities,
    ["admin"],
  );
  // Present but mapping to nothing grants nothing; absent is executor alone.
  assert.deepEqual(
    (await signIn(runtime, { groups: ["unrelated"] })).actor?.capabilities,
    [],
  );
  assert.deepEqual((await signIn(runtime, {})).actor?.capabilities, [
    "executor",
  ]);
  // The unconfigured default is still the signed `ceremony_roles` claim.
  const defaults = new HostedTenancy({ home: "tenant" });
  assert.deepEqual(
    defaults.capabilitiesFor({ ceremony_roles: ["reviewer", "bogus"] }),
    ["reviewer"],
  );
  assert.throws(() => defaults.capabilitiesFor({ ceremony_roles: 7 }));

  const mcp = await createHostedMcp(env, runtime);
  assert.ok(mcp);
  const resource = `${origin}/mcp`;
  const tools = async (token: string) => {
    const call = (body: unknown) =>
      mcp.fetch(
        new Request(resource, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }),
      );
    const initialized = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    if (initialized?.status !== 200) return initialized?.status;
    const listed = await call({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const text = await listed!.text();
    const payload = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .at(-1)!;
    return (
      JSON.parse(payload) as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((tool) => tool.name);
  };
  const author = await tools(
    await provider.accessToken(resource, { groups: ["ceremony-authors"] }),
  );
  const executor = await tools(await provider.accessToken(resource));
  assert.ok(Array.isArray(author) && Array.isArray(executor));
  // Recording and authoring reach an author, and only an author.
  assert.ok(author.includes("ceremony_demonstration_start"));
  assert.ok(!executor.includes("ceremony_demonstration_start"));
  assert.ok(author.some((tool) => tool.startsWith("ceremony_author_")));
  assert.ok(!executor.some((tool) => tool.startsWith("ceremony_author_")));
  // The connector tools and intents are mounted in hosted, for both.
  for (const name of [
    "connector_catalog",
    "connector_status",
    "connector_connect",
    "connector_invoke",
    "connector_list",
    "connector_inspect",
    "connector_operations",
    "connector_reconnect",
    "connector_disconnect",
  ]) {
    assert.ok(executor.includes(name), `${name} missing`);
    assert.ok(author.includes(name), `${name} missing`);
  }
  // A token for another resource, or with a malformed roles claim, is refused.
  assert.equal(await tools(await provider.accessToken(`${origin}/other`)), 401);
  assert.equal(
    await tools(await provider.accessToken(resource, { groups: { a: 1 } })),
    401,
  );
});

test("an MCP token takes its tenant from the same claim as the browser", async () => {
  const env = environment({
    CEREMONY_TENANT_CLAIM: "org",
    CEREMONY_TENANT_ID: undefined,
  });
  const runtime = await hosted(env);
  const mcp = await createHostedMcp(env, runtime);
  assert.ok(mcp);
  const resource = `${origin}/mcp`;
  const initialize = async (token: string) =>
    (
      await mcp.fetch(
        new Request(resource, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          }),
        }),
      )
    )?.status;
  assert.equal(
    await initialize(await provider.accessToken(resource, { org: "org-c" })),
    200,
  );
  assert.equal(await initialize(await provider.accessToken(resource)), 401);
  assert.ok(
    (await runtime.hosted.tenancy.tenants(runtime.store)).includes("org-c"),
  );
});

test("the connector route table is mounted behind the hosted session", async () => {
  const runtime = await hosted(environment({ CEREMONY_TENANT_ID: "tenant" }));
  const { cookie } = await signIn(runtime, {});
  assert.ok(cookie);
  const catalog = await serve(
    runtime,
    new Request(`${origin}/api/v1/connectors/catalog`, {
      headers: { origin, cookie },
    }),
  );
  assert.equal(catalog.status, 200);
  const entries = (await catalog.json()).entries as Array<{ id?: string }>;
  assert.ok(entries.length > 0);
  const anonymous = await serve(
    runtime,
    new Request(`${origin}/api/v1/connectors/catalog`, { headers: { origin } }),
  );
  assert.equal(anonymous.status, 401);

  const disabled = await hosted(
    environment({
      CEREMONY_TENANT_ID: "tenant",
      CEREMONY_CONNECTORS: "disabled",
    }),
  );
  assert.equal(disabled.hosted.connectors, undefined);
});

test("provider deliveries are verified and admitted only when events are enabled", async () => {
  const deliver = async (runtime: HostedRuntime, subscriptionId: string) => {
    const body = JSON.stringify({ type: "invoice.paid", data: { id: "in_1" } });
    const headers = signStandardWebhook({
      id: "msg_1",
      timestampSeconds: Math.floor(Date.now() / 1000),
      body,
    });
    const response = await serve(
      runtime,
      new Request(
        `${origin}/api/v1/connectors/events/acme-billing/${subscriptionId}`,
        { method: "POST", headers, body },
      ),
    );
    return { status: response.status, body: await response.text() };
  };

  const off = await hosted(environment({ CEREMONY_TENANT_ID: "tenant" }));
  assert.equal(off.hosted.connectors?.events, false);
  assert.equal((await deliver(off, "subscription-1")).status, 404);

  const on = await hosted(
    environment({
      CEREMONY_TENANT_ID: "tenant",
      CEREMONY_CONNECTOR_EVENTS: "enabled",
    }),
  );
  const connectors = on.hosted.connectors!;
  assert.equal(connectors.events, true);
  // An approved subscription whose signing secret is in this deployment's
  // custody, exactly as the connector layer records one.
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject-1",
    sessionId: "session-1",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const binding = receiverBinding("tenant");
  const secretRef = await connectors.runtime.ports.credentials.store(
    {
      tenantId: "tenant",
      ownerKind: "user",
      ownerId: actor.subjectId,
      connectionRef: "connection:1",
      bindingRef: binding.bindingRef,
      custody: "host-owned",
    },
    { primary: SECRET },
  );
  const registry = new SubscriptionRegistry(on.store);
  const approved = await registry.approve(actor, {
    connectionRef: "connection:1",
    binding,
    destinationId: "receiver",
    eventTypes: ["invoice.paid"],
    secretRef,
    verification: { method: "standard-webhooks" },
    authority: "acme-billing",
    generation: 1,
    policyRevision: "policy:1",
  });
  await registry.activate(actor, approved.subscriptionId);
  const accepted = await deliver(on, approved.subscriptionId);
  assert.equal(accepted.status, 200, accepted.body);
  assert.match(accepted.body, /accepted/);
  assert.match((await deliver(on, approved.subscriptionId)).body, /duplicate/);
  // An unknown subscription, and a forged signature, are refused without echo.
  assert.equal((await deliver(on, "subscription-unknown")).status, 404);
  const forged = await serve(
    on,
    new Request(
      `${origin}/api/v1/connectors/events/acme-billing/${approved.subscriptionId}`,
      {
        method: "POST",
        headers: signStandardWebhook({
          id: "msg_2",
          timestampSeconds: Math.floor(Date.now() / 1000),
          body: "{}",
          secret: "whsec_c2Vjb25kLXNlY3JldC1mb3Itcm90YXRpb24hIQ==",
        }),
        body: "{}",
      },
    ),
  );
  assert.equal(forged.status, 401);
  assert.doesNotMatch(await forged.text(), /whsec_/);
});

test("host run policy admits authored runs on their own target and refuses unknown providers", () => {
  const tenancy = new HostedTenancy({ home: "tenant" });
  const admits = hostedRunPolicy({ origin, tenancy });
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const run = (fields: Partial<RunRecord>) =>
    ({
      id: "run",
      subjectId: "subject",
      sessionId: "session",
      status: "active",
      provider: "stripe",
      profile: "stripe-api-key",
      target: "self",
      origin,
      environment: "production",
      configurationVersion: "v1",
      nodes: [],
      inputs: {},
      ...fields,
    }) as RunRecord;
  assert.equal(admits(actor, run({})), true);
  assert.equal(admits(actor, run({ target: "someone-else" })), false);
  assert.equal(
    admits(
      actor,
      run({ provider: "acme", profile: "authored", target: "acme" }),
    ),
    true,
  );
  assert.equal(
    admits(actor, run({ provider: "acme", profile: "authored", target: "x" })),
    false,
  );
  // Without an account there is no admissible GitHub target at all.
  assert.equal(
    admits(actor, run({ provider: "github", profile: "github-app" })),
    false,
  );
  assert.equal(admits(actor, run({ provider: "unknown" })), false);
  assert.equal(admits({ ...actor, tenantId: "other" }, run({})), false);
  assert.equal(admits({ ...actor, capabilities: [] }, run({})), false);
  assert.equal(
    admits(actor, run({ origin: "https://elsewhere.example" })),
    false,
  );
});
