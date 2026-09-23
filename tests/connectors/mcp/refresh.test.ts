import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { createMcpRemoteAdapter } from "../../../src/server/connectors/mcp/index.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  startMcpFixture,
  type FixtureServer,
} from "../doubles/mcp-servers/harness.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";

/*
 * Token renewal for the remote MCP adapter's default OAuth profile, against
 * the current-revision MCP fixture (its own process) and a loopback token
 * endpoint. The MCP server accepts exactly the two access tokens the token
 * endpoint issues on refresh, so a call succeeds only with a token the
 * adapter really renewed. The renewal is the shared single-flight refresh in
 * `connectors/auth`, bound to the endpoint's canonical resource; nothing here
 * refreshes a token the host did not pin an issuer policy for.
 */

const ISSUED = ["mcp-renewed-1", "mcp-renewed-2"] as const;
const REFRESH = "mcp-refresh-canary-Tq8";

let mcp: FixtureServer;
before(async () => {
  mcp = await startMcpFixture("current", {
    token: ISSUED[0],
    secondToken: ISSUED[1],
  });
});
after(async () => {
  await mcp?.stop();
});
beforeEach(async () => {
  await mcp.control({ mode: "normal", reset: true });
});

/** A token endpoint that rotates refresh tokens and issues the fixture's access tokens in turn. */
async function tokenEndpoint() {
  const refreshTokens = new Set([REFRESH]);
  const revoked: string[] = [];
  const grants: Array<Record<string, string>> = [];
  let issued = 0;
  /** "drop" closes the connection once the refresh request has arrived. */
  const behaviour = { mode: "normal" as "normal" | "drop" };
  const server = await startHttpFixture((request, raw) => {
    const form = Object.fromEntries(
      new URLSearchParams(request.body.toString("utf8")),
    );
    if (request.url.pathname === "/revoke") {
      if (form["client_id"] !== "mcp-client")
        return { status: 401, body: { error: "invalid_client" } };
      revoked.push(form["token"] ?? "");
      return { status: 200, body: "" };
    }
    if (request.url.pathname !== "/token") return undefined;
    grants.push(form);
    if (behaviour.mode === "drop") {
      raw.req.socket.destroy();
      return undefined;
    }
    const presented = form["refresh_token"] ?? "";
    if (form["grant_type"] !== "refresh_token" || !refreshTokens.has(presented))
      return { status: 400, body: { error: "invalid_grant" } };
    refreshTokens.delete(presented);
    const next = `${REFRESH}-${issued + 1}`;
    refreshTokens.add(next);
    const access = ISSUED[Math.min(issued, ISSUED.length - 1)]!;
    issued += 1;
    return {
      status: 200,
      headers: { "cache-control": "no-store" },
      body: {
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: next,
      },
    };
  });
  return { server, grants, revoked, behaviour };
}

type Setup = {
  ctx: AdapterCallContext;
  ports: ReturnType<typeof memoryPorts>;
  as: Awaited<ReturnType<typeof tokenEndpoint>>;
  credentialRef: string;
};

