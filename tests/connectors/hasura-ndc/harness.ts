import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import { createHasuraNdcAdapter } from "../../../src/server/connectors/providers/hasura-ndc/index.js";
import { startNdcConnectorDouble } from "../doubles/ndc-connector.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  articleRows,
  authorRows,
  fullCapabilities,
  NDC_VERSION,
  schema,
} from "../fixtures/hasura-ndc/connector.js";

/* The Hasura NDC adapter against its connector double, shared by its suites. */

export const approvedArticles = {
  kind: "collection",
  target: "articles",
  fields: ["id", "title", "author_id"],
  arguments: [],
  requestArguments: [],
  predicates: [
    { column: "id", operators: ["eq", "lt", "is_null"] },
    { column: "title", operators: ["like"] },
  ],
  relationships: [
    {
      name: "article_author",
      targetCollection: "authors",
      fields: ["id", "name"],
    },
  ],
  aggregates: [{ column: "id", functions: ["max"], starCount: true }],
  orderBy: ["id"],
  maxRows: 2,
};

export const approvedProcedure = {
  kind: "procedure",
  target: "upsert_article",
  fields: ["id", "title"],
  arguments: ["article"],
  requestArguments: [],
  predicates: [],
  relationships: [],
  aggregates: [],
  orderBy: [],
  maxRows: 1,
};

export const approvedFunction = {
  kind: "function",
  target: "latest_article_id",
  fields: ["__value"],
  arguments: [],
  requestArguments: [],
  predicates: [],
  relationships: [],
  aggregates: [],
  orderBy: [],
  maxRows: 1,
};

export function bindingFor(
  origin: string,
  options: {
    capabilities?: Record<string, unknown>;
    version?: string;
    operations?: Record<string, unknown>;
  } = {},
): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:ndc:1",
    definitionRef: "def:ndc:1",
    revision: 2,
    adapterId: "hasura-ndc",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    destinations: [{ id: "connector", origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "op:articles.read",
        nativeId: "articles",
        destinationId: "connector",
        transport: { kind: "http", method: "POST", pathTemplate: "/query" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:latest.read",
        nativeId: "latest_article_id",
        destinationId: "connector",
        transport: { kind: "http", method: "POST", pathTemplate: "/query" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:article.upsert",
        nativeId: "upsert_article",
        destinationId: "connector",
        transport: { kind: "http", method: "POST", pathTemplate: "/mutation" },
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
    reviewedDigest: "b".repeat(64),
    settings: {
      "ndc.reviewed": {
        version: options.version ?? NDC_VERSION,
        capabilities: options.capabilities ?? fullCapabilities,
        schema,
      },
      "ndc.operations": options.operations ?? {
        "op:articles.read": approvedArticles,
        "op:latest.read": approvedFunction,
        "op:article.upsert": approvedProcedure,
      },
    },
  });
}

export async function harness(
  options: {
    capabilities?: Record<string, unknown>;
    version?: string;
    operations?: Record<string, unknown>;
    doubleOptions?: Parameters<typeof startNdcConnectorDouble>[0];
    adapterOptions?: Parameters<typeof createHasuraNdcAdapter>[0];
  } = {},
) {
  const double = await startNdcConnectorDouble({
    version: options.version ?? NDC_VERSION,
    capabilities: options.capabilities ?? fullCapabilities,
    schema,
    rows: { articles: articleRows, authors: authorRows },
    procedureResults: { upsert_article: { id: 4, title: "New" } },
    ...options.doubleOptions,
  });
  const ports = memoryPorts({ now: () => 1_770_000_000_000 });
  const binding = bindingFor(double.origin, options);
  const record: ConnectionRecord = {
    connectionRef: "conn:ndc:1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "hasura-ndc",
    service: "hasura-ndc",
    displayName: "NDC connector",
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
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
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
    ctx,
    adapter: createHasuraNdcAdapter(options.adapterOptions),
    async close() {
      controller.abort();
      await double.close();
    },
  };
}
