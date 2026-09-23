import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  agentCoreConfigurationNames,
  createAgentCoreGatewayAdapter,
} from "../../../src/server/connectors/providers/aws-agentcore/index.js";
import {
  startAgentCoreControlDouble,
  startAgentCoreGatewayDouble,
} from "../doubles/aws-agentcore.js";
import {
  CALLER_IDENTITY,
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
 * AC-EXT-17 (AWS half): "AWS gateway caller/target credentials ... substituted
 * -> inbound/outbound identities and resource bounds stay separate."
 *
 * Each assertion below is one substitution attempt, named so the report says
 * which one held.
 */

const adapter = createAgentCoreGatewayAdapter();

async function withDoubles<T>(
  work: (context: {
    control: Awaited<ReturnType<typeof startAgentCoreControlDouble>>;
    gateway: Awaited<ReturnType<typeof startAgentCoreGatewayDouble>>;
  }) => Promise<T>,
  gatewayOptions: Partial<
    Parameters<typeof startAgentCoreGatewayDouble>[0]
  > = {},
): Promise<T> {
  const control = await startAgentCoreControlDouble({
    identities: [MANAGEMENT_IDENTITY],
    region: "us-east-1",
    gateways: [{ gatewayId: GATEWAY_ID, name: "OrdersGateway" }],
    targets: {
      [GATEWAY_ID]: [
        {
          targetId: "AbCdEf1234",
          name: TARGET_NAME,
          credentialProviderType: "OAUTH",
          targetConfiguration: {
            mcp: {
              openApiSchema: {
                inlinePayload: JSON.stringify({
                  openapi: "3.0.0",
                  info: { title: "Orders", version: "1" },
                  servers: [{ url: "https://api.orders.example" }],
                  paths: {
                    "/orders": {
                      get: {
                        operationId: "listOrders",
                        responses: { "200": { description: "ok" } },
                      },
                    },
                  },
                }),
              },
            },
          },
        },
      ],
    },
  });
  const gateway = await startAgentCoreGatewayDouble({
    tools: [{ name: TOOL, call: () => ({ content: [] }) }],
    bearerTokens: [CALLER_TOKEN],
    ...gatewayOptions,
  });
  try {
    return await work({ control, gateway });
  } finally {
    await control.close();
    await gateway.close();
  }
}

test("AC-EXT-17: the management identity is never used as the gateway caller", async () => {
  await withDoubles(async ({ control, gateway }) => {
    /*
     * The binding selects IAM inbound authorization with its own key names.
     * Only the management key is configured, so the call must stop at
     * configuration-required; falling back to the credential that happens to
     * be present would be exactly the substitution this oracle forbids.
     */
    const ports = configuredPorts({
      [agentCoreConfigurationNames.gatewayToken]: undefined,
    });
    const binding = agentCoreBinding({
      controlOrigin: control.origin,
      gatewayOrigin: gateway.origin,
      inbound: {
        kind: "iam-sigv4",
        region: "us-east-1",
        credentials: {
          accessKeyId: agentCoreConfigurationNames.gatewayAccessKeyId,
          secretAccessKey: agentCoreConfigurationNames.gatewaySecretAccessKey,
        },
      },
    });
    const ctx = agentCoreContext(binding, ports, {
      connection: agentCoreConnection(),
    });
    await assert.rejects(
      adapter.invoke!(ctx, {
        operationRef: "operation:listOrders",
        input: {},
        commandId: "command-substitute-1",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required" &&
        error.detail === "agentcore.gateway.credentials.missing",
    );
    assert.equal(gateway.requests.length, 0);
  });
});

test("AC-EXT-17: a separate caller identity signs the gateway and never the control plane", async () => {
  await withDoubles(
    async ({ control, gateway }) => {
      const ports = configuredPorts({
        [agentCoreConfigurationNames.gatewayToken]: undefined,
        [agentCoreConfigurationNames.gatewayAccessKeyId]:
          CALLER_IDENTITY.accessKeyId,
        [agentCoreConfigurationNames.gatewaySecretAccessKey]:
          CALLER_IDENTITY.secretAccessKey,
      });
      const binding = agentCoreBinding({
        controlOrigin: control.origin,
        gatewayOrigin: gateway.origin,
        inbound: {
          kind: "iam-sigv4",
          region: "us-east-1",
          credentials: {
            accessKeyId: agentCoreConfigurationNames.gatewayAccessKeyId,
            secretAccessKey: agentCoreConfigurationNames.gatewaySecretAccessKey,
          },
        },
      });
      const ctx = agentCoreContext(binding, ports, {
        connection: agentCoreConnection(),
      });
      const result = await adapter.verify!(ctx);
      assert.equal(result.state, "complete");
      for (const request of control.requests)
        assert.match(
          request.headers["authorization"] ?? "",
          new RegExp(`Credential=${MANAGEMENT_IDENTITY.accessKeyId}/`),
          "the control plane only ever sees the management identity",
        );
      for (const seen of gateway.seen)
        assert.match(
          seen.authorization,
          new RegExp(`Credential=${CALLER_IDENTITY.accessKeyId}/`),
          "the gateway only ever sees the caller identity",
        );
    },
    {
      bearerTokens: undefined,
      sigv4Callers: [CALLER_IDENTITY],
      sigv4: { region: "us-east-1", service: "bedrock-agentcore" },
    },
  );
});

test("AC-EXT-17: outbound target credentials are reported, never held or sent", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const ports = configuredPorts();
    const ctx = agentCoreContext(
      agentCoreBinding({
        controlOrigin: control.origin,
        gatewayOrigin: gateway.origin,
      }),
      ports,
      { connection: agentCoreConnection() },
    );
    const discovered = await adapter.discover!(ctx, {
      scope: { gatewayIdentifier: GATEWAY_ID },
    });
    assert.equal(
      discovered.items[0]?.provenance?.["outboundCredential"],
      "OAUTH",
      "the target's own credential provider is reported",
    );
    await adapter.invoke!(ctx, {
      operationRef: "operation:listOrders",
      input: {},
      commandId: "command-outbound",
    });
    /*
     * The gateway exchanges credentials with the target inside AWS. Ceremony
     * holds none of them, so the only credential on the wire is the caller's,
     * and every control-plane path is a documented gateway read.
     */
    for (const request of control.requests)
      assert.match(request.url.pathname, /^\/gateways\//);
    assert.deepEqual(
      [...new Set(gateway.requests.map((request) => request.url.pathname))],
      ["/mcp"],
    );
    for (const request of gateway.requests) {
      const names = Object.keys(request.headers);
      assert.ok(
        !names.some(
          (name) =>
            name.includes("credential") ||
            name === "x-amz-target-credential" ||
            name.includes("api-key"),
        ),
        `unexpected credential header: ${names.join(",")}`,
      );
    }
  });
});

test("AC-EXT-17: resource bounds hold when a caller names another gateway or target", async () => {
  await withDoubles(async ({ control, gateway }) => {
    const ports = configuredPorts();
    const ctx = agentCoreContext(
      agentCoreBinding({
        controlOrigin: control.origin,
        gatewayOrigin: gateway.origin,
      }),
      ports,
      { connection: agentCoreConnection() },
    );
    await assert.rejects(
      adapter.discover!(ctx, {
        scope: { gatewayIdentifier: "another-tenant-gw-9876543210" },
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
    const foreignTarget = agentCoreBinding({
      controlOrigin: control.origin,
      gatewayOrigin: gateway.origin,
      operations: [
        {
          operationRef: "operation:foreign",
          nativeId: "Foreign___listOrders",
          destinationId: "gateway",
          transport: { kind: "mcp-tool", toolName: "Foreign___listOrders" },
          effect: "read",
          outputClassification: "public",
          cost: "free",
          consent: "none",
          replay: "read-only",
          targetParameters: [],
        },
      ],
    });
    await assert.rejects(
      adapter.invoke!(
        agentCoreContext(foreignTarget, configuredPorts(), {
          connection: agentCoreConnection(),
        }),
        {
          operationRef: "operation:foreign",
          input: {},
          commandId: "command-foreign",
        },
      ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "agentcore.target.not-permitted",
    );
  });
});