async function setup(
  t: { after(fn: () => unknown): void },
  input: {
    material: Record<string, string>;
    expiresAt?: number;
    oauth?: Record<string, unknown> | false;
    now?: () => number;
  },
): Promise<Setup> {
  const as = await tokenEndpoint();
  t.after(() => as.server.close());
  const issuer = as.server.origin;
  const binding = runtimeBindingSchema.parse({
    bindingRef: "binding:mcp-refresh",
    definitionRef: "definition:mcp",
    revision: 1,
    adapterId: "mcp-remote",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: mcp.origin,
    status: "approved",
    approvedAt: "2026-09-23T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    destinations: [
      { id: "server", origin: mcp.origin, network: "loopback-fixture" },
    ],
    operations: [
      {
        operationRef: "op:echo",
        nativeId: "echo",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "echo" },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:link",
        nativeId: "needs_input",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "needs_input" },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
      {
        operationRef: "op:create",
        nativeId: "create_note",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "create_note" },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: "c".repeat(64),
    settings: {
      mcp: { profile: "2026-07-28", endpointPath: "/mcp", auth: "bearer" },
      ...(input.oauth === false
        ? {}
        : {
            oauth: {
              issuer,
              allowLoopbackHttp: true,
              discovery: "disabled",
              endpoints: {
                token: `${issuer}/token`,
                revocation: `${issuer}/revoke`,
              },
              registration: {
                allowed: ["pre-registered"],
                clientIdConfiguration: "MCP_CLIENT_ID",
              },
              ...input.oauth,
            },
          }),
    },
  });
  const ports = memoryPorts(input.now ? { now: input.now } : {});
  ports.configuration.set("MCP_CLIENT_ID", "mcp-client");
  const connectionRef = `connection:${randomUUID()}`;
  const scope = {
    tenantId: fixtureActor.tenantId,
    ownerKind: "user" as const,
    ownerId: fixtureActor.subjectId,
    connectionRef,
    bindingRef: binding.bindingRef,
    custody: "host-owned" as const,
  };
  const credentialRef = await ports.credentials.store(
    scope,
    {
      token_type: "bearer",
      issuer,
      client_id: "mcp-client",
      resource: `${mcp.origin}/mcp`,
      ...input.material,
    },
    input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt },
  );
  const connection: ConnectionRecord = {
    connectionRef,
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "mcp",
    service: "mcp",
    displayName: "Fixture MCP server",
    ownerKind: "user",
    custody: "host-owned",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 1,
    revision: 1,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: mcp.origin,
    bindingRevision: binding.revision,
    policyRevision: binding.policyRevision,
    configurationRevision: "cfg:1",
    credentialRef,
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
  return {
    as,
    ports,
    credentialRef,
    ctx: {
      actor: fixtureActor,
      binding,
      connection,
      generation: 1,
      signal: new AbortController().signal,
      environment: ports.environment({ fetch: globalThis.fetch }),
    },
  };
}

const call = (state: Setup, operationRef = "op:echo") =>
  createMcpRemoteAdapter().invoke!(state.ctx, {
    operationRef,
    input: { text: "hello" },
    commandId: `command:${randomUUID()}`,
  });

function assertNoTokens(state: Setup, ...values: unknown[]) {
  const text = JSON.stringify([values, state.ports.inspect.effects()]);
  for (const secret of [REFRESH, ...ISSUED, "mcp-stale-token"])
    assert.ok(!text.includes(secret), "a token leaked");
}

test("an expired token is renewed once, single-flight, and the calls that found it expired proceed", async (t) => {
  const state = await setup(t, {
    material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
    expiresAt: Date.now() - 1000,
  });
  const [first, second] = await Promise.all([call(state), call(state)]);
  assert.equal(first.state, "complete");
  assert.equal(second.state, "complete");
  assert.equal(state.as.grants.length, 1, "one refresh for both calls");
  assert.equal(state.as.grants[0]?.["resource"], `${mcp.origin}/mcp`);
  const material = state.ports.inspect.credentialMaterial(state.credentialRef);
  assert.equal(material?.["access_token"], ISSUED[0]);
  assert.notEqual(material?.["refresh_token"], REFRESH, "rotated");
  // Custody refused the stale token before anything was sent.
  const report = await mcp.report();
  assert.ok(
    !report.wire.some((entry) =>
      entry.headers["authorization"]?.includes("mcp-stale-token"),
    ),
  );
  assertNoTokens(state, first, second);
});

