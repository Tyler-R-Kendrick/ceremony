import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type {
  AdapterCallContext,
  ConnectorAdapter,
} from "../../../src/server/connectors/adapter.js";
import type {
  BoundOperation,
  RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  createNangoAdapter,
  NANGO_ADAPTER_VERSION,
  NANGO_CONFIGURATION_NAMES,
  type NangoAdapter,
  type NangoAdapterOptions,
} from "../../../src/server/connectors/providers/nango/index.js";
import {
  fixtureActor,
  memoryPorts,
  type MemoryPorts,
} from "../doubles/ports.js";
import {
  startNangoDouble,
  type NangoDoubleOptions,
  type NangoDouble,
} from "../doubles/nango.js";

/*
 * Wiring shared by the Nango suites: the loopback double, in-memory ports and
 * a runtime binding built the way a host would build it. Tests assert against
 * the double's recorded requests, so the adapter's own code produces every
 * outgoing message.
 */

export const TENANT = "tenant-a";
export const INTEGRATION = "github-prod";
export const PROVIDER = "github";
export const ENVIRONMENT = "dev";
export const SECRET_KEY = "nango-secret-key-fixture";
export const SIGNING_KEY = "nango-webhook-signing-key-fixture";
export const CONNECTION_ID = "conn-1";

export const sampleIntegrations = [
  {
    unique_key: INTEGRATION,
    display_name: "GitHub",
    provider: PROVIDER,
    created_at: "2026-01-02T03:04:05.000Z",
    updated_at: "2026-02-03T04:05:06.000Z",
    forward_webhooks: true,
  },
  {
    unique_key: "github-sandbox",
    display_name: "GitHub",
    provider: PROVIDER,
    created_at: "2026-01-05T03:04:05.000Z",
    updated_at: "2026-02-06T04:05:06.000Z",
  },
  {
    unique_key: "slack-community",
    display_name: "Slack",
    provider: "slack",
    created_at: "2026-01-07T03:04:05.000Z",
    updated_at: "2026-02-08T04:05:06.000Z",
  },
];

export const sampleFunctions = {
  [INTEGRATION]: [
    {
      type: "sync" as const,
      name: "github-issues",
      description: "Fetches GitHub issues",
      scopes: ["public_repo"],
      returns: ["GithubIssue"],
      json_schema: { type: "object" },
      runs: "every hour",
      auto_start: true,
      track_deletes: false,
      id: 1,
      enabled: true,
      last_deployed: "2026-02-03T04:05:06.000Z",
      source: "repo" as const,
    },
    {
      type: "action" as const,
      name: "create-issue",
      description: "Create a GitHub issue",
      json_schema: { type: "object" },
      id: 2,
      enabled: true,
      last_deployed: "2026-02-03T04:05:06.000Z",
      source: "repo" as const,
    },
    {
      type: "on-event" as const,
      name: "validate",
      event: "validate-connection" as const,
      id: 3,
      enabled: false,
      last_deployed: "2026-02-03T04:05:06.000Z",
      source: "repo" as const,
    },
  ],
};

export function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    connection_id: CONNECTION_ID,
    provider: PROVIDER,
    provider_config_key: INTEGRATION,
    environment: ENVIRONMENT,
    created: "2026-03-01T00:00:00.000Z",
    metadata: null,
    tags: {},
    errors: [],
    ...overrides,
  };
}

export const readOperation: BoundOperation = {
  operationRef: "github.user.read",
  nativeId: "GET /user",
  destinationId: "api",
  transport: { kind: "http", method: "GET", pathTemplate: "/proxy/user" },
  effect: "read",
  outputClassification: "personal",
  cost: "free",
  consent: "none",
  replay: "read-only",
  targetParameters: [],
};

