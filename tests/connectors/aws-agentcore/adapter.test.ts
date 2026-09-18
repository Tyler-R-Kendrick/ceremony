import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConnectorAdapterRegistry,
  type AdapterCallContext,
} from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { catalogEntryFor } from "../../../src/server/connectors/inventory.js";
import {
  AGENTCORE_ADAPTER_ID,
  agentCoreConfigurationNames,
  agentCoreSettingsSchema,
  createAgentCoreGatewayAdapter,
} from "../../../src/server/connectors/providers/aws-agentcore/index.js";
import {
  startAgentCoreControlDouble,
  startAgentCoreGatewayDouble,
  type DoubleTarget,
} from "../doubles/aws-agentcore.js";
import {
  CALLER_TOKEN,
  GATEWAY_ID,
  MANAGEMENT_IDENTITY,
  TARGET_NAME,
  TOOL,
  agentCoreBinding,
  agentCoreConnection,
  agentCoreContext,
  configuredPorts,
} from "./support.js";

/*
 * The adapter end to end against two independent loopback doubles: the
 * control plane and a gateway's MCP endpoint. The tests assert the two
 * identities never cross, that nothing the adapter can do writes to AWS, that
 * an account number never leaves it, and that an uncertain tool call is
 * reported as uncertain rather than replayed.
 */

const ACCOUNT = "123456789012";
const adapter = createAgentCoreGatewayAdapter();

