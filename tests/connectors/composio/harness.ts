import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type {
  AdapterCallContext,
  ConnectorAdapter,
} from "../../../src/server/connectors/adapter.js";
import {
  runtimeBindingSchema,
  type BoundOperation,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import type {
  ConnectionRecord,
  HandoffRecord,
} from "../../../src/server/connectors/ports.js";
import {
  createComposioAdapter,
  composioConfigurationNames,
  composioUserId,
  COMPOSIO_ADAPTER_VERSION,
  type ComposioAdapterOptions,
} from "../../../src/server/connectors/providers/composio/index.js";
import {
  fixtureActor,
  memoryPorts,
  type MemoryPorts,
} from "../doubles/ports.js";
import {
  startComposioDouble,
  type ComposioDouble,
  type ComposioDoubleOptions,
  type DoubleAccount,
} from "../doubles/composio.js";
import { canaries } from "../fixtures/builders.js";

/*
 * Wiring shared by the Composio suites: the loopback double, in-memory ports
 * and a runtime binding built the way a host would build one. Tests assert
 * against the double's recorded requests, so the adapter's own code produces
 * every outgoing message and the double — written from the documentation —
 * decides whether that message is acceptable.
 */

export const TENANT = "tenant-a";
export const API_KEY = "composio-project-api-key-fixture";
export const TOOLKIT = "github";
export const TOOLKIT_VERSION = "20260901_00";
export const OLD_VERSION = "20260801_00";
export const RETIRED_VERSION = "20250101_00";
export const AUTH_CONFIG = "ac_fixtureprimary01";
export const OTHER_AUTH_CONFIG = "ac_fixturesecondary";
export const ACCOUNT_A = "ca_fixtureaccountaaa";
export const ACCOUNT_B = "ca_fixtureaccountbbb";
export const READ_TOOL = "GITHUB_LIST_REPOSITORIES";
export const WRITE_TOOL = "GITHUB_CREATE_AN_ISSUE";

export const sampleToolkits = [
  {
    slug: TOOLKIT,
    name: "GitHub",
    enabled: true,
    composio_managed_auth_schemes: ["OAUTH2"],
    auth_config_details: [
      { mode: "OAUTH2", name: "GitHub OAuth", required_scopes: ["repo"] },
    ],
    meta: {
      description: "GitHub repositories, issues and pull requests.",
      toolkit_version: TOOLKIT_VERSION,
      tools_count: 2,
    },
  },
  {
    slug: "slack",
    name: "Slack",
    enabled: true,
    composio_managed_auth_schemes: ["OAUTH2"],
    meta: { description: "Slack messaging." },
  },
];

export const sampleAuthConfigs = [
  {
    id: AUTH_CONFIG,
    name: "GitHub production",
    status: "ENABLED",
    auth_scheme: "OAUTH2",
    is_composio_managed: true,
    toolkit: { slug: TOOLKIT },
    // Documented field. It must never reach a discovery item or a claim.
    credentials: { client_secret: canaries.secret },
  },
  {
    id: OTHER_AUTH_CONFIG,
    name: "GitHub sandbox",
    status: "ENABLED",
    auth_scheme: "API_KEY",
    is_composio_managed: false,
    toolkit: { slug: TOOLKIT },
  },
];

export const sampleTools = [
  {
    slug: READ_TOOL,
    name: "List repositories",
    description: "Lists repositories the account can see.",
    version: TOOLKIT_VERSION,
    available_versions: [TOOLKIT_VERSION, OLD_VERSION],
    input_parameters: {
      type: "object",
      properties: { per_page: { type: "integer" } },
    },
    scopes: ["repo"],
    toolkit: { slug: TOOLKIT },
  },
  {
    slug: WRITE_TOOL,
    name: "Create an issue",
    description: "Creates an issue in a repository.",
    version: TOOLKIT_VERSION,
    available_versions: [TOOLKIT_VERSION, OLD_VERSION],
    input_parameters: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
      },
    },
    scopes: ["repo"],
    toolkit: { slug: TOOLKIT },
  },
];

