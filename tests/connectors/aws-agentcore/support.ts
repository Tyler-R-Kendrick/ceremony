import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  AGENTCORE_ADAPTER_ID,
  agentCoreConfigurationNames,
} from "../../../src/server/connectors/providers/aws-agentcore/index.js";
import {
  buildBinding,
  buildConnectionSummary,
} from "../fixtures/builders.js";
import { fixtureActor, memoryPorts, type MemoryPorts } from "../doubles/ports.js";

/* Shared fixtures for the AgentCore tests: bindings that pin both legs, and a call context. */

export const GATEWAY_ID = "ceremony-fixture-gw-a1b2c3d4e5";
export const TARGET_NAME = "OrdersApi";
export const TOOL = `${TARGET_NAME}___listOrders`;

export const MANAGEMENT_IDENTITY = {
  accessKeyId: "AKIAFIXTUREMANAGE01",
  secretAccessKey: "fixture-management-secret",
};
export const CALLER_IDENTITY = {
  accessKeyId: "AKIAFIXTURECALLER002",
  secretAccessKey: "fixture-caller-secret",
};
export const CALLER_TOKEN = "fixture-gateway-caller-token";

export type BindingInput = {
  controlOrigin?: string;
  gatewayOrigin?: string;
  gatewayNetwork?: "public" | "approved-private" | "loopback-fixture";
  region?: string;
  inbound?: Record<string, unknown>;
  privateTargets?: string[];
  permittedTargets?: Array<{ kind: string; id: string }>;
  operations?: RuntimeBinding["operations"];
  settings?: Record<string, unknown>;
  omitManagement?: boolean;
  omitGateway?: boolean;
};

export function agentCoreBinding(input: BindingInput = {}): RuntimeBinding {
  const controlOrigin = input.controlOrigin ?? "http://127.0.0.1:1";
  const gatewayOrigin = input.gatewayOrigin ?? "http://127.0.0.1:2";
  const region = input.region ?? "us-east-1";
  const management = {
    destinationId: "control",
    region,
    credentials: {
      accessKeyId: agentCoreConfigurationNames.accessKeyId,
      secretAccessKey: agentCoreConfigurationNames.secretAccessKey,
      sessionToken: agentCoreConfigurationNames.sessionToken,
      expiresAt: agentCoreConfigurationNames.expiresAt,
    },
  };
  const gateway = {
    destinationId: "gateway",
    gatewayIdentifier: GATEWAY_ID,
    endpointPath: "/mcp",
    inbound: input.inbound ?? {
      kind: "oauth-jwt",
      configurationName: agentCoreConfigurationNames.gatewayToken,
    },
    ...(input.privateTargets ? { privateTargets: input.privateTargets } : {}),
  };
  return buildBinding({
    bindingRef: "binding:aws-agentcore",
    definitionRef: "definition:aws-agentcore",
    adapterId: AGENTCORE_ADAPTER_ID,
    adapterVersion: "1.0.0",
    authorityInstance: region,
    destinations: [
      { id: "control", origin: controlOrigin, network: "loopback-fixture" },
      {
        id: "gateway",
        origin: gatewayOrigin,
        network: input.gatewayNetwork ?? "loopback-fixture",
      },
    ],
    operations: input.operations ?? [
      {
        operationRef: "operation:listOrders",
        nativeId: TOOL,
        destinationId: "gateway",
        transport: { kind: "mcp-tool", toolName: TOOL },
        effect: "read",
        outputClassification: "personal",
        cost: "unknown",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "operation:createOrder",
        nativeId: `${TARGET_NAME}___createOrder`,
        destinationId: "gateway",
        transport: {
          kind: "mcp-tool",
          toolName: `${TARGET_NAME}___createOrder`,
        },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
    configuration: [
      agentCoreConfigurationNames.accessKeyId,
      agentCoreConfigurationNames.secretAccessKey,
      agentCoreConfigurationNames.gatewayToken,
    ],
    permittedTargets: input.permittedTargets ?? [
      { kind: "gateway", id: GATEWAY_ID },
      { kind: "agentcore-target", id: TARGET_NAME },
    ],
    settings: input.settings ?? {
      awsAgentCore: {
        ...(input.omitManagement ? {} : { management }),
        ...(input.omitGateway ? {} : { gateway }),
      },
    },
  });
}

export function agentCoreConnection(
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    ...buildConnectionSummary({
      connectionRef: "connection:agentcore",
      bindingRef: "binding:aws-agentcore",
      definitionRef: "definition:aws-agentcore",
      ecosystem: "aws-agentcore",
      service: "aws-agentcore",
      displayName: "AgentCore fixture gateway",
      custody: "host-owned",
      target: { kind: "gateway", id: GATEWAY_ID },
    }),
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: "us-east-1",
    bindingRevision: 1,
    policyRevision: "policy:1",
    configurationRevision: "cfg:1",
    externalIds: { gatewayId: GATEWAY_ID },
    evidenceRefs: [],
    state: {},
    ...overrides,
  };
}

export function agentCoreContext(
  binding: RuntimeBinding,
  ports: MemoryPorts,
  extra: Partial<AdapterCallContext> = {},
): AdapterCallContext {
  return {
    actor: fixtureActor,
    binding,
    generation: 1,
    signal: new AbortController().signal,
    environment: ports.environment({ fetch: globalThis.fetch }),
    ...extra,
  };
}

export function configuredPorts(
  values: Record<string, string | undefined> = {},
): MemoryPorts {
  const ports = memoryPorts();
  const defaults: Record<string, string | undefined> = {
    [agentCoreConfigurationNames.accessKeyId]: MANAGEMENT_IDENTITY.accessKeyId,
    [agentCoreConfigurationNames.secretAccessKey]:
      MANAGEMENT_IDENTITY.secretAccessKey,
    [agentCoreConfigurationNames.gatewayToken]: CALLER_TOKEN,
    ...values,
  };
  for (const [name, value] of Object.entries(defaults))
    if (value !== undefined) ports.configuration.set(name, value);
  return ports;
}