const openApiSchema = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Orders", version: "1.0.0" },
  servers: [{ url: "https://api.orders.example/v1" }],
  paths: {
    "/orders": {
      get: {
        operationId: "listOrders",
        parameters: [
          { name: "since", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createOrder",
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
});

const brokenOpenApi = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Broken", version: "1.0.0" },
  servers: [{ url: "https://{yourDomain}/" }],
  components: { securitySchemes: { apiKey: { type: "apiKey" } } },
  paths: {
    "/things": {
      get: { responses: { "200": { description: "no operation id" } } },
      post: {
        operationId: "writeThing",
        requestBody: {
          content: {
            "application/json": {
              schema: { oneOf: [{ type: "object" }, { type: "string" }] },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/streamed": {
      get: {
        operationId: "streamThing",
        parameters: [
          { name: "ids", in: "query", style: "form", explode: true },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const targets: DoubleTarget[] = [
  {
    targetId: "AbCdEf1234",
    name: TARGET_NAME,
    targetConfiguration: {
      mcp: { openApiSchema: { inlinePayload: openApiSchema } },
    },
    credentialProviderType: "OAUTH",
  },
  {
    targetId: "ZyXwVu9876",
    name: "Broken",
    targetConfiguration: {
      mcp: { openApiSchema: { inlinePayload: brokenOpenApi } },
    },
    credentialProviderType: "API_KEY",
  },
  {
    targetId: "LmNoPq5555",
    name: "Notifier",
    targetConfiguration: {
      mcp: {
        lambda: {
          lambdaArn:
            "arn:aws:lambda:us-east-1:123456789012:function:notify-fixture",
          toolSchema: {
            inlinePayload: [
              {
                name: "notify",
                description: "Send a notification",
                inputSchema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                },
              },
              { name: "no_description", inputSchema: { type: "object" } },
            ],
          },
        },
      },
    },
    credentialProviderType: "GATEWAY_IAM_ROLE",
  },
  {
    targetId: "RemoteMcp1",
    name: "RemoteTools",
    targetConfiguration: {
      mcp: { mcpServer: { endpoint: "https://tools.example/mcp" } },
    },
    credentialProviderType: "JWT_PASSTHROUGH",
    privateEndpoint: { managedVpcResource: { vpcIdentifier: "vpc-0fixture" } },
  },
];

const tools = [
  {
    name: TOOL,
    description: "List orders",
    call: (args: Record<string, unknown>) => ({
      content: [{ type: "text", text: `orders since ${String(args["since"])}` }],
      structuredContent: { orders: [] },
    }),
  },
  {
    name: `${TARGET_NAME}___createOrder`,
    description: "Create an order",
    call: () => ({ content: [{ type: "text", text: "created" }] }),
  },
];

async function withDoubles<T>(
  work: (context: {
    control: Awaited<ReturnType<typeof startAgentCoreControlDouble>>;
    gateway: Awaited<ReturnType<typeof startAgentCoreGatewayDouble>>;
  }) => Promise<T>,
  options: {
    gatewayFaults?: Parameters<typeof startAgentCoreGatewayDouble>[0]["faults"];
    supportedVersions?: string[];
  } = {},
): Promise<T> {
  const control = await startAgentCoreControlDouble({
    identities: [MANAGEMENT_IDENTITY],
    region: "us-east-1",
    gateways: [
      {
        gatewayId: GATEWAY_ID,
        name: "OrdersGateway",
        accountId: ACCOUNT,
        discoveryUrl:
          "https://idp.example/.well-known/openid-configuration",
        ...(options.supportedVersions
          ? { supportedVersions: options.supportedVersions }
          : {}),
      },
    ],
    targets: { [GATEWAY_ID]: targets },
  });
  const gateway = await startAgentCoreGatewayDouble({
    tools,
    bearerTokens: [CALLER_TOKEN],
    ...(options.gatewayFaults ? { faults: options.gatewayFaults } : {}),
  });
  try {
    return await work({ control, gateway });
  } finally {
    await control.close();
    await gateway.close();
  }
}

function contextFor(
  control: { origin: string },
  gateway: { origin: string },
  ports = configuredPorts(),
  binding = agentCoreBinding({
    controlOrigin: control.origin,
    gatewayOrigin: gateway.origin,
  }),
): { ctx: AdapterCallContext; ports: ReturnType<typeof configuredPorts> } {
  return {
    ctx: agentCoreContext(binding, ports, {
      connection: agentCoreConnection(),
    }),
    ports,
  };
}

test("the catalog entry is provider-backed and says per dimension what it cannot do", () => {
  const registry = new ConnectorAdapterRegistry();
  registry.register(adapter);
  assert.equal(registry.require(AGENTCORE_ADAPTER_ID).ecosystem, "aws-agentcore");
  const configured = new Set([
    agentCoreConfigurationNames.accessKeyId,
    agentCoreConfigurationNames.secretAccessKey,
    agentCoreConfigurationNames.gatewayToken,
  ]);
  const rows = adapter.capabilities(configured);
  assert.equal(rows.length, 12);
  const byDimension = new Map(rows.map((row) => [row.dimension, row]));
  for (const dimension of ["discover", "import", "verify", "invoke", "disconnect"] as const)
    assert.equal(byDimension.get(dimension)?.implementation, "implemented");
  for (const dimension of [
    "configure",
    "authorize",
    "events",
    "reconnect",
    "revoke",
    "export",
    "delegate",
  ] as const) {
    assert.equal(byDimension.get(dimension)?.implementation, "unsupported");
    assert.equal(byDimension.get(dimension)?.evidence, "not-tested");
    assert.ok((byDimension.get(dimension)?.limitations.length ?? 0) > 0);
  }
  const entry = catalogEntryFor(adapter, configured);
  assert.equal(entry.support, "provider-backed");
  assert.equal(
    catalogEntryFor(adapter, new Set()).support,
    "unconfigured",
    "a deployment without AWS credentials is unconfigured, not unsupported",
  );
  assert.ok(
    entry.capabilities.every((row) => row.evidence !== "live-authorized"),
    "fixtures never claim live evidence",
  );
});

test("a binding may not point the gateway caller at a management credential", () => {
  const shared = {
    management: {
      destinationId: "control",
      region: "us-east-1",
      credentials: {
        accessKeyId: "AWS_AGENTCORE_ACCESS_KEY_ID",
        secretAccessKey: "AWS_AGENTCORE_SECRET_ACCESS_KEY",
      },
    },
    gateway: {
      destinationId: "gateway",
      gatewayIdentifier: GATEWAY_ID,
      inbound: {
        kind: "iam-sigv4",
        region: "us-east-1",
        credentials: {
          accessKeyId: "AWS_AGENTCORE_ACCESS_KEY_ID",
          secretAccessKey: "AWS_AGENTCORE_SECRET_ACCESS_KEY",
        },
      },
    },
  };
  const rejected = agentCoreSettingsSchema.safeParse(shared);
  assert.equal(rejected.success, false);
  const separated = agentCoreSettingsSchema.safeParse({
    ...shared,
    gateway: {
      ...shared.gateway,
      inbound: {
        kind: "iam-sigv4",
        region: "us-east-1",
        credentials: {
          accessKeyId: "AWS_AGENTCORE_GATEWAY_ACCESS_KEY_ID",
          secretAccessKey: "AWS_AGENTCORE_GATEWAY_SECRET_ACCESS_KEY",
        },
      },
    },
  });
  assert.equal(separated.success, true);
});

test("without credentials every consequential path is configuration-required and nothing is attempted", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx } = contextFor(
      control,
      gateway,
      configuredPorts({
        [agentCoreConfigurationNames.accessKeyId]: undefined,
        [agentCoreConfigurationNames.secretAccessKey]: undefined,
        [agentCoreConfigurationNames.gatewayToken]: undefined,
      }),
    );
    const started = await adapter.authorize!(ctx, {
      ownerKind: "workload",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    });
    assert.equal(started.kind, "configuration-required");
    assert.deepEqual(
      started.kind === "configuration-required" ? started.missing : [],
      [agentCoreConfigurationNames.gatewayToken],
    );
    await assert.rejects(
      adapter.verify!(ctx),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required",
    );
    await assert.rejects(
      adapter.invoke!(ctx, {
        operationRef: "operation:listOrders",
        input: {},
        commandId: "command-1",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required",
    );
    assert.equal(control.requests.length, 0);
    assert.equal(gateway.requests.length, 0);
  });
});

test("discovery reads gateways and targets and never emits an ARN or account number", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx } = contextFor(control, gateway);
    const gateways = await adapter.discover!(ctx, {});
    assert.deepEqual(
      gateways.items.map((item) => item.identity.nativeId),
      [GATEWAY_ID],
    );
    assert.equal(gateways.items[0]?.identity.authorityNamespace, "us-east-1");
    const discovered = await adapter.discover!(ctx, {
      scope: { gatewayIdentifier: GATEWAY_ID },
    });
    assert.deepEqual(
      discovered.items.map((item) => item.displayName),
      [TARGET_NAME, "Broken", "Notifier", "RemoteTools"],
    );
    assert.equal(
      discovered.items[0]?.provenance?.["tools"],
      "2",
      "an OpenAPI target with two clean operations offers two tools",
    );
    assert.equal(discovered.items[1]?.provenance?.["tools"], "0");
    assert.equal(discovered.items[3]?.provenance?.["privateEndpoint"], "true");
    const serialized = JSON.stringify([gateways, discovered]);
    assert.ok(
      !serialized.includes(ACCOUNT),
      "an account number never leaves the adapter",
    );
    assert.ok(!serialized.includes("arn:aws:"));
    assert.ok(
      discovered.issues.some(
        (issue) => issue.code === "agentcore.openapi.operation-id-missing",
      ),
    );
  });
});

test("a caller-supplied gateway name is a request, not an authority", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx } = contextFor(control, gateway);
    await assert.rejects(
      adapter.discover!(ctx, {
        scope: { gatewayIdentifier: "someone-elses-gw-0123456789" },
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "agentcore.gateway.not-permitted",
    );
    assert.equal(control.requests.length, 0);
  });
});

test("import reports incompatible OpenAPI, Lambda and synchronized targets instead of assuming tools", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx } = contextFor(control, gateway);
    const captured = {
      region: "us-east-1",
      gateway: {
        gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:gateway/${GATEWAY_ID}`,
        gatewayId: GATEWAY_ID,
        gatewayUrl: `${gateway.origin}/mcp`,
        name: "OrdersGateway",
        status: "READY",
        authorizerType: "CUSTOM_JWT",
        authorizerConfiguration: {
          customJWTAuthorizer: {
            discoveryUrl: "https://idp.example/.well-known/openid-configuration",
          },
        },
        protocolType: "MCP",
        protocolConfiguration: { mcp: { supportedVersions: ["2026-07-28"] } },
        updatedAt: "2026-09-10T00:00:00Z",
      },
      targets: targets.map((target) => ({
        targetId: target.targetId,
        name: target.name,
        status: "READY",
        protocolType: "MCP",
        ...(target.targetConfiguration
          ? { targetConfiguration: target.targetConfiguration }
          : {}),
        ...(target.credentialProviderType
          ? {
              credentialProviderConfigurations: [
                { credentialProviderType: target.credentialProviderType },
              ],
            }
          : {}),
        ...(target.privateEndpoint
          ? { privateEndpoint: target.privateEndpoint }
          : {}),
      })),
    };
    const outcome = await adapter.import!(ctx, {
      bytes: new TextEncoder().encode(JSON.stringify(captured)),
      mediaType: "application/json",
      origin: { kind: "provider-api" },
    });
    const [definition] = outcome.definitions;
    assert.ok(definition);
    assert.deepEqual(
      definition.capabilities.map((capability) => capability.nativeId),
      [
        `${TARGET_NAME}___listOrders`,
        `${TARGET_NAME}___createOrder`,
        "Notifier___notify",
      ],
      "only operations the gateway can actually expose become capabilities",
    );
    assert.equal(definition.authentication[0]?.kind, "openid-connect");
    const codes = outcome.issues.map((issue) => issue.code);
    for (const code of [
      "agentcore.openapi.operation-id-missing",
      "agentcore.openapi.schema-composition",
      "agentcore.openapi.parameter-serializer",
      "agentcore.openapi.security-scheme",
      "agentcore.openapi.server-host-templated",
      "agentcore.lambda.tool-description-missing",
      "agentcore.target.mcp-server-synchronized",
      "agentcore.target.jwt-passthrough",
      "agentcore.target.private-endpoint",
    ] as const)
      assert.ok(codes.includes(code), `expected issue ${code}`);
    const security = outcome.issues.filter(
      (issue) => issue.category === "security" && issue.disposition === "unsupported",
    );
    assert.ok(
      security.every((issue) => issue.severity === "blocking"),
      "an unsupported security requirement is always blocking",
    );
    assert.ok(
      definition.capabilities.every(
        (capability) => capability.effect === "unknown",
      ),
      "a tool's effect is never guessed from its name or method",
    );
    assert.ok(!JSON.stringify(outcome).includes(ACCOUNT));
  });
});

test("a Swagger 2.0 target is blocked outright and the rest of the gateway stays visible", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx } = contextFor(control, gateway);
    const outcome = await adapter.import!(ctx, {
      bytes: new TextEncoder().encode(
        JSON.stringify({
          region: "us-east-1",
          gateway: {
            gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:gateway/${GATEWAY_ID}`,
            gatewayId: GATEWAY_ID,
            name: "OrdersGateway",
            status: "READY",
            authorizerType: "NONE",
            protocolType: "MCP",
          },
          targets: [
            {
              targetId: "SwaggerOne",
              name: "Legacy",
              status: "READY",
              targetConfiguration: {
                mcp: {
                  openApiSchema: {
                    inlinePayload: JSON.stringify({
                      swagger: "2.0",
                      info: { title: "Legacy", version: "1" },
                      paths: {},
                    }),
                  },
                },
              },
            },
          ],
        }),
      ),
      mediaType: "application/json",
      origin: { kind: "provider-api" },
    });
    const codes = outcome.issues.map((issue) => issue.code);
    assert.ok(codes.includes("agentcore.openapi.swagger-2"));
    assert.ok(
      codes.includes("agentcore.gateway.no-inbound-authorization"),
      "a gateway with no inbound authorization blocks authorization",
    );
    assert.deepEqual(outcome.executableCandidates, []);
    assert.equal(outcome.definitions[0]?.authentication[0]?.kind, "none");
  });
});

