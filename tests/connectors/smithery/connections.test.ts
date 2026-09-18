import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryPorts, fixtureActor } from "../doubles/ports.js";
import {
  startSmitheryDouble,
  type SmitheryConnectionSeed,
  type SmitheryDouble,
} from "../doubles/smithery.js";
import { buildBinding, canaries } from "../fixtures/builders.js";
import {
  createSmitheryConnectionsAdapter,
  SMITHERY_CONNECTIONS_OPERATION,
  type SmitherySettings,
} from "../../../src/server/connectors/providers/smithery/connections.js";
import type {
  McpClientFactory,
  McpToolOutcome,
} from "../../../src/server/connectors/providers/smithery/ports.js";
import { SMITHERY_API_KEY } from "../../../src/server/connectors/registries/smithery/api.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
} from "../../../src/server/connectors/adapter.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";

/*
 * CAT-02 and AC-EXT-07. The double enforces Smithery's documented
 * authentication, namespace ownership and service-token policy; these tests
 * assert that a token which cannot reach the selected connection ends the
 * attempt — no second try with the deployment key, no namespace creation and
 * no other connection standing in for the one that was approved.
 */

const SETUP_URL = "https://smithery.ai/setup/abc123?state=CANARY_SETUP_9f3";

const MCP_ORIGIN = "https://mcp.smithery.run";

function connectedSeed(
  overrides: Partial<SmitheryConnectionSeed> = {},
): SmitheryConnectionSeed {
  return {
    connectionId: "notes-personal",
    namespace: "acme",
    name: "Acme notes",
    transport: "http",
    mcpUrl: "https://server.smithery.ai/acme/notes-mcp/mcp",
    metadata: { userId: "user-123" },
    status: { state: "connected" },
    serverInfo: { name: "acme-notes", version: "1.4.0" },
    ...overrides,
  };
}

type HarnessOptions = {
  connections?: SmitheryConnectionSeed[];
  namespaces?: string[];
  settings?: Partial<SmitherySettings>;
  permittedTargets?: RuntimeBinding["permittedTargets"];
  mcpOrigin?: string;
  mcpClient?: McpClientFactory;
  apiKey?: string;
};