export function account(overrides: Partial<DoubleAccount> = {}): DoubleAccount {
  return {
    id: ACCOUNT_A,
    user_id: composioUserId({
      tenantId: TENANT,
      ownerKind: "user",
      ownerId: fixtureActor.subjectId,
    }),
    status: "ACTIVE",
    toolkit: { slug: TOOLKIT },
    auth_config: { id: AUTH_CONFIG, auth_scheme: "OAUTH2" },
    // Composio redacts credential fields; a double that returns one proves the
    // adapter never reads or projects them.
    state: { authScheme: "OAUTH2", val: { access_token: canaries.token } },
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

export const readOperation: BoundOperation = {
  operationRef: "composio.repos.list",
  nativeId: READ_TOOL,
  destinationId: "api",
  transport: { kind: "broker-action", action: READ_TOOL },
  effect: "read",
  outputClassification: "personal",
  cost: "free",
  consent: "none",
  replay: "read-only",
  targetParameters: [],
};

export const writeOperation: BoundOperation = {
  operationRef: "composio.issue.create",
  nativeId: WRITE_TOOL,
  destinationId: "api",
  transport: { kind: "broker-action", action: WRITE_TOOL },
  effect: "write",
  outputClassification: "personal",
  cost: "free",
  consent: "confirm",
  replay: "none",
  targetParameters: ["owner"],
};

export const sessionOperation: BoundOperation = {
  operationRef: "composio.session.repos",
  nativeId: READ_TOOL,
  destinationId: "api",
  transport: { kind: "delegated", route: `session:${READ_TOOL}` },
  effect: "read",
  outputClassification: "personal",
  cost: "free",
  consent: "none",
  replay: "read-only",
  targetParameters: [],
};

export const metaOperation: BoundOperation = {
  operationRef: "composio.meta.connections",
  nativeId: "COMPOSIO_MANAGE_CONNECTIONS",
  destinationId: "api",
  transport: { kind: "delegated", route: "meta:COMPOSIO_MANAGE_CONNECTIONS" },
  effect: "write",
  outputClassification: "personal",
  cost: "free",
  consent: "confirm",
  replay: "none",
  targetParameters: [],
};

/** An unapproved tool that is bound anyway; the allowlist is what stops it. */
export const unlistedOperation: BoundOperation = {
  operationRef: "composio.repos.delete",
  nativeId: "GITHUB_DELETE_A_REPOSITORY",
  destinationId: "api",
  transport: { kind: "broker-action", action: "GITHUB_DELETE_A_REPOSITORY" },
  effect: "write",
  outputClassification: "personal",
  cost: "free",
  consent: "confirm",
  replay: "none",
  targetParameters: [],
};

export type BindingOverrides = {
  apiOrigin: string;
  connectOrigin?: string;
  operations?: BoundOperation[];
  settings?: Record<string, unknown>;
  permittedTargets?: Array<{ kind: string; id: string }>;
  bindingRef?: string;
  tenantId?: string;
  revision?: number;
};

export function defaultSettings(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    toolkit: { slug: TOOLKIT, version: TOOLKIT_VERSION },
    authConfigs: [AUTH_CONFIG],
    tools: [READ_TOOL, WRITE_TOOL],
    execution: "direct",
    presentation: "popup",
    operations: {
      [readOperation.operationRef]: { arguments: ["per_page"] },
      [writeOperation.operationRef]: {
        arguments: ["owner", "repo", "title"],
      },
      [sessionOperation.operationRef]: { arguments: ["per_page"] },
      [metaOperation.operationRef]: { arguments: [] },
      [unlistedOperation.operationRef]: { arguments: [] },
    },
    ...overrides,
  };
}

export function makeBinding(overrides: BindingOverrides): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: overrides.bindingRef ?? "binding:composio-1",
    definitionRef: "definition:composio-github",
    revision: overrides.revision ?? 4,
    adapterId: "composio",
    adapterVersion: COMPOSIO_ADAPTER_VERSION,
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: `composio:${overrides.apiOrigin}/api/v3`,
    status: "approved",
    approvedAt: "2026-03-01T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: overrides.tenantId ?? TENANT,
    destinations: [
      { id: "api", origin: overrides.apiOrigin, network: "loopback-fixture" },
      {
        id: "connect",
        origin: overrides.connectOrigin ?? overrides.apiOrigin,
        network: "loopback-fixture",
      },
    ],
    operations: overrides.operations ?? [
      readOperation,
      writeOperation,
      sessionOperation,
      metaOperation,
      unlistedOperation,
    ],
    configuration: [composioConfigurationNames.apiKey],
    permittedTargets: overrides.permittedTargets ?? [
      { kind: "connected-account", id: ACCOUNT_A },
      { kind: "github-owner", id: "octocat" },
    ],
    reviewedDigest: "b".repeat(64),
    settings: overrides.settings ?? defaultSettings(),
  });
}

