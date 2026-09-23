import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { issueHandoff } from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";
import {
  createMcpOAuth,
  createMcpRemoteAdapter,
  type McpOAuthRequest,
} from "../../../src/server/connectors/mcp/index.js";
import {
  CALLBACK_URI,
  HOST_ORIGIN,
  testBinding,
  testConnection,
} from "../auth/harness.js";
import { startAuthorizationServer } from "../doubles/authorization-server.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";

/*
 * The default OAuth profile for OAuth-protected MCP servers, against the
 * loopback fixture authorization server. The challenge here is the parsed form
 * the adapter hands the hook after probing a server; the authorization,
 * callback and token exchange are the fixture's own. The MCP server itself is
 * not needed to prove what the hook sends and what completion stores.
 */

const RESOURCE = "https://mcp.example.test/mcp";

async function setup(
  t: TestContext,
  options: { policy?: Record<string, unknown> | false } = {},
) {
  const as = await startAuthorizationServer({
    redirectUris: [CALLBACK_URI],
    scopes: ["mcp:tools", "mcp:resources"],
  });
  t.after(() => as.close());
  const ports = memoryPorts();
  ports.configuration.set("MCP_CLIENT_ID", "fixture-client");
  const binding = testBinding({
    adapterId: "mcp-remote",
    settings:
      options.policy === false
        ? {}
        : {
            oauth: {
              issuer: as.issuer,
              allowLoopbackHttp: true,
              registration: {
                allowed: ["pre-registered"],
                clientIdConfiguration: "MCP_CLIENT_ID",
              },
              ...options.policy,
            },
          },
  });
  const connection = testConnection({ ecosystem: "mcp" });
  const ctx = (handoff?: HandoffRecord): AdapterCallContext => ({
    actor: fixtureActor,
    binding,
    connection,
    ...(handoff ? { handoff } : {}),
    generation: connection.generation,
    signal: new AbortController().signal,
    environment: ports.environment({ fetch, origin: HOST_ORIGIN }),
  });
  return { as, ports, ctx };
}

function request(
  issuer: string,
  intent: Partial<AuthorizationIntent> = {},
): McpOAuthRequest {
  return {
    challenge: {
      status: 401,
      challengeScopes: ["mcp:tools"],
      requestedScopes: ["mcp:tools"],
      metadata: {
        resource: RESOURCE,
        authorizationServers: [issuer],
        scopesSupported: ["mcp:tools", "mcp:resources"],
        bearerMethodsSupported: ["header"],
      },
      canonicalResource: RESOURCE,
      clientRegistration: ["pre-registered"],
      issues: [],
    } as McpOAuthRequest["challenge"],
    intent: {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
      ...intent,
    },
    resource: RESOURCE,
    profile: "2026-07-28",
  };
}

test("the default MCP OAuth profile authorizes for the server's resource and completes through the adapter", async (t) => {
  const state = await setup(t);
  const start = await createMcpOAuth()(state.ctx(), request(state.as.issuer));
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") return;
  const url = new URL(start.handoff.private["authorizationUrl"]!);
  assert.equal(url.origin, state.as.origin);
  assert.equal(url.searchParams.get("resource"), RESOURCE);
  assert.equal(url.searchParams.get("scope"), "mcp:tools");
  const issued = await issueHandoff(state.ctx(), start.handoff);
  const record = state.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef)!;
  const callback = await state.as.authorize(
    start.handoff.private["authorizationUrl"]!,
  );
  const result = await createMcpRemoteAdapter().complete!(state.ctx(record), {
    kind: "redirect",
    url: new URL(callback),
  });
  assert.equal(result.state, "complete");
  assert.equal(result.handoffSettled, true);
  assert.ok(result.credentialRef);
  const material = state.ports.inspect.credentialMaterial(
    result.credentialRef!,
  );
  assert.ok(material?.["access_token"]);
  assert.equal(material?.["resource"], RESOURCE);
  // The resource indicator travelled on the token request too (RFC 8707).
  assert.equal(state.as.tokenRequests[0]?.parameters["resource"], RESOURCE);
  assert.ok(!JSON.stringify(result).includes(material!["access_token"]!));
});

test("without an issuer policy in the binding, the profile says so instead of trusting the server's metadata", async (t) => {
  const state = await setup(t, { policy: false });
  const start = await createMcpOAuth()(state.ctx(), request(state.as.issuer));
  assert.deepEqual(start, {
    kind: "unsupported",
    code: "mcp.oauth.policy-missing",
  });
  assert.equal(state.as.counts.metadata, 0);
});

test("an issuer the server does not name is not asked for a token", async (t) => {
  const state = await setup(t);
  const start = await createMcpOAuth()(
    state.ctx(),
    request("https://other-issuer.example.test"),
  );
  assert.deepEqual(start, {
    kind: "unsupported",
    code: "mcp.oauth.issuer-not-advertised",
  });
  assert.equal(state.as.counts.metadata, 0);
});

test("a policy pinned to another resource is refused rather than widened", async (t) => {
  const state = await setup(t, {
    policy: { resource: "https://elsewhere.example.test/mcp" },
  });
  await assert.rejects(
    createMcpOAuth()(state.ctx(), request(state.as.issuer)),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "mcp.oauth.resource-mismatch",
  );
});