test("verification keeps the management claim and the caller claim apart, and the credentials never cross", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx } = contextFor(control, gateway);
    const result = await adapter.verify!(ctx);
    assert.equal(result.state, "complete");
    assert.deepEqual(
      result.claims.map((claim) => claim.kind),
      ["resource-access", "credential-accepted"],
    );
    const [management, caller] = result.claims;
    assert.equal(management?.target.id, GATEWAY_ID);
    assert.match(
      management?.limitations[0] ?? "",
      /not the caller's authority/,
    );
    assert.deepEqual(caller?.permissions?.observed, []);
    assert.equal(caller?.permissions?.semantics, "unknown");

    for (const request of control.requests) {
      const authorization = request.headers["authorization"] ?? "";
      assert.match(
        authorization,
        new RegExp(`Credential=${MANAGEMENT_IDENTITY.accessKeyId}/`),
      );
      assert.ok(!authorization.includes(CALLER_TOKEN));
    }
    for (const seen of gateway.seen) {
      assert.equal(seen.authorization, `Bearer ${CALLER_TOKEN}`);
      assert.ok(!seen.authorization.includes(MANAGEMENT_IDENTITY.accessKeyId));
      assert.equal(seen.protocolVersion, "2026-07-28");
      assert.equal(seen.mcpMethod, seen.method);
    }
    assert.ok(!JSON.stringify(result).includes(ACCOUNT));
  });
});

