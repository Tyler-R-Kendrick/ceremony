import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  GOOGLE_CONNECTORS_ADAPTER_ID,
  googleConnectorsConfigurationNames,
} from "../../../src/server/connectors/providers/google-integration-connectors/index.js";
import { buildBinding, buildConnectionSummary } from "../fixtures/builders.js";
import {
  fixtureActor,
  memoryPorts,
  type MemoryPorts,
} from "../doubles/ports.js";

/* Shared fixtures: a binding that pins project, location, connection and identity. */

export const PROJECT = "ceremony-fixture-project";
export const LOCATION = "us-central1";
export const CONNECTION = "orders-salesforce";
export const ENTITY_TYPE = "Account";
export const ACTION = "SendEmail";
export const ACCESS_TOKEN = "fixture-google-access-token";
export const END_USER_TOKEN = "fixture-google-end-user-token";
export const RESOURCE_NAME = `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`;

export type GoogleBindingInput = {
  origin?: string;
  runtimeOrigin?: string;
  runtimeNetwork?: "public" | "approved-private" | "loopback-fixture";
  project?: string;
  location?: string;
  connection?: string;
  identity?: Record<string, unknown>;
  operations?: RuntimeBinding["operations"];
  permittedTargets?: Array<{ kind: string; id: string }>;
};

export function googleBinding(input: GoogleBindingInput = {}): RuntimeBinding {
  const origin = input.origin ?? "http://127.0.0.1:1";
  const runtimeOrigin = input.runtimeOrigin ?? origin;
  const project = input.project ?? PROJECT;
  const location = input.location ?? LOCATION;
  const connection = input.connection ?? CONNECTION;
  const resourcePath = `/v2/projects/${project}/locations/${location}/connections/${connection}`;
  return buildBinding({
    bindingRef: "binding:google-connectors",
    definitionRef: "definition:google-connectors",
    adapterId: GOOGLE_CONNECTORS_ADAPTER_ID,
    adapterVersion: "1.0.0",
    authorityInstance: location,
    destinations: [
      { id: "admin", origin, network: "loopback-fixture" },
      {
        id: "runtime",
        origin: runtimeOrigin,
        network: input.runtimeNetwork ?? "loopback-fixture",
      },
    ],
    operations: input.operations ?? [
      {
        operationRef: "operation:accounts.list",
        nativeId: "entities.list",
        destinationId: "runtime",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: `${resourcePath}/entityTypes/${ENTITY_TYPE}/entities`,
        },
        effect: "read",
        outputClassification: "personal",
        cost: "unknown",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "operation:accounts.get",
        nativeId: "entities.get",
        destinationId: "runtime",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: `${resourcePath}/entityTypes/${ENTITY_TYPE}/entities/{entityId}`,
        },
        effect: "read",
        outputClassification: "personal",
        cost: "unknown",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "operation:sendEmail",
        nativeId: "actions.execute",
        destinationId: "runtime",
        transport: {
          kind: "http",
          method: "POST",
          pathTemplate: `${resourcePath}/actions/${ACTION}:execute`,
        },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
    configuration: [googleConnectorsConfigurationNames.accessToken],
    permittedTargets: input.permittedTargets ?? [
      { kind: "connection", id: CONNECTION },
      { kind: "entity-type", id: ENTITY_TYPE },
      { kind: "action", id: ACTION },
    ],
    settings: {
      googleConnectors: {
        admin: { destinationId: "admin" },
        runtime: { destinationId: "runtime" },
        resource: { project, location, connection },
        identity: input.identity ?? {
          kind: "service-identity",
          configurationName: googleConnectorsConfigurationNames.accessToken,
        },
      },
    },
  });
}

export function googleConnection(
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    ...buildConnectionSummary({
      connectionRef: "connection:google",
      bindingRef: "binding:google-connectors",
      definitionRef: "definition:google-connectors",
      ecosystem: "google-integration-connectors",
      service: "google-integration-connectors",
      displayName: "Orders Salesforce connection",
      custody: "host-owned",
      target: { kind: "connection", id: RESOURCE_NAME },
    }),
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: LOCATION,
    bindingRevision: 1,
    policyRevision: "policy:1",
    configurationRevision: "cfg:1",
    externalIds: { connection: RESOURCE_NAME },
    evidenceRefs: [],
    state: {},
    ...overrides,
  };
}

export function googleContext(
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

export function googlePorts(
  values: Record<string, string | undefined> = {},
): MemoryPorts {
  const ports = memoryPorts();
  const defaults: Record<string, string | undefined> = {
    [googleConnectorsConfigurationNames.accessToken]: ACCESS_TOKEN,
    ...values,
  };
  for (const [name, value] of Object.entries(defaults))
    if (value !== undefined) ports.configuration.set(name, value);
  return ports;
}
