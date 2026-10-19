import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { buildBinding, buildConnectionSummary } from "../fixtures/builders.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  DAPR_ADAPTER_ID,
  DAPR_API_TOKEN_CONFIGURATION,
  daprBindingPath,
} from "../../../src/server/connectors/providers/dapr/index.js";

/* A Dapr binding and call context over the in-memory ports, shared by the Dapr suites. */

export const API_TOKEN = "fixture-dapr-api-token";

export function connectionRecord(): ConnectionRecord {
  return {
    ...buildConnectionSummary({
      connectionRef: "connection:dapr",
      bindingRef: "binding:dapr",
      definitionRef: "definition:dapr",
      ecosystem: "dapr",
      service: "dapr",
      displayName: "Dapr sidecar",
      target: undefined,
      verification: undefined,
    }),
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: "dapr-fixture",
    bindingRevision: 1,
    policyRevision: "policy:1",
    configurationRevision: "cfg:1",
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
}

export function harness(options: {
  origin: string;
  operations?: Record<
    string,
    { operations: string[]; metadataKeys?: string[] }
  >;
  inputBindings?: string[];
  unauthenticated?: boolean;
  network?: "loopback-fixture" | "public";
  pathTemplate?: string;
  method?: "POST" | "GET";
  componentName?: string;
}) {
  const componentName = options.componentName ?? "orders-topic";
  const ports = memoryPorts();
  if (!options.unauthenticated)
    ports.configuration.set(DAPR_API_TOKEN_CONFIGURATION, API_TOKEN);
  const outputBindings = Object.fromEntries(
    Object.entries(
      options.operations ?? { [componentName]: { operations: ["create"] } },
    ).map(([name, value]) => [
      name,
      { operations: value.operations, metadataKeys: value.metadataKeys ?? [] },
    ]),
  );
  const binding = buildBinding({
    bindingRef: "binding:dapr",
    definitionRef: "definition:dapr",
    adapterId: DAPR_ADAPTER_ID,
    destinations: [
      {
        id: "sidecar",
        origin: options.origin,
        network: options.network ?? "loopback-fixture",
      },
    ],
    operations: [
      {
        operationRef: "operation:orders",
        nativeId: componentName,
        destinationId: "sidecar",
        transport: {
          kind: "http",
          method: options.method ?? "POST",
          pathTemplate: options.pathTemplate ?? daprBindingPath(componentName),
        },
        effect: "write",
        outputClassification: "personal",
        cost: "unknown",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
    configuration: [],
    settings: {
      dapr: {
        destinationId: "sidecar",
        ...(options.unauthenticated
          ? { unauthenticatedSidecar: true }
          : { apiTokenConfiguration: DAPR_API_TOKEN_CONFIGURATION }),
        appApiTokenConfiguration: "DAPR_APP_API_TOKEN",
        appId: "ceremony-fixture-app",
        outputBindings,
        inputBindings: options.inputBindings ?? [],
      },
    },
    profileId: undefined,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection: connectionRecord(),
    generation: 0,
    signal: AbortSignal.timeout(10_000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return { ports, binding, ctx };
}
