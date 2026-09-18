import { runtimeBindingSchema, type RuntimeBinding } from "../../../../src/server/connectors/binding.js";
import type { AdapterCallContext } from "../../../../src/server/connectors/adapter.js";
import type { ConnectionRecord } from "../../../../src/server/connectors/ports.js";
import { fixtureActor, memoryPorts, type MemoryPorts } from "../../doubles/ports.js";

/*
 * Binding and call-context fixtures for the four Supabase profiles. Each
 * binding is parsed by the runtime schema, so a fixture cannot approve
 * something the product would reject, and every destination points at a
 * loopback double on an ephemeral port.
 */

export const HEX = "0123456789abcdef".repeat(4);
export const AT = "2026-09-18T00:00:00.000Z";
export const PROJECT_REF = "abcdefghijklmnopqrst";
export const OTHER_PROJECT_REF = "zyxwvutsrqponmlkjihg";
export const ORGANIZATION_SLUG = "fixture-org";
export const OTHER_ORGANIZATION_SLUG = "other-org";
export const HOST_ORIGIN = "https://app.example";
export const CALLBACK_PATH = "/api/v1/connectors/supabase-management/callback";

export const managementOperationTemplates = {
  "v1-list-all-projects": { pathTemplate: "/v1/projects", targetParameters: [] },
  "v1-get-project": {
    pathTemplate: "/v1/projects/{ref}",
    targetParameters: ["ref"],
  },
  "v1-list-all-organizations": {
    pathTemplate: "/v1/organizations",
    targetParameters: [],
  },
  "v1-get-an-organization": {
    pathTemplate: "/v1/organizations/{slug}",
    targetParameters: ["slug"],
  },
  "v1-list-organization-members": {
    pathTemplate: "/v1/organizations/{slug}/members",
    targetParameters: ["slug"],
  },
} as const;

export type ManagementOperationId = keyof typeof managementOperationTemplates;

export function managementBinding(input: {
  origin: string;
  permittedTargets?: Array<{ kind: string; id: string }>;
  operations?: ManagementOperationId[];
  overrides?: Partial<RuntimeBinding>;
}): RuntimeBinding {
  const operations = input.operations ?? [
    "v1-list-all-projects",
    "v1-get-project",
    "v1-list-all-organizations",
    "v1-get-an-organization",
    "v1-list-organization-members",
  ];
  return runtimeBindingSchema.parse({
    bindingRef: "binding:supabase-management",
    definitionRef: "definition:supabase-management",
    revision: 1,
    adapterId: "supabase-management",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: "https://api.supabase.com",
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:1",
    tenantId: fixtureActor.tenantId,
    profileId: "oauth-authorization-code",
    destinations: [
      { id: "api", origin: input.origin, network: "loopback-fixture" },
    ],
    operations: operations.map((nativeId) => ({
      operationRef: `operation:${nativeId}`,
      nativeId,
      destinationId: "api",
      transport: {
        kind: "http",
        method: "GET",
        pathTemplate: managementOperationTemplates[nativeId].pathTemplate,
      },
      effect: "read",
      outputClassification: "personal",
      cost: "free",
      consent: "none",
      replay: "read-only",
      targetParameters: [...managementOperationTemplates[nativeId].targetParameters],
      authenticationProfile: "oauth-authorization-code",
    })),
    configuration: ["SUPABASE_OAUTH_CLIENT_ID", "SUPABASE_OAUTH_CLIENT_SECRET"],
    permittedTargets: input.permittedTargets ?? [
      { kind: "supabase-project", id: PROJECT_REF },
      { kind: "supabase-organization", id: ORGANIZATION_SLUG },
    ],
    reviewedDigest: HEX,
    settings: {},
    ...input.overrides,
  });
}

export function mcpBinding(input: {
  origin: string;
  settings: Record<string, unknown>;
  tools?: Array<{ name: string; effect?: "read" | "write" }>;
  permittedTargets?: Array<{ kind: string; id: string }>;
  overrides?: Partial<RuntimeBinding>;
}): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:supabase-mcp",
    definitionRef: "definition:supabase-mcp",
    revision: 1,
    adapterId: "supabase-mcp",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: "https://mcp.supabase.com",
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:1",
    tenantId: fixtureActor.tenantId,
    destinations: [
      {
        id: "mcp",
        origin: input.origin,
        pathPrefix: "/mcp",
        network: "loopback-fixture",
      },
    ],
    operations: (input.tools ?? []).map((tool) => ({
      operationRef: `operation:${tool.name}`,
      nativeId: tool.name,
      destinationId: "mcp",
      transport: { kind: "mcp-tool", toolName: tool.name },
      effect: tool.effect ?? "read",
      outputClassification: "personal",
      cost: "unknown",
      consent: tool.effect === "write" ? "confirm" : "none",
      replay: tool.effect === "write" ? "none" : "read-only",
      targetParameters: [],
    })),
    configuration: [],
    permittedTargets: input.permittedTargets ?? [
      { kind: "supabase-project", id: PROJECT_REF },
    ],
    reviewedDigest: HEX,
    settings: { "supabase-mcp": input.settings },
    ...input.overrides,
  });
}

