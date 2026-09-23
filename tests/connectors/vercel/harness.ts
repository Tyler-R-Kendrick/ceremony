import { createHash } from "node:crypto";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type {
  AdapterCallContext,
  BoundOperation,
  ConnectionRecord,
  RuntimeBinding,
} from "../../../src/server/connectors/index.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/index.js";
import {
  vercelManagementBoundOperations,
  type VercelSettings,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";

/*
 * Shared scaffolding for the Vercel adapter tests: a real runtime binding
 * (parsed by the production schema, so a test cannot approve something the
 * server would reject), in-memory ports, and a call context whose fetch goes
 * to the independent double over loopback.
 */

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const APP_ORIGIN = "http://127.0.0.1:4173";

export type BindingInput = {
  apiOrigin: string;
  oidcOrigin?: string;
  settings: VercelSettings;
  teamId: string;
  connectors: string[];
  projects: string[];
  environments: string[];
  installations?: string[];
  operations?: BoundOperation[];
  extraDestinations?: RuntimeBinding["destinations"];
  profileId?: string;
  revision?: number;
  policyRevision?: string;
};

export function buildBinding(input: BindingInput): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:vercel-1",
    definitionRef: "definition:vercel-connect",
    revision: input.revision ?? 3,
    adapterId: "vercel-connect",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: `vercel:${input.teamId}`,
    status: "approved",
    approvedAt: "2026-09-01T00:00:00.000Z",
    policyRevision: input.policyRevision ?? "policy:1",
    tenantId: fixtureActor.tenantId,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    destinations: [
      { id: "api", origin: input.apiOrigin, network: "loopback-fixture" },
      ...(input.oidcOrigin
        ? [
            {
              id: "oidc",
              origin: input.oidcOrigin,
              network: "loopback-fixture" as const,
            },
          ]
        : []),
      ...(input.extraDestinations ?? []),
    ],
    operations: input.operations ?? vercelManagementBoundOperations(),
    configuration: [
      "VERCEL_TEAM_ID",
      "VERCEL_MANAGEMENT_TOKEN",
      "VERCEL_CONNECT_WORKLOAD_TOKEN",
    ],
    permittedTargets: [
      { kind: "vercel-team", id: input.teamId },
      ...input.connectors.map((id) => ({ kind: "vercel-connector", id })),
      ...input.projects.map((id) => ({ kind: "vercel-project", id })),
      ...input.environments.map((id) => ({ kind: "vercel-environment", id })),
      ...(input.installations ?? []).map((id) => ({
        kind: "vercel-installation",
        id,
      })),
    ],
    reviewedDigest: digest("vercel-review"),
    // A generous per-request bound: these fixtures share a machine with other
    // suites, and a starved loopback call must not read as a provider outage.
    settings: {
      vercel: { requestTimeoutMs: 120_000, ...input.settings },
    },
  });
}

export type ConnectionInput = {
  binding: RuntimeBinding;
  ownerKind?: ConnectionRecord["ownerKind"];
  lifecycle?: ConnectionRecord["lifecycle"];
  generation?: number;
  credentialRef?: string;
  state?: Record<string, unknown>;
  handoffRef?: string;
  handoffGeneration?: number;
  target?: ConnectionRecord["target"];
};

export function buildConnection(input: ConnectionInput): ConnectionRecord {
  return {
    connectionRef: "connection:vercel-1",
    bindingRef: input.binding.bindingRef,
    definitionRef: input.binding.definitionRef,
    ecosystem: "vercel-connect",
    service: "vercel",
    displayName: "Vercel Connect",
    ownerKind: input.ownerKind ?? "user",
    custody: "external-credential-broker",
    runtime: "hosted-server",
    lifecycle: input.lifecycle ?? "authorization-required",
    generation: input.generation ?? 1,
    revision: 1,
    ...(input.target ? { target: input.target } : {}),
    ...(input.handoffRef
      ? {
          handoff: {
            handoffRef: input.handoffRef,
            kind: "provider-browser" as const,
            state: "issued" as const,
            presentation: "popup" as const,
            expiresAt: "2030-01-01T00:00:00.000Z",
            generation: input.handoffGeneration ?? input.generation ?? 1,
          },
        }
      : {}),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    sessionId: fixtureActor.sessionId,
    authorityInstance: input.binding.authorityInstance,
    bindingRevision: input.binding.revision,
    policyRevision: input.binding.policyRevision,
    configurationRevision: "cfg:1",
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    externalIds: {},
    evidenceRefs: [],
    state: input.state ?? {},
  };
}

export type Harness = ReturnType<typeof harness>;

export function harness(
  options: {
    now?: () => number;
    origin?: string;
    actor?: ActorContext;
  } = {},
) {
  const ports = memoryPorts(options.now ? { now: options.now } : {});
  const controller = new AbortController();
  const environment = ports.environment({
    fetch: globalThis.fetch,
    origin: options.origin ?? APP_ORIGIN,
  });
  const context = (input: {
    binding: RuntimeBinding;
    connection?: ConnectionRecord;
    generation?: number;
    actor?: ActorContext;
  }): AdapterCallContext => ({
    actor: input.actor ?? options.actor ?? fixtureActor,
    binding: input.binding,
    ...(input.connection ? { connection: input.connection } : {}),
    generation: input.generation ?? input.connection?.generation ?? 1,
    signal: controller.signal,
    environment,
  });
  return { ports, environment, context, abort: () => controller.abort() };
}

/** An actor with no administrative capability, for policy tests. */
export const operatorActor: ActorContext = {
  ...fixtureActor,
  capabilities: ["executor"],
};

export { fixtureActor };