export function makeConnection(
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    connectionRef: "connection:composio-1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "composio",
    service: "github",
    displayName: "GitHub via Composio",
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

/** A connection as completion leaves it: active, bound to one account. */
export function activeConnection(
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  const userId = composioUserId({
    tenantId: binding.tenantId,
    ownerKind: "user",
    ownerId: fixtureActor.subjectId,
  });
  return makeConnection(binding, {
    lifecycle: "active",
    externalIds: {
      connectedAccountId: ACCOUNT_A,
      authConfigId: AUTH_CONFIG,
      toolkitSlug: TOOLKIT,
      toolkitVersion: TOOLKIT_VERSION,
      userId,
      authority: binding.authorityInstance,
      authScheme: "OAUTH2",
      ...(overrides.externalIds ?? {}),
    },
    state: { composioStatus: "ACTIVE", ...(overrides.state ?? {}) },
    ...overrides,
  });
}

export type Harness = {
  adapter: ConnectorAdapter;
  double: ComposioDouble;
  ports: MemoryPorts;
  binding: RuntimeBinding;
  actor: ActorContext;
  userId: string;
  context(overrides?: {
    connection?: ConnectionRecord;
    actor?: ActorContext;
    binding?: RuntimeBinding;
    handoff?: HandoffRecord;
    generation?: number;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    origin?: string;
  }): AdapterCallContext;
  close(): Promise<void>;
};

export async function harness(
  options: {
    double?: Partial<ComposioDoubleOptions>;
    binding?: Omit<BindingOverrides, "apiOrigin"> & { apiOrigin?: string };
    adapter?: ComposioAdapterOptions;
    configuration?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
): Promise<Harness> {
  const double = await startComposioDouble({
    apiKey: API_KEY,
    toolkits: sampleToolkits,
    authConfigs: sampleAuthConfigs,
    tools: sampleTools,
    ...options.double,
  });
  const ports = memoryPorts(options.now ? { now: options.now } : {});
  ports.configuration.set(composioConfigurationNames.apiKey, API_KEY);
  for (const [name, value] of Object.entries(options.configuration ?? {}))
    ports.configuration.set(name, value);
  const binding = makeBinding({ apiOrigin: double.origin, ...options.binding });
  const adapter = createComposioAdapter(options.adapter ?? {});
  return {
    adapter,
    double,
    ports,
    binding,
    actor: fixtureActor,
    userId: composioUserId({
      tenantId: binding.tenantId,
      ownerKind: "user",
      ownerId: fixtureActor.subjectId,
    }),
    context(overrides = {}) {
      return {
        actor: overrides.actor ?? fixtureActor,
        binding: overrides.binding ?? binding,
        ...(overrides.connection ? { connection: overrides.connection } : {}),
        ...(overrides.handoff ? { handoff: overrides.handoff } : {}),
        generation:
          overrides.generation ?? overrides.connection?.generation ?? 0,
        signal: overrides.signal ?? new AbortController().signal,
        environment: {
          ...ports.environment({ fetch: overrides.fetch ?? fetch }),
          origin: overrides.origin ?? "https://app.example",
        },
      };
    },
    async close() {
      await double.close();
    },
  };
}

/** Every string anywhere in a value, for leak assertions. */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      stringsIn(item, out);
    }
  return out;
}

/** The capability row for one dimension, given the configuration names present. */
export function capabilityFor(
  adapter: ConnectorAdapter,
  dimension: string,
  present: string[],
) {
  return adapter
    .capabilities(new Set(present))
    .find((status) => status.dimension === dimension);
}
