import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import {
  createMcpClient,
  createMcpRemoteAdapter,
} from "../../../src/server/connectors/mcp/index.js";
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
  const server = await startHttpFixture((request) => {
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
  return { server, grants, revoked };
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
    mcp?: Record<string, unknown>;
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
      mcp: {
        profile: "2026-07-28",
        endpointPath: "/mcp",
        auth: "bearer",
        ...input.mcp,
      },
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
  const ports = memoryPorts();
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

test("a pinned tool whose listing is refused with 401 renews once and retries", async (t) => {
  // The reviewed digest of echo, read with a token the fixture accepts.
  const listed = await createMcpClient({
    profile: "2026-07-28",
    endpoint: `${mcp.origin}/mcp`,
    fetch: globalThis.fetch,
    auth: { kind: "bearer", use: (work) => work(ISSUED[0]) },
    limits: { requestTimeoutMs: 5000 },
  }).listTools();
  const digest = listed.items.find(
    (tool) => tool.name === "echo",
  )?.definitionDigest;
  assert.ok(digest);
  const state = await setup(t, {
    material: { access_token: "mcp-stale-token", refresh_token: REFRESH },
    expiresAt: Date.now() + 3_600_000,
    mcp: { pinnedTools: { echo: digest } },
  });
  // The pin lists tools before calling; that listing is what meets the 401,
  // and it is a challenge to answer, not an unverifiable tool.
  const result = await call(state);
  assert.equal(result.state, "complete");
  assert.equal(state.as.grants.length, 1, "one refresh");
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