test("a read tool call goes through the approved operation and returns the gateway's own result", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx, ports } = contextFor(control, gateway);
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:listOrders",
      input: { since: "2026-09-01" },
      commandId: "command-read-1",
    });
    assert.equal(result.state, "complete");
    assert.equal(result.effect, "read");
    assert.equal(result.outputClassification, "personal");
    assert.deepEqual(
      (result.output as { structuredContent?: unknown }).structuredContent,
      { orders: [] },
    );
    assert.equal(gateway.seen.at(-1)?.name, TOOL);
    assert.equal(
      ports.inspect.effects().length,
      0,
      "a read-only operation needs no effect journal entry",
    );
  });
});

test("an uncertain write is journaled as indeterminate and never blindly replayed", async () => {
  await withDoubles(
    async ({ control, gateway }) => {
      const { ctx, ports } = contextFor(control, gateway);
      const first = await adapter.invoke!(ctx, {
        operationRef: "operation:createOrder",
        input: { sku: "abc" },
        commandId: "command-write-1",
      });
      assert.equal(first.state, "indeterminate");
      assert.equal(first.code, "agentcore.call.uncertain");
      const journalled = ports.inspect.effects();
      assert.equal(journalled.length, 1);
      assert.equal(journalled[0]?.outcome?.status, "indeterminate");

      const replay = await adapter.invoke!(ctx, {
        operationRef: "operation:createOrder",
        input: { sku: "abc" },
        commandId: "command-write-1",
      });
      assert.equal(replay.state, "indeterminate");
      assert.equal(replay.code, "agentcore.effect.replayed");
      assert.equal(
        gateway.callCount(),
        1,
        "the repeated request never reached the gateway a second time",
      );
    },
    { gatewayFaults: { dropCallAt: 1 } },
  );
});