export function dataApiBinding(input: {
  origin: string;
  settings: Record<string, unknown>;
  permittedTargets?: Array<{ kind: string; id: string }>;
  overrides?: Partial<RuntimeBinding>;
}): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:supabase-data-api",
    definitionRef: "definition:supabase-data-api",
    revision: 1,
    adapterId: "supabase-data-api",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: `https://${PROJECT_REF}.supabase.co`,
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:1",
    tenantId: fixtureActor.tenantId,
    destinations: [
      { id: "project", origin: input.origin, network: "loopback-fixture" },
    ],
    operations: [
      {
        operationRef: "operation:select",
        nativeId: "postgrest.select",
        destinationId: "project",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/rest/v1/{table}",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: ["table"],
      },
    ],
    configuration: ["SUPABASE_PUBLISHABLE_KEY"],
    permittedTargets: input.permittedTargets ?? [
      { kind: "supabase-project", id: PROJECT_REF },
      { kind: "supabase-table", id: "notes" },
    ],
    reviewedDigest: HEX,
    settings: { "supabase-data-api": input.settings },
    ...input.overrides,
  });
}

export function wrappersBinding(input: {
  settings: Record<string, unknown>;
  tables?: string[];
  permittedTargets?: Array<{ kind: string; id: string }>;
  overrides?: Partial<RuntimeBinding>;
}): RuntimeBinding {
  const tables = input.tables ?? ["private_stripe.products"];
  return runtimeBindingSchema.parse({
    bindingRef: "binding:supabase-wrappers",
    definitionRef: "definition:supabase-wrappers",
    revision: 1,
    adapterId: "supabase-wrappers",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "external-execution-broker",
    authorityInstance: "postgres://project",
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:1",
    tenantId: fixtureActor.tenantId,
    destinations: [],
    operations: tables.map((table) => ({
      operationRef: `operation:${table}`,
      nativeId: table,
      destinationId: "db",
      transport: { kind: "delegated", route: "wrappers-select" },
      effect: "read",
      outputClassification: "personal",
      cost: "unknown",
      consent: "none",
      replay: "read-only",
      targetParameters: [],
    })),
    configuration: [],
    permittedTargets:
      input.permittedTargets ??
      tables.map((table) => ({ kind: "supabase-foreign-table", id: table })),
    reviewedDigest: HEX,
    settings: { "supabase-wrappers": input.settings },
    ...input.overrides,
    // Operations reference a destination that must exist; a delegated route
    // still names one, so the fixture adds it unless overridden.
    ...(input.overrides?.destinations
      ? {}
      : {
          destinations: [
            { id: "db", origin: "https://db.example", network: "public" },
          ],
        }),
  });
}

export function connectionRecord(
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    connectionRef: "connection:supabase-1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: binding.adapterId === "supabase-mcp" ? "mcp" : "supabase",
    service: "supabase",
    displayName: "Supabase",
    ownerKind: "user",
    custody: binding.custody,
    runtime: "hosted-server",
    lifecycle: "authorization-required",
    generation: 0,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    sessionId: fixtureActor.sessionId,
    authorityInstance: binding.authorityInstance,
    bindingRevision: binding.revision,
    policyRevision: binding.policyRevision,
    configurationRevision: "cfg:1",
    externalIds: {},
    evidenceRefs: [],
    state: {},
    ...overrides,
  };
}

export type SupabaseHarness = {
  ports: MemoryPorts;
  ctx: AdapterCallContext;
  connection: ConnectionRecord;
  /** Replaces the context's connection and generation, as the command layer would. */
  with(patch: Partial<ConnectionRecord>, generation?: number): AdapterCallContext;
  close(): void;
};

export async function supabaseHarness(input: {
  binding: RuntimeBinding;
  fetch: typeof fetch;
  connection?: Partial<ConnectionRecord> | null;
  configuration?: Record<string, string>;
  origin?: string;
  now?: () => number;
}): Promise<SupabaseHarness> {
  const ports = memoryPorts(input.now ? { now: input.now } : {});
  for (const [name, value] of Object.entries(input.configuration ?? {}))
    ports.configuration.set(name, value);
  const controller = new AbortController();
  const record =
    input.connection === null
      ? undefined
      : connectionRecord(input.binding, input.connection ?? {});
  if (record) await ports.connections.create(record);
  const environment = ports.environment({
    fetch: input.fetch,
    origin: input.origin ?? HOST_ORIGIN,
  });
  const base = {
    actor: fixtureActor,
    binding: input.binding,
    generation: record?.generation ?? 0,
    signal: controller.signal,
    environment,
  };
  const ctx: AdapterCallContext = record
    ? { ...base, connection: record }
    : base;
  return {
    ports,
    ctx,
    connection: record ?? connectionRecord(input.binding),
    with(patch, generation) {
      const next = { ...(record ?? connectionRecord(input.binding)), ...patch };
      return {
        ...base,
        connection: next,
        generation: generation ?? next.generation,
      };
    },
    close() {
      controller.abort();
    },
  };
}