export const writeOperation: BoundOperation = {
  operationRef: "github.issue.create",
  nativeId: "POST /repos/{owner}/{repo}/issues",
  destinationId: "api",
  transport: {
    kind: "http",
    method: "POST",
    pathTemplate: "/proxy/repos/{owner}/{repo}/issues",
  },
  effect: "write",
  outputClassification: "personal",
  cost: "free",
  consent: "confirm",
  replay: "none",
  targetParameters: ["owner"],
};

export const actionOperation: BoundOperation = {
  operationRef: "github.action.create-issue",
  nativeId: "create-issue",
  destinationId: "api",
  transport: { kind: "broker-action", action: "create-issue" },
  effect: "write",
  outputClassification: "personal",
  cost: "free",
  consent: "confirm",
  replay: "none",
  targetParameters: [],
};

export const syncOperation: BoundOperation = {
  operationRef: "github.sync.issues",
  nativeId: "github-issues",
  destinationId: "api",
  transport: { kind: "delegated", route: "sync:github-issues" },
  effect: "read",
  outputClassification: "personal",
  cost: "free",
  consent: "none",
  replay: "read-only",
  targetParameters: [],
};

export const recordsOperation: BoundOperation = {
  operationRef: "github.records.issues",
  nativeId: "GithubIssue",
  destinationId: "api",
  transport: { kind: "delegated", route: "records:GithubIssue" },
  effect: "read",
  outputClassification: "personal",
  cost: "free",
  consent: "none",
  replay: "read-only",
  targetParameters: [],
};

export type BindingOverrides = {
  integration?: { uniqueKey: string; provider: string };
  operations?: BoundOperation[];
  contracts?: Record<string, Record<string, unknown>>;
  webhookUrlOverride?: { url: string; approvedBy: string; approvedAt: string };
  verification?: {
    operationRef: string;
    identityPointer: string;
    targetKind: string;
  };
  presentation?: "popup" | "same-window";
  apiOrigin: string;
  connectOrigin?: string;
  bindingRef?: string;
  tenantId?: string;
};

export function makeBinding(overrides: BindingOverrides): RuntimeBinding {
  const integration = overrides.integration ?? {
    uniqueKey: INTEGRATION,
    provider: PROVIDER,
  };
  return runtimeBindingSchema.parse({
    bindingRef: overrides.bindingRef ?? "binding:nango-1",
    definitionRef: "def:nango-1",
    revision: 3,
    adapterId: "nango",
    adapterVersion: NANGO_ADAPTER_VERSION,
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: `nango:${ENVIRONMENT}:${overrides.apiOrigin}`,
    status: "approved",
    approvedAt: "2026-03-01T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: overrides.tenantId ?? TENANT,
    destinations: [
      { id: "api", origin: overrides.apiOrigin, network: "loopback-fixture" },
      {
        id: "connect",
        origin: overrides.connectOrigin ?? "https://connect.nango.dev",
        network: "public",
      },
    ],
    operations: overrides.operations ?? [
      readOperation,
      writeOperation,
      actionOperation,
      syncOperation,
    ],
    configuration: [
      NANGO_CONFIGURATION_NAMES.secretKey,
      NANGO_CONFIGURATION_NAMES.environment,
    ],
    permittedTargets: [{ kind: "github-account", id: "octocat" }],
    reviewedDigest: "a".repeat(64),
    settings: {
      integration,
      presentation: overrides.presentation ?? "popup",
      ...(overrides.webhookUrlOverride
        ? { webhookUrlOverride: overrides.webhookUrlOverride }
        : {}),
      ...(overrides.verification
        ? { verification: overrides.verification }
        : {}),
      operations: overrides.contracts ?? {},
    },
  });
}