test("a completed write is journaled once and a repeat returns the recorded outcome", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx, ports } = contextFor(control, gateway);
    const request = {
      operationRef: "operation:createOrder",
      input: { sku: "abc" },
      commandId: "command-write-2",
    };
    const first = await adapter.invoke!(ctx, request);
    assert.equal(first.state, "complete");
    assert.equal(ports.inspect.effects()[0]?.outcome?.status, "applied");
    const second = await adapter.invoke!(ctx, request);
    assert.equal(second.state, "complete");
    assert.equal(second.code, "agentcore.effect.replayed");
    assert.equal(gateway.callCount(), 1);
  });
});

test("an interim input_required result suspends the call without leaking the interim payload", async () => {
  await withDoubles(
    async ({ control, gateway }) => {
      const { ctx } = contextFor(control, gateway);
      const result = await adapter.invoke!(ctx, {
        operationRef: "operation:createOrder",
        input: { sku: "abc" },
        commandId: "command-write-3",
      });
      assert.equal(result.state, "human-required");
      assert.equal(result.code, "agentcore.call.input-required");
      assert.equal(result.output, undefined);
      assert.equal(result.handoff?.kind, "input-required");
      assert.deepEqual(Object.keys(result.handoff?.private ?? {}).sort(), [
        "commandId",
        "operationRef",
        "toolName",
      ]);
    },
    { gatewayFaults: { inputRequired: true } },
  );
});

test("operation, target and network policy are checked before any credential is used", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const base = {
      controlOrigin: control.origin,
      gatewayOrigin: gateway.origin,
    };
    const cases: Array<{
      binding: ReturnType<typeof agentCoreBinding>;
      operationRef: string;
      code: ConnectorError["code"];
      detail: string;
    }> = [
      {
        binding: agentCoreBinding(base),
        operationRef: "operation:notApproved",
        code: "denied",
        detail: "agentcore.operation.unapproved",
      },
      {
        binding: agentCoreBinding({
          ...base,
          permittedTargets: [{ kind: "gateway", id: GATEWAY_ID }],
        }),
        operationRef: "operation:listOrders",
        code: "denied",
        detail: "agentcore.target.not-permitted",
      },
      {
        binding: agentCoreBinding({
          ...base,
          privateTargets: [TARGET_NAME],
        }),
        operationRef: "operation:listOrders",
        code: "network-policy",
        detail: "agentcore.target.private-endpoint",
      },
      {
        binding: agentCoreBinding({
          ...base,
          operations: [
            {
              operationRef: "operation:flat",
              nativeId: "flatTool",
              destinationId: "gateway",
              transport: { kind: "mcp-tool", toolName: "flatTool" },
              effect: "read",
              outputClassification: "public",
              cost: "free",
              consent: "none",
              replay: "read-only",
              targetParameters: [],
            },
          ],
        }),
        operationRef: "operation:flat",
        code: "invalid-request",
        detail: "agentcore.tool.not-namespaced",
      },
    ];
    for (const item of cases) {
      const ports = configuredPorts();
      const ctx = agentCoreContext(item.binding, ports, {
        connection: agentCoreConnection(),
      });
      await assert.rejects(
        adapter.invoke!(ctx, {
          operationRef: item.operationRef,
          input: {},
          commandId: "command-policy",
        }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === item.code &&
          error.detail === item.detail,
        `${item.operationRef} should fail with ${item.detail}`,
      );
    }
    assert.equal(
      gateway.requests.length,
      0,
      "policy failures never reach the gateway",
    );
  });
});