test("a 401 to a live-looking token renews once and retries; a consequential call is journaled once per attempt", async (t) => {
  const state = await setup(t, {
    material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
    expiresAt: Date.now() + 3_600_000,
  });
  const result = await call(state, "op:create");
  assert.equal(result.state, "complete");
  assert.equal(state.as.grants.length, 1);
  const attempts = state.ports.inspect
    .effects()
    .filter((entry) => entry.intent.operation === "op:create")
    .map((entry) => entry.outcome?.status);
  // The refused attempt never ran; the retry is its own entry and applied.
  assert.deepEqual(attempts, ["not-applied", "applied"]);
  assert.equal((await mcp.report()).effects.length, 1, "one note was created");
  assertNoTokens(state, result);
});

test("without a refresh token, or without an issuer policy, the refusal stands and the issuer is not asked", async (t) => {
  for (const variant of [
    { material: { access_token: "mcp-stale-token" } },
    {
      material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
      oauth: false as const,
    },
  ]) {
    const state = await setup(t, variant);
    const result = await call(state);
    assert.equal(result.state, "denied");
    assert.equal(result.code, "authorization-required");
    assert.equal(state.as.grants.length, 0);
  }
});

test("a renewal the issuer refuses is reported by code, once, without retrying", async (t) => {
  const state = await setup(t, {
    material: {
      access_token: "mcp-stale-token",
      refresh_token: "mcp-refresh-unknown",
    },
  });
  const result = await call(state);
  assert.equal(result.state, "denied");
  assert.equal(result.code, "mcp.credential-renewal-failed");
  assert.equal(state.as.grants.length, 1);
  assertNoTokens(state, result);
});

test("an upstream disconnect revokes the default profile's grant only when the reviewed policy allows it", async (t) => {
  const off = await setup(t, {
    material: { access_token: ISSUED[0], refresh_token: REFRESH },
  });
  const kept = await createMcpRemoteAdapter().disconnect!(off.ctx, "upstream");
  assert.equal(kept.upstream, "not-attempted");
  assert.deepEqual(off.as.revoked, []);

  const on = await setup(t, {
    material: { access_token: ISSUED[0], refresh_token: REFRESH },
    oauth: { revocation: "on-upstream-disconnect" },
  });
  const local = await createMcpRemoteAdapter().disconnect!(on.ctx, "local");
  assert.equal(local.upstream, "not-attempted");
  assert.deepEqual(on.as.revoked, [], "a local disconnect is not revocation");
  const revoked = await createMcpRemoteAdapter().disconnect!(
    on.ctx,
    "upstream",
  );
  assert.equal(revoked.upstream, "applied");
  assert.deepEqual(on.as.revoked, [REFRESH, ISSUED[0]]);
  assertNoTokens(on, revoked);
});

/* ---------------------------------------------- verification and resumption */

const verify = (state: Setup) => createMcpRemoteAdapter().verify!(state.ctx);

test("verification renews an expired token once and then verifies, instead of asking a person to reconnect", async (t) => {
  const state = await setup(t, {
    material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
    expiresAt: Date.now() - 1000,
  });
  const result = await verify(state);
  assert.equal(result.state, "complete");
  assert.equal(result.claims[0]?.kind, "credential-accepted");
  assert.equal(state.as.grants.length, 1, "one refresh");
  assert.equal(state.as.grants[0]?.["resource"], `${mcp.origin}/mcp`);
  const material = state.ports.inspect.credentialMaterial(state.credentialRef);
  assert.equal(material?.["access_token"], ISSUED[0]);
  // Custody refused the stale token before anything was sent.
  assert.ok(
    !(await mcp.report()).wire.some((entry) =>
      entry.headers["authorization"]?.includes("mcp-stale-token"),
    ),
  );
  assertNoTokens(state, result);
});

test("verification that the server answers 401 renews once and retries discovery", async (t) => {
  const state = await setup(t, {
    material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
    expiresAt: Date.now() + 3_600_000,
  });
  const result = await verify(state);
  assert.equal(result.state, "complete");
  assert.equal(state.as.grants.length, 1);
  assertNoTokens(state, result);
});