export function makeConnection(
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    connectionRef: "conn:nango-local-1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "nango",
    service: "github",
    displayName: "GitHub via Nango",
    ownerKind: "user",
    custody: "external-credential-broker",
    runtime: "hosted-server",
    lifecycle: "authorization-required",
    generation: 0,
    revision: 1,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    tenantId: binding.tenantId,
    ownerId: fixtureActor.subjectId,
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

/** An active connection holding the protected broker reference, as completion leaves it. */
export async function activeConnection(
  ports: MemoryPorts,
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): Promise<ConnectionRecord> {
  const base = makeConnection(binding, overrides);
  const integration = (
    binding.settings as { integration: { uniqueKey: string } }
  ).integration;
  const credentialRef = await ports.credentials.store(
    {
      tenantId: base.tenantId,
      ownerKind: base.ownerKind,
      ownerId: base.ownerId,
      connectionRef: base.connectionRef,
      bindingRef: base.bindingRef,
      custody: "external-credential-broker",
    },
    {
      connectionId: String(
        overrides.externalIds?.connectionId ?? CONNECTION_ID,
      ),
      providerConfigKey: String(
        overrides.externalIds?.providerConfigKey ?? integration.uniqueKey,
      ),
      environment: ENVIRONMENT,
      authority: binding.authorityInstance,
    },
  );
  return {
    ...base,
    lifecycle: "active",
    credentialRef,
    externalIds: {
      connectionId: CONNECTION_ID,
      providerConfigKey: integration.uniqueKey,
      provider: PROVIDER,
      environment: ENVIRONMENT,
      ...(overrides.externalIds ?? {}),
    },
    ...overrides,
  };
}

export type Harness = {
  adapter: NangoAdapter;
  double: NangoDouble;
  ports: MemoryPorts;
  binding: RuntimeBinding;
  actor: ActorContext;
  context(overrides?: {
    connection?: ConnectionRecord;
    actor?: ActorContext;
    binding?: RuntimeBinding;
    generation?: number;
    signal?: AbortSignal;
    fetch?: typeof fetch;
  }): AdapterCallContext;
  close(): Promise<void>;
};

export async function harness(
  options: {
    double?: Partial<NangoDoubleOptions>;
    binding?: Omit<BindingOverrides, "apiOrigin"> & { apiOrigin?: string };
    adapter?: NangoAdapterOptions;
    configuration?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
): Promise<Harness> {
  const double = await startNangoDouble({
    apiKey: SECRET_KEY,
    environment: ENVIRONMENT,
    integrations: sampleIntegrations,
    functions: sampleFunctions,
    ...options.double,
  });
  const ports = memoryPorts(options.now ? { now: options.now } : {});
  ports.configuration.set(NANGO_CONFIGURATION_NAMES.secretKey, SECRET_KEY);
  ports.configuration.set(NANGO_CONFIGURATION_NAMES.environment, ENVIRONMENT);
  ports.configuration.set(
    NANGO_CONFIGURATION_NAMES.webhookSigningKey,
    SIGNING_KEY,
  );
  for (const [name, value] of Object.entries(options.configuration ?? {}))
    ports.configuration.set(name, value);
  const binding = makeBinding({ apiOrigin: double.origin, ...options.binding });
  const adapter = createNangoAdapter(options.adapter ?? {});
  return {
    adapter,
    double,
    ports,
    binding,
    actor: fixtureActor,
    context(overrides = {}) {
      return {
        actor: overrides.actor ?? fixtureActor,
        binding: overrides.binding ?? binding,
        ...(overrides.connection ? { connection: overrides.connection } : {}),
        generation:
          overrides.generation ?? overrides.connection?.generation ?? 0,
        signal: overrides.signal ?? new AbortController().signal,
        environment: ports.environment({ fetch: overrides.fetch ?? fetch }),
      };
    },
    async close() {
      await double.close();
    },
  };
}

export function capabilityFor(
  adapter: ConnectorAdapter,
  dimension: string,
  present: string[],
) {
  return adapter
    .capabilities(new Set(present))
    .find((status) => status.dimension === dimension);
}

/** Every string anywhere in a value, for leak assertions. */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out.push(key);
      stringsIn(item, out);
    }
  return out;
}