test("a private target may be invoked only through an administrator-approved private destination", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const ports = configuredPorts();
    const binding = agentCoreBinding({
      controlOrigin: control.origin,
      gatewayOrigin: gateway.origin,
      privateTargets: [TARGET_NAME],
      gatewayNetwork: "approved-private",
    });
    const ctx = agentCoreContext(binding, ports, {
      connection: agentCoreConnection(),
    });
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:listOrders",
      input: { since: "2026-09-01" },
      commandId: "command-private",
    });
    assert.equal(result.state, "complete");
  });
});

test("a gateway that does not support this MCP revision is a blocking version issue, not a silent downgrade", async () => {
  await withDoubles(
    async ({ control, gateway }) => {
      const { ctx } = contextFor(control, gateway);
      const outcome = await adapter.import!(ctx, {
        bytes: new TextEncoder().encode(
          JSON.stringify({
            region: "us-east-1",
            gateway: {
              gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:gateway/${GATEWAY_ID}`,
              gatewayId: GATEWAY_ID,
              name: "OrdersGateway",
              status: "READY",
              authorizerType: "CUSTOM_JWT",
              protocolType: "MCP",
              protocolConfiguration: {
                mcp: { supportedVersions: ["2025-11-25"] },
              },
            },
            targets: [],
          }),
        ),
        mediaType: "application/json",
        origin: { kind: "provider-api" },
      });
      const issue = outcome.issues.find(
        (item) => item.code === "agentcore.gateway.protocol-version",
      );
      assert.ok(issue);
      assert.equal(issue.severity, "blocking");
      assert.match(issue.remediation ?? "", /2025-11-25/);
    },
    { supportedVersions: ["2025-11-25"] },
  );
});

test("disconnect is local only and never deletes AWS configuration", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const { ctx } = contextFor(control, gateway);
    for (const scope of ["local", "broker", "upstream"] as const) {
      const result = await adapter.disconnect!(ctx, scope);
      assert.equal(result.local, "applied");
      if (scope === "broker") assert.equal(result.broker, "unsupported");
      if (scope === "upstream") assert.equal(result.upstream, "unsupported");
    }
    assert.deepEqual(
      [...new Set(control.requests.map((request) => request.method))],
      [],
      "no control-plane request is made for a local disconnect",
    );
  });
});

test("the caller token may live in connection custody and never leaves it", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const ports = configuredPorts({
      [agentCoreConfigurationNames.gatewayToken]: undefined,
    });
    const connection = agentCoreConnection();
    const credentialRef = await ports.credentials.store(
      {
        tenantId: connection.tenantId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        connectionRef: connection.connectionRef,
        bindingRef: "binding:aws-agentcore",
        custody: connection.custody,
      },
      { accessToken: CALLER_TOKEN },
    );
    const binding = agentCoreBinding({
      controlOrigin: control.origin,
      gatewayOrigin: gateway.origin,
      inbound: { kind: "oauth-jwt", source: "connection" },
    });
    const ctx = agentCoreContext(binding, ports, {
      connection: { ...connection, credentialRef },
    });
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:listOrders",
      input: { since: "2026-09-01" },
      commandId: "command-custody",
    });
    assert.equal(result.state, "complete");
    assert.ok(
      !JSON.stringify(result).includes(CALLER_TOKEN),
      "the token never appears in a result",
    );
    assert.equal(gateway.seen.at(-1)?.authorization, `Bearer ${CALLER_TOKEN}`);
  });
});