test("a verification refresh the issuer refuses is a denial by fixed code, which is the reconnect state", async (t) => {
  for (const expiresAt of [Date.now() - 1000, undefined]) {
    const state = await setup(t, {
      material: {
        access_token: "mcp-stale-token",
        refresh_token: "mcp-refresh-unknown",
      },
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    const result = await verify(state);
    assert.equal(result.state, "denied");
    assert.equal(result.code, "mcp.credential-renewal-failed");
    assert.equal(state.as.grants.length, 1, "asked once, not retried");
    assert.ok(
      !JSON.stringify(result).includes("invalid_grant"),
      "no issuer text",
    );
    assertNoTokens(state, result);
  }
});

test("an issuer that cannot be reached during verification leaves the connection pending, not reconnect-required", async (t) => {
  const state = await setup(t, {
    material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
    expiresAt: Date.now() - 1000,
  });
  await state.as.server.close();
  const result = await verify(state);
  assert.equal(result.state, "pending");
  assert.equal(result.code, "mcp.credential-renewal-unavailable");
  assertNoTokens(state, result);
});

test("a refresh whose outcome is unknown is indeterminate, never a refusal", async (t) => {
  const state = await setup(t, {
    material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
    expiresAt: Date.now() - 1000,
  });
  state.as.behaviour.mode = "drop";
  const result = await verify(state);
  assert.equal(state.as.grants.length, 1, "the request reached the issuer");
  assert.equal(result.state, "indeterminate");
  assert.equal(result.code, "mcp.credential-renewal-indeterminate");
  // The refresh token may have been spent; it is not presented again.
  const again = await verify(state);
  assert.equal(again.state, "indeterminate");
  assert.equal(state.as.grants.length, 1);
  assertNoTokens(state, result, again);
});

test("verification without a refresh token or issuer policy keeps today's answer and asks nobody", async (t) => {
  const expired = await setup(t, {
    material: { access_token: "mcp-stale-token" },
    expiresAt: Date.now() - 1000,
  });
  const stale = await verify(expired);
  assert.equal(stale.state, "denied");
  assert.equal(stale.code, "credential.expired");
  assert.equal(expired.as.grants.length, 0);

  const refused = await setup(t, {
    material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
    oauth: false,
  });
  const denied = await verify(refused);
  assert.equal(denied.state, "denied");
  assert.equal(denied.code, "authorization-required");
  assert.equal(refused.as.grants.length, 0);
});

test("a person's answer to a suspended input request survives the token expiring meanwhile", async (t) => {
  let clock = Date.now();
  const state = await setup(t, {
    material: { access_token: ISSUED[0], refresh_token: REFRESH },
    expiresAt: clock + 60_000,
    now: () => clock,
  });
  const adapter = createMcpRemoteAdapter({ inputHandoffMs: 3_600_000 });
  const started = await adapter.invoke!(state.ctx, {
    operationRef: "op:link",
    input: { repo: "ceremony" },
    commandId: "command:link",
  });
  assert.equal(started.state, "human-required");
  const { handoffRef } = await state.ports.handoffs.issue({
    ...started.handoff!,
    actor: state.ctx.actor,
    connectionRef: state.ctx.connection!.connectionRef,
    bindingRef: state.ctx.binding.bindingRef,
    generation: state.ctx.generation,
  });
  const record = (await state.ports.handoffs.present(
    state.ctx.actor,
    handoffRef,
  ))!;
  // The person takes ten minutes; the access token lived for one.
  clock += 10 * 60_000;
  const resumed = await adapter.resumeInput!(state.ctx, record, {
    name: "octocat",
  });
  assert.equal(resumed.state, "complete");
  assert.equal(state.as.grants.length, 1, "renewed once");
  assert.deepEqual(
    state.ports.inspect
      .effects()
      .filter((entry) => entry.intent.operation === "op:link")
      .map((entry) => entry.outcome?.status)
      .slice(-2),
    ["not-applied", "applied"],
    "the refused attempt sent nothing; the retry applied once",
  );
  assertNoTokens(state, resumed);
});
