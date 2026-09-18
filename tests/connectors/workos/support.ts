import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import type {
  WorkOsPrincipal,
  WorkOsPrincipalPort,
} from "../../../src/server/connectors/providers/workos/index.js";
import {
  WORKOS_CREDENTIALS_ACTION,
  workOsPipesProfiles,
} from "../../../src/server/connectors/providers/workos/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { AT, HEX } from "../fixtures/builders.js";

/*
 * Shared scaffolding for the WorkOS Pipes adapter tests: two bindings that
 * differ only in the way they are allowed to use the broker, a host principal
 * port that answers from an explicit table, and a call context built over the
 * in-memory ports. Nothing here is imported by the product.
 */

export const API_KEY = "sk_test_workos_fixture_key";
export const CLIENT_ID = "client_01FIXTURE";
export const USER_ID = "user_01EHZNVPK3SFK441A1RGBFSHRT";
export const OTHER_USER_ID = "user_01OTHERPERSON00000000000";
export const ORGANIZATION_ID = "org_01EHZNVPK3SFK441A1RGBFSHRT";
export const PROVIDER = "github";

export type PrincipalTable = Record<string, WorkOsPrincipal | undefined>;

/**
 * A host principal port backed by a table keyed `tenant|ownerKind|ownerId`.
 * Every lookup is recorded, so a test can prove the adapter asked the host
 * rather than reading an identifier from its own arguments.
 */
export function principalPort(table: PrincipalTable): WorkOsPrincipalPort & {
  calls: Array<{ tenantId: string; ownerKind: string; ownerId?: string }>;
} {
  const calls: Array<{
    tenantId: string;
    ownerKind: string;
    ownerId?: string;
  }> = [];
  return {
    calls,
    async resolve(input) {
      calls.push({
        tenantId: input.tenantId,
        ownerKind: input.ownerKind,
        ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
      });
      return (
        table[`${input.tenantId}|${input.ownerKind}|${input.ownerId ?? ""}`] ??
        table[`${input.tenantId}|${input.ownerKind}|`]
      );
    },
  };
}

export const userPrincipal: WorkOsPrincipal = {
  ownerId: fixtureActor.subjectId,
  userId: USER_ID,
};
export const organizationPrincipal: WorkOsPrincipal = {
  ownerId: ORGANIZATION_ID,
  userId: USER_ID,
  organizationId: ORGANIZATION_ID,
  organizationConnection: "permitted",
};
export const deniedOrganizationPrincipal: WorkOsPrincipal = {
  ownerId: ORGANIZATION_ID,
  userId: USER_ID,
  organizationId: ORGANIZATION_ID,
  organizationConnection: "denied",
};

export function defaultPrincipals(): PrincipalTable {
  return {
    [`${fixtureActor.tenantId}|user|`]: userPrincipal,
    [`${fixtureActor.tenantId}|user|${fixtureActor.subjectId}`]: userPrincipal,
    [`${fixtureActor.tenantId}|organization|`]: organizationPrincipal,
    [`${fixtureActor.tenantId}|organization|${ORGANIZATION_ID}`]:
      organizationPrincipal,
  };
}

/** The credential-mode binding: custody is external-credential-broker, one broker action. */
export function credentialBinding(
  origin: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:workos-credentials",
    definitionRef: "definition:workos-pipes",
    revision: 2,
    adapterId: "workos-pipes",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: `workos:${CLIENT_ID}`,
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:workos:1",
    tenantId: fixtureActor.tenantId,
    profileId: workOsPipesProfiles.credentials,
    destinations: [{ id: "api", origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "operation:workos.credential",
        nativeId: "pipes.credentials",
        destinationId: "api",
        transport: {
          kind: "broker-action",
          action: WORKOS_CREDENTIALS_ACTION,
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"],
    permittedTargets: [],
    reviewedDigest: HEX,
    settings: { provider: PROVIDER, mode: "credentials" },
    ...overrides,
  });
}

/** The relay-mode binding: custody is external-execution-broker, operations are HTTP. */
export function relayBinding(
  origin: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:workos-relay",
    definitionRef: "definition:workos-pipes",
    revision: 3,
    adapterId: "workos-pipes",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "external-execution-broker",
    authorityInstance: `workos:${CLIENT_ID}`,
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:workos:1",
    tenantId: fixtureActor.tenantId,
    profileId: workOsPipesProfiles.relay,
    destinations: [{ id: "api", origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "operation:listRepositories",
        nativeId: "GET /user/repos",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/user/repos" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "operation:createIssue",
        nativeId: "POST /repos/{owner}/{repository}/issues",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "POST",
          pathTemplate: "/repos/{owner}/{repository}/issues",
        },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "none",
        targetParameters: ["owner", "repository"],
      },
    ],
    configuration: ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"],
    permittedTargets: [
      { kind: "repository-owner", id: "acme" },
      { kind: "repository", id: "widgets" },
    ],
    reviewedDigest: HEX,
    settings: {
      provider: PROVIDER,
      mode: "relay",
      relay: { routing: "path", maxResponseBytes: 65536 },
    },
    ...overrides,
  });
}

export function connectionRecord(
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    connectionRef: "connection:workos-1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "workos",
    service: "workos-pipes",
    displayName: "WorkOS Pipes (GitHub)",
    ownerKind: "user",
    custody: binding.custody,
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 1,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
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

export type Harness = {
  ports: ReturnType<typeof memoryPorts>;
  context(input?: {
    binding?: RuntimeBinding;
    connection?: ConnectionRecord;
    actor?: ActorContext;
    generation?: number;
    handoff?: AdapterCallContext["handoff"];
  }): AdapterCallContext;
};

/** Builds a call context over the in-memory ports with the configuration a test needs. */
export function harness(input: {
  binding: RuntimeBinding;
  configuration?: Record<string, string | undefined>;
  now?: () => number;
}): Harness {
  const ports = memoryPorts(input.now ? { now: input.now } : {});
  const configuration = input.configuration ?? {
    WORKOS_API_KEY: API_KEY,
    WORKOS_CLIENT_ID: CLIENT_ID,
  };
  for (const [name, value] of Object.entries(configuration))
    ports.configuration.set(name, value);
  return {
    ports,
    context(overrides = {}) {
      const binding = overrides.binding ?? input.binding;
      return {
        actor: overrides.actor ?? fixtureActor,
        binding,
        ...(overrides.connection ? { connection: overrides.connection } : {}),
        ...(overrides.handoff ? { handoff: overrides.handoff } : {}),
        generation: overrides.generation ?? overrides.connection?.generation ?? 1,
        signal: AbortSignal.timeout(60_000),
        environment: ports.environment({ fetch: globalThis.fetch }),
      };
    },
  };
}
