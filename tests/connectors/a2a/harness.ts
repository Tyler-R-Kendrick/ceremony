import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import {
  runtimeBindingSchema,
  type BoundOperation,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  A2A_ADAPTER_VERSION,
  A2A_CONFIGURATION_NAMES,
  authorityInstanceFor,
  createA2aAdapter,
  type A2aAdapter,
} from "../../../src/server/connectors/providers/a2a/index.js";
import {
  fixtureActor,
  memoryPorts,
  type MemoryPorts,
} from "../doubles/ports.js";
import {
  startA2aAgentDouble,
  type A2aDouble,
  type A2aDoubleOptions,
} from "../doubles/a2a-agent.js";

/*
 * Wiring shared by the A2A suites. The binding is built the way a host would
 * build it — destination, path, profile, credential name and an explicit
 * skill list — and every assertion is made against the independent agent
 * double's recorded requests, so the adapter's own code produces every
 * outgoing message.
 */

export const TENANT = "tenant-a";
export const CREDENTIAL = "a2a-fixture-credential";
export const SKILL = "summarize";

export const otherActor: ActorContext = {
  tenantId: TENANT,
  subjectId: "subject-2",
  sessionId: "session-2",
  actorKind: "human",
  capabilities: ["executor"],
};

export const summarizeOperation: BoundOperation = {
  operationRef: "a2a.summarize",
  nativeId: SKILL,
  destinationId: "agent",
  transport: { kind: "delegated", route: `a2a-skill:${SKILL}` },
  effect: "write",
  outputClassification: "personal",
  cost: "unknown",
  consent: "confirm",
  replay: "none",
  targetParameters: [],
};

export type BindingOverrides = {
  agentOrigin: string;
  rpcPath?: string;
  profile?: "a2a-1.0" | "a2a-0.3";
  protocolVersion?: string;
  agentName?: string;
  cardVersion?: string;
  operations?: BoundOperation[];
  approvedSkills?: Array<Record<string, unknown>>;
  security?: Record<string, unknown>;
  artifactRetrieval?: Record<string, unknown>;
  outputPolicy?: "text" | "data" | "none";
  artifactPolicy?: "descriptor-only" | "inline-text";
  tenantId?: string;
  bindingRef?: string;
  network?: "public" | "approved-private" | "loopback-fixture";
  artifactOrigin?: string;
};

export function makeBinding(overrides: BindingOverrides): RuntimeBinding {
  const profile = overrides.profile ?? "a2a-1.0";
  const agentName = overrides.agentName ?? "Fixture Agent";
  return runtimeBindingSchema.parse({
    bindingRef: overrides.bindingRef ?? "binding:a2a-1",
    definitionRef: "def:a2a-1",
    revision: 2,
    adapterId: "a2a",
    adapterVersion: A2A_ADAPTER_VERSION,
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: authorityInstanceFor(
      profile,
      overrides.agentOrigin,
      agentName,
    ),
    status: "approved",
    approvedAt: "2026-03-01T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: overrides.tenantId ?? TENANT,
    destinations: [
      {
        id: "agent",
        origin: overrides.agentOrigin,
        network: overrides.network ?? "loopback-fixture",
      },
      ...(overrides.artifactOrigin
        ? [
            {
              id: "artifacts",
              origin: overrides.artifactOrigin,
              network: "loopback-fixture",
            },
          ]
        : []),
    ],
    operations: overrides.operations ?? [summarizeOperation],
    configuration: [A2A_CONFIGURATION_NAMES.credential],
    permittedTargets: [{ kind: "a2a-agent", id: agentName }],
    reviewedDigest: "b".repeat(64),
    settings: {
      agent: {
        name: agentName,
        cardVersion: overrides.cardVersion ?? "2.3.1",
        profile,
        protocolVersion:
          overrides.protocolVersion ?? (profile === "a2a-1.0" ? "1.0" : "0.3"),
        destinationId: "agent",
        rpcPath: overrides.rpcPath ?? "/a2a/v1",
      },
      security: overrides.security ?? {
        kind: "http-bearer",
        configurationName: A2A_CONFIGURATION_NAMES.credential,
      },
      approvedSkills: overrides.approvedSkills ?? [
        {
          skillId: SKILL,
          operationRef: summarizeOperation.operationRef,
          maxInputChars: 500,
          acceptedOutputModes: ["text/plain"],
          outputPolicy: overrides.outputPolicy ?? "text",
          artifactPolicy: overrides.artifactPolicy ?? "descriptor-only",
        },
      ],
      ...(overrides.artifactRetrieval
        ? { artifactRetrieval: overrides.artifactRetrieval }
        : {}),
    },
  });
}

export function makeConnection(
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    connectionRef: "conn:a2a-1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "a2a",
    service: "a2a",
    displayName: "Fixture Agent",
    ownerKind: "user",
    custody: "host-owned",
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

/** A connection holding the stored agent credential, as verification leaves it. */
export async function activeConnection(
  ports: MemoryPorts,
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): Promise<ConnectionRecord> {
  const base = makeConnection(binding, overrides);
  const credentialRef = await ports.credentials.store(
    {
      tenantId: base.tenantId,
      ownerKind: base.ownerKind,
      ownerId: base.ownerId,
      connectionRef: base.connectionRef,
      bindingRef: base.bindingRef,
      custody: "host-owned",
    },
    { credential: CREDENTIAL },
  );
  return { ...base, lifecycle: "active", credentialRef, ...overrides };
}

export type Harness = {
  adapter: A2aAdapter;
  double: A2aDouble;
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
    double?: Partial<A2aDoubleOptions>;
    binding?: Omit<BindingOverrides, "agentOrigin"> & { agentOrigin?: string };
    configuration?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
): Promise<Harness> {
  const double = await startA2aAgentDouble({
    profile: "1.0",
    authorization: `Bearer ${CREDENTIAL}`,
    ...options.double,
  });
  const ports = memoryPorts(options.now ? { now: options.now } : {});
  ports.configuration.set(A2A_CONFIGURATION_NAMES.credential, CREDENTIAL);
  for (const [name, value] of Object.entries(options.configuration ?? {}))
    ports.configuration.set(name, value);
  const binding = makeBinding({
    agentOrigin: double.origin,
    rpcPath: double.rpcPath,
    profile: double.profile === "1.0" ? "a2a-1.0" : "a2a-0.3",
    agentName: double.agentName,
    cardVersion: double.agentVersion,
    ...options.binding,
  });
  const adapter = createA2aAdapter();
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

/** Every string anywhere in a value, for leak assertions. */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}
