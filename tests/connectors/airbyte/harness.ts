import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import {
  airbyteConfigurationNames,
  createAirbyteAdapter,
} from "../../../src/server/connectors/providers/airbyte/index.js";
import { startAirbyteApiDouble } from "../doubles/airbyte-api.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  connectionId,
  foreignConnection,
  postgresSource,
  sourceId,
  unreachableSource,
  warehouseConnection,
  workspaceId,
} from "../fixtures/airbyte/deployment.js";

/* The Airbyte adapter against its API double, shared by the Airbyte suites. */

export const bindingFor = (
  origin: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding =>
  runtimeBindingSchema.parse({
    bindingRef: "binding:airbyte:1",
    definitionRef: "def:airbyte:1",
    revision: 3,
    adapterId: "airbyte",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    profileId: "airbyte-api",
    destinations: [{ id: "api", origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "op:source.get",
        nativeId: "airbyte.source.get",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/sources/{sourceId}",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: ["sourceId"],
      },
      {
        operationRef: "op:connection.get",
        nativeId: "airbyte.connection.get",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/connections/{connectionId}",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: ["connectionId"],
      },
      {
        operationRef: "op:streams",
        nativeId: "airbyte.streams.discover",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/streams" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: ["sourceId"],
      },
      {
        operationRef: "op:job.sync",
        nativeId: "airbyte.job.sync",
        destinationId: "api",
        transport: { kind: "http", method: "POST", pathTemplate: "/jobs" },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: ["connectionId"],
      },
      {
        operationRef: "op:job.reset",
        nativeId: "airbyte.job.reset",
        destinationId: "api",
        transport: { kind: "http", method: "POST", pathTemplate: "/jobs" },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: ["connectionId"],
      },
      {
        operationRef: "op:job.get",
        nativeId: "airbyte.job.get",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/jobs/{jobId}",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:job.cancel",
        nativeId: "airbyte.job.cancel",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "DELETE",
          pathTemplate: "/jobs/{jobId}",
        },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "reconciliation",
        targetParameters: [],
      },
    ],
    configuration: [
      airbyteConfigurationNames.apiUrl,
      airbyteConfigurationNames.apiKey,
    ],
    permittedTargets: [
      { kind: "airbyte-source", id: sourceId },
      { kind: "airbyte-connection", id: connectionId },
    ],
    reviewedDigest: "a".repeat(64),
    settings: {},
    ...overrides,
  });

export const connectionRecord = (
  binding: RuntimeBinding,
): ConnectionRecord => ({
  connectionRef: "conn:airbyte:1",
  bindingRef: binding.bindingRef,
  definitionRef: binding.definitionRef,
  ecosystem: "airbyte",
  service: "airbyte",
  displayName: "Airbyte deployment",
  ownerKind: "organization",
  custody: "host-owned",
  runtime: "hosted-server",
  lifecycle: "active",
  generation: 1,
  revision: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
  tenantId: fixtureActor.tenantId,
  ownerId: fixtureActor.subjectId,
  authorityInstance: binding.authorityInstance,
  bindingRevision: binding.revision,
  policyRevision: binding.policyRevision,
  configurationRevision: "cfg:1",
  externalIds: { sourceId, workspaceId, connectionId },
  evidenceRefs: [],
  state: {},
});

export async function harness(
  options: Parameters<typeof startAirbyteApiDouble>[0] = {},
  bindingOverrides: Partial<RuntimeBinding> = {},
  adapterOptions: Parameters<typeof createAirbyteAdapter>[0] = {},
) {
  const double = await startAirbyteApiDouble({
    apiKey: "deployment-key",
    sources: [postgresSource, unreachableSource],
    connections: [warehouseConnection, foreignConnection],
    ...options,
  });
  const ports = memoryPorts({ now: () => 1_770_000_000_000 });
  ports.configuration.set(airbyteConfigurationNames.apiUrl, double.apiUrl);
  ports.configuration.set(airbyteConfigurationNames.apiKey, "deployment-key");
  const binding = bindingFor(double.origin, bindingOverrides);
  const record = connectionRecord(binding);
  await ports.connections.create(record);
  const controller = new AbortController();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection: record,
    generation: 1,
    signal: controller.signal,
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return {
    double,
    ports,
    binding,
    ctx,
    adapter: createAirbyteAdapter(adapterOptions),
    async close() {
      controller.abort();
      await double.close();
    },
  };
}