async function harness(options: HarnessOptions = {}) {
  const double = await startSmitheryDouble({
    apiKey: canaries.token,
    namespaces: options.namespaces ?? ["acme"],
    connections: options.connections ?? [connectedSeed()],
  });
  const ports = memoryPorts();
  ports.configuration.set(SMITHERY_API_KEY, options.apiKey ?? canaries.token);
  const settings: SmitherySettings = {
    namespace: "acme",
    connectionId: "notes-personal",
    mcpUrl: "https://server.smithery.ai/acme/notes-mcp/mcp",
    metadata: { userId: "user-123" },
    mcpDestinationId: "mcp",
    displayName: "Acme notes",
    ...options.settings,
  };
  const binding = buildBinding({
    adapterId: "smithery",
    custody: "external-execution-broker",
    profileId: undefined,
    destinations: [
      { id: "api", origin: double.origin, network: "loopback-fixture" },
      {
        id: "mcp",
        origin: options.mcpOrigin ?? MCP_ORIGIN,
        network:
          (options.mcpOrigin ?? MCP_ORIGIN) === MCP_ORIGIN
            ? "public"
            : "loopback-fixture",
      },
    ],
    operations: [
      {
        operationRef: SMITHERY_CONNECTIONS_OPERATION.upsert,
        nativeId: "upsertConnection",
        destinationId: "api",
        transport: { kind: "http", method: "PUT", pathTemplate: "/connect" },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "reconciliation",
        targetParameters: [],
      },
      {
        operationRef: SMITHERY_CONNECTIONS_OPERATION.get,
        nativeId: "getConnection",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/connect" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: SMITHERY_CONNECTIONS_OPERATION.delete,
        nativeId: "deleteConnection",
        destinationId: "api",
        transport: { kind: "http", method: "DELETE", pathTemplate: "/connect" },
        effect: "write",
        outputClassification: "public",
        cost: "free",
        consent: "confirm",
        replay: "reconciliation",
        targetParameters: [],
      },
      {
        operationRef: SMITHERY_CONNECTIONS_OPERATION.token,
        nativeId: "createServiceToken",
        destinationId: "api",
        transport: { kind: "http", method: "POST", pathTemplate: "/tokens" },
        effect: "write",
        outputClassification: "secret",
        cost: "free",
        consent: "none",
        replay: "none",
        targetParameters: [],
      },
      {
        operationRef: "smithery.tool.search",
        nativeId: "search",
        destinationId: "mcp",
        transport: { kind: "mcp-tool", toolName: "search" },
        effect: "read",
        outputClassification: "personal",
        cost: "unknown",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [SMITHERY_API_KEY],
    permittedTargets: options.permittedTargets ?? [
      { kind: "namespace", id: "acme" },
      { kind: "connection", id: "notes-personal" },
    ],
    settings,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: AbortSignal.timeout(5000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  const adapter = createSmitheryConnectionsAdapter(
    options.mcpClient ? { mcpClient: options.mcpClient } : {},
  );
  return { double, ports, ctx, binding, adapter, settings };
}

const intent: AuthorizationIntent = {
  ownerKind: "user",
  requestedPermissions: [],
  accountSwitch: false,
  interruption: "allowed",
};

function recordingClient(outcome?: McpToolOutcome) {
  const calls: Array<{
    endpoint: string;
    bearer: string;
    name: string;
    arguments: Record<string, unknown>;
  }> = [];
  const factory: McpClientFactory = ({ endpoint, bearer }) => ({
    async callTool(request) {
      const bearerValue = await bearer.use(async (token) => token);
      calls.push({
        endpoint: endpoint.href,
        bearer: bearerValue,
        name: request.name,
        arguments: request.arguments,
      });
      return (
        outcome ?? {
          kind: "complete",
          payload: { content: [{ type: "text", text: "ok" }], isError: false },
        }
      );
    },
  });
  return { factory, calls };
}

async function noConnectionsCreated(double: SmitheryDouble) {
  assert.deepEqual(
    double.state.namespaceWrites,
    [],
    "no namespace was created",
  );
}

test("a connected managed connection authorizes straight to verification", async () => {
  const { double, ctx, adapter, ports } = await harness();
  try {
    const start = await adapter.authorize!(ctx, intent);
    assert.deepEqual(start, { kind: "verify" });
    const puts = double.received("PUT", "/connect/acme/notes-personal");
    assert.equal(puts.length, 1);
    const body = JSON.parse(puts[0]!.body.toString("utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(body.mcpUrl, "https://server.smithery.ai/acme/notes-mcp/mcp");
    assert.deepEqual(body.metadata, { userId: "user-123" });
    assert.equal(puts[0]?.headers.authorization, `Bearer ${canaries.token}`);
    const effects = ports.inspect.effects();
    assert.equal(effects.length, 1);
    assert.equal(effects[0]?.intent.operation, "smithery.connection.upsert");
    assert.equal(effects[0]?.outcome?.status, "applied");
    await noConnectionsCreated(double);
  } finally {
    await double.close();
  }
});

test("an auth_required connection yields a private handoff, never a public link", async () => {
  const { double, ctx, adapter } = await harness({
    connections: [
      connectedSeed({
        status: { state: "auth_required", setupUrl: SETUP_URL },
      }),
    ],
  });
  try {
    const start = await adapter.authorize!(ctx, intent);
    assert.equal(start.kind, "handoff");
    if (start.kind !== "handoff") return;
    assert.equal(start.handoff.kind, "provider-browser");
    assert.equal(start.handoff.presentation, "popup");
    assert.equal(start.handoff.private.url, SETUP_URL);
    assert.equal(start.handoff.correlationKey, "smithery:acme:notes-personal");
    const { private: _private, ...public_ } = start.handoff;
    assert.ok(
      !JSON.stringify(public_).includes("CANARY_SETUP_9f3"),
      "the setup link exists only in protected handoff material",
    );
    assert.ok(!JSON.stringify(start).includes(canaries.token));
  } finally {
    await double.close();
  }
});

test("a policy against interruption yields human-required, never a bypass", async () => {
  const { double, ctx, adapter } = await harness({
    connections: [
      connectedSeed({
        status: { state: "auth_required", setupUrl: SETUP_URL },
      }),
    ],
  });
  try {
    const start = await adapter.authorize!(ctx, {
      ...intent,
      interruption: "none",
    });
    assert.deepEqual(start, {
      kind: "human-required",
      code: "smithery.authorization",
    });
  } finally {
    await double.close();
  }
});

test("an input_required connection names the missing configuration", async () => {
  const { double, ctx, adapter } = await harness({
    connections: [
      connectedSeed({
        status: {
          state: "input_required",
          setupUrl: SETUP_URL,
          http: { headers: { "x-acme-key": {} }, query: { model: {} } },
          missing: { headers: ["x-acme-key"], query: ["model"] },
        },
      }),
    ],
  });
  try {
    const start = await adapter.authorize!(ctx, intent);
    assert.deepEqual(start, {
      kind: "configuration-required",
      missing: ["header:x-acme-key", "query:model"],
    });
    const verified = await adapter.verify!(ctx);
    assert.equal(verified.state, "human-required");
    assert.equal(verified.code, "smithery.configuration-required");
    assert.deepEqual(verified.claims, []);
  } finally {
    await double.close();
  }
});

test("verification records what Smithery states and what it cannot state", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const result = await adapter.verify!(ctx);
    assert.equal(result.state, "complete");
    assert.deepEqual(result.externalIds, {
      namespace: "acme",
      connectionId: "notes-personal",
    });
    assert.deepEqual(result.target, {
      kind: "connection",
      id: "notes-personal",
    });
    const kinds = result.claims.map((claim) => claim.kind);
    assert.deepEqual(kinds, ["credential-accepted", "resource-access"]);
    for (const claim of result.claims) {
      assert.equal(claim.issuer, "external-broker");
      assert.ok(claim.limitations.length > 0);
    }
    assert.ok(
      result.claims[0]?.limitations.some((text) =>
        text.includes("not evidence of which upstream account"),
      ),
      "a connected broker state is never relabelled account verification",
    );
    assert.ok(!JSON.stringify(result).includes(canaries.token));
  } finally {
    await double.close();
  }
});

test("a broker that answers with another connection id is refused", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const stored = double.state.connections.get("acme/notes-personal")!;
    double.state.connections.set("acme/notes-personal", {
      ...stored,
      connectionId: "someone-elses-connection",
    });
    await assert.rejects(
      () => adapter.verify!(ctx),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
  } finally {
    await double.close();
  }
});

test("a permitted runtime call uses the binding's endpoint and a scoped token", async () => {
  const client = recordingClient();
  const { double, ctx, adapter, ports } = await harness({
    mcpClient: client.factory,
  });
  try {
    const result = await adapter.invoke!(ctx, {
      operationRef: "smithery.tool.search",
      input: { query: "notes" },
      commandId: "command-1",
    });
    assert.equal(result.state, "complete");
    assert.equal(result.outputClassification, "personal");
    assert.equal(client.calls.length, 1);
    const call = client.calls[0]!;
    assert.equal(
      call.endpoint,
      `${MCP_ORIGIN}/acme`,
      "the destination is the binding's approved namespace endpoint",
    );
    assert.equal(
      call.name,
      "notes-personal.search",
      "Smithery prefixes namespace tools with the connection id",
    );
    assert.deepEqual(call.arguments, { query: "notes" });
    assert.ok(
      call.bearer.startsWith("st_"),
      "a runtime call carries a minted service token",
    );
    assert.notEqual(call.bearer, canaries.token);
    const minted = double.received("POST", "/tokens");
    assert.equal(minted.length, 1);
    const policy = (
      JSON.parse(minted[0]!.body.toString("utf8")) as {
        policy: Array<Record<string, unknown>>;
      }
    ).policy[0]!;
    assert.equal(policy.namespaces, "acme");
    assert.equal(policy.resources, "connections");
    assert.deepEqual(policy.operations, ["read", "execute"]);
    assert.deepEqual(policy.metadata, { userId: "user-123" });
    assert.equal(policy.ttl, "1h");
    const effects = ports.inspect.effects();
    assert.equal(effects[0]?.intent.operation, "smithery.tool.search");
    assert.equal(effects[0]?.outcome?.status, "applied");
  } finally {
    await double.close();
  }
});

test("an operation the binding does not approve never reaches the broker", async () => {
  const client = recordingClient();
  const { double, ctx, adapter } = await harness({ mcpClient: client.factory });
  try {
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "smithery.tool.delete_everything",
          input: {},
          commandId: "command-2",
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
    assert.equal(client.calls.length, 0);
    assert.equal(double.received("POST", "/tokens").length, 0);
  } finally {
    await double.close();
  }
});

test("AC-EXT-07: a binding whose namespace is not permitted is refused before any request", async () => {
  const client = recordingClient();
  const { double, ctx, adapter } = await harness({
    mcpClient: client.factory,
    permittedTargets: [{ kind: "namespace", id: "another-tenant" }],
  });
  try {
    for (const run of [
      () => adapter.authorize!(ctx, intent),
      () => adapter.verify!(ctx),
      () =>
        adapter.invoke!(ctx, {
          operationRef: "smithery.tool.search",
          input: {},
          commandId: "command-3",
        }),
    ])
      await assert.rejects(
        run,
        (error: unknown) =>
          error instanceof ConnectorError && error.code === "denied",
      );
    assert.equal(double.requests.length, 0, "nothing was attempted upstream");
    assert.equal(client.calls.length, 0);
    await noConnectionsCreated(double);
  } finally {
    await double.close();
  }
});

test("AC-EXT-07: a key without the selected namespace fails closed with no fallback and no new namespace", async () => {
  const client = recordingClient();
  const { double, ctx, adapter } = await harness({
    mcpClient: client.factory,
    namespaces: ["another-tenant"],
  });
  try {
    await assert.rejects(
      () => adapter.authorize!(ctx, intent),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
    assert.equal(
      double.requests.length,
      1,
      "one attempt, no retry with another credential",
    );
    await assert.rejects(
      () => adapter.verify!(ctx),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
    assert.equal(client.calls.length, 0);
    await noConnectionsCreated(double);
    assert.equal(double.state.created.length, 0);
    // Every request used the configured backend key exactly once per call;
    // nothing tried a second, broader credential.
    assert.deepEqual(
      new Set(double.state.bearers()),
      new Set([canaries.token]),
    );
  } finally {
    await double.close();
  }
});

test("AC-EXT-07: a scoped token that does not match the connection's metadata cannot execute", async () => {
  // The MCP leg here really calls Smithery's documented tool endpoint with the
  // minted token, so the double's own policy check decides the outcome.
  const attempted: string[] = [];
  const factory: McpClientFactory = ({ endpoint, bearer, fetch: doFetch }) => ({
    async callTool(request) {
      return bearer.use(async (token): Promise<McpToolOutcome> => {
        attempted.push(token);
        const [connectionId, toolName] = request.name.split(".");
        const url = new URL(
          `/connect/acme/${connectionId}/.tools/${toolName}`,
          endpoint.origin,
        );
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request.arguments),
        });
        if (!response.ok)
          return {
            kind: "failed",
            code: `http-${response.status}`,
            applied: "no",
          };
        return {
          kind: "complete",
          payload: { content: [], isError: false },
        };
      });
    },
  });
  const { double, ctx, adapter } = await harness({
    mcpClient: factory,
    // The connection belongs to a different end user than the binding's
    // metadata scope, so the minted token cannot reach it.
    connections: [connectedSeed({ metadata: { userId: "user-999" } })],
  });
  try {
    const ctxOnDouble: AdapterCallContext = {
      ...ctx,
      binding: {
        ...ctx.binding,
        destinations: ctx.binding.destinations.map((destination) =>
          destination.id === "mcp"
            ? {
                id: "mcp",
                origin: double.origin,
                network: "loopback-fixture" as const,
              }
            : destination,
        ),
      },
    };
    const result = await adapter.invoke!(ctxOnDouble, {
      operationRef: "smithery.tool.search",
      input: {},
      commandId: "command-4",
    });
    assert.equal(result.state, "failed");
    assert.equal(result.code, "smithery.tool-failed");
    assert.equal(attempted.length, 1);
    assert.ok(attempted[0]?.startsWith("st_"));
    const toolCalls = double.requests.filter((request) =>
      request.url.pathname.includes("/.tools/"),
    );
    assert.equal(toolCalls.length, 1);
    assert.equal(
      toolCalls[0]?.headers.authorization,
      `Bearer ${attempted[0]}`,
      "the scoped token is the only credential on the runtime leg",
    );
    assert.notEqual(
      toolCalls[0]?.headers.authorization,
      `Bearer ${canaries.token}`,
    );
  } finally {
    await double.close();
  }
});

test("AC-EXT-07: a broker that refuses to mint a token ends the attempt", async () => {
  const client = recordingClient();
  const { double, ctx, adapter } = await harness({ mcpClient: client.factory });
  try {
    // A token minted from a service token is forbidden by Smithery; using one
    // as the deployment key models a key that cannot mint for this namespace.
    const scoped = double.mintToken([
      { namespaces: "acme", resources: "connections", operations: ["read"] },
    ]);
    ctx.environment.configuration.read = async (name: string) =>
      name === SMITHERY_API_KEY ? scoped : undefined;
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "smithery.tool.search",
          input: {},
          commandId: "command-5",
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
    assert.equal(
      client.calls.length,
      0,
      "no runtime call without a scoped token",
    );
  } finally {
    await double.close();
  }
});

test("a repeated invocation returns the journaled outcome instead of calling twice", async () => {
  const client = recordingClient();
  const { double, ctx, adapter } = await harness({ mcpClient: client.factory });
  try {
    const request = {
      operationRef: "smithery.tool.search",
      input: { query: "notes" },
      commandId: "command-6",
    };
    const first = await adapter.invoke!(ctx, request);
    const second = await adapter.invoke!(ctx, request);
    assert.equal(first.state, "complete");
    assert.equal(second.state, "complete");
    assert.equal(
      client.calls.length,
      1,
      "the second attempt replayed the journal",
    );
  } finally {
    await double.close();
  }
});

test("local disconnect, broker deletion and upstream revocation are distinct", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const local = await adapter.disconnect!(ctx, "local");
    assert.deepEqual(local, {
      local: "applied",
      broker: "not-attempted",
      upstream: "unsupported",
    });
    assert.equal(
      double.requests.length,
      0,
      "a local unlink touches nothing upstream",
    );

    const broker = await adapter.disconnect!(ctx, "broker");
    assert.equal(broker.broker, "applied");
    assert.equal(broker.upstream, "unsupported");
    assert.deepEqual(double.state.deleted, ["acme/notes-personal"]);

    const again = await adapter.disconnect!(ctx, "broker");
    assert.equal(
      again.broker,
      "not-attempted",
      "deleting twice is not an effect",
    );

    const revoked = await adapter.revoke!(ctx);
    assert.equal(
      revoked.upstream,
      "unsupported",
      "Smithery cannot revoke the upstream provider's grant",
    );
  } finally {
    await double.close();
  }
});

test("custody, support and capability rows describe an execution broker", async () => {
  const { double, adapter } = await harness();
  try {
    assert.deepEqual([...adapter.custody], ["external-execution-broker"]);
    assert.equal(adapter.support, "provider-backed");
    const rows = adapter.capabilities(new Set([SMITHERY_API_KEY]));
    assert.equal(
      rows.find((row) => row.dimension === "invoke")?.implementation,
      "unsupported",
      "no MCP client configured means no approved remote execution",
    );
    assert.equal(
      rows.find((row) => row.dimension === "revoke")?.implementation,
      "unsupported",
    );
    assert.equal(
      rows.find((row) => row.dimension === "authorize")?.configuration,
      "ready",
    );
    assert.equal(
      adapter
        .capabilities(new Set())
        .find((row) => row.dimension === "authorize")?.configuration,
      "missing",
    );
    const withClient = createSmitheryConnectionsAdapter({
      mcpClient: recordingClient().factory,
    });
    assert.equal(
      withClient
        .capabilities(new Set([SMITHERY_API_KEY]))
        .find((row) => row.dimension === "invoke")?.implementation,
      "implemented",
    );
  } finally {
    await double.close();
  }
});

test("a forged namespace or connection id in binding settings is refused", async () => {
  for (const settings of [
    { namespace: "../../admin" },
    { namespace: "__proto__" },
    { connectionId: "a/b" },
    { connectionId: "" },
  ] as Array<Partial<SmitherySettings>>) {
    const { double, ctx, adapter } = await harness({ settings });
    try {
      await assert.rejects(
        () => adapter.verify!(ctx),
        (error: unknown) =>
          error instanceof ConnectorError &&
          (error.code === "invalid-request" ||
            error.code === "configuration-required" ||
            error.code === "denied"),
        JSON.stringify(settings),
      );
      assert.equal(double.requests.length, 0);
    } finally {
      await double.close();
    }
  }
});
