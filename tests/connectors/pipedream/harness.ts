import { randomUUID } from "node:crypto";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import type {
  AdapterCallContext,
  ConnectorAdapter,
  HandoffProposal,
} from "../../../src/server/connectors/adapter.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  createPipedreamConnectAdapter,
  type PipedreamAdapterOptions,
} from "../../../src/server/connectors/providers/pipedream/index.js";
import { pipedreamExternalUserId } from "../../../src/server/connectors/providers/pipedream/identity.js";
import { memoryPorts, fixtureActor } from "../doubles/ports.js";
import {
  startPipedreamDouble,
  type PipedreamDouble,
  type PipedreamDoubleOptions,
} from "../doubles/pipedream.js";

/*
 * Wiring shared by the Pipedream adapter tests: a loopback double, the shared
 * in-memory ports, a runtime binding that the foundation's own schema accepts,
 * and a connection record. Everything a real deployment would decide (the
 * approved destinations, the operations, the app, the owner) is decided here,
 * outside the adapter, exactly as the command layer would decide it.
 */

export const DEPLOYMENT_ORIGIN = "https://app.example";
export const EVENTS_PREFIX = "/api/v1/connectors/pipedream/events";
export const RETURN_PATH = "/api/v1/connectors/pipedream/return";

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export type HarnessOptions = {
  double?: PipedreamDoubleOptions;
  adapter?: PipedreamAdapterOptions;
  environment?: "development" | "production";
  app?: string;
  /** Leave a configuration name out, to exercise unconfigured reporting. */
  omitConfiguration?: string[];
};

export async function startHarness(options: HarnessOptions = {}) {
  const double = await startPipedreamDouble(options.double ?? {});
  const ports = memoryPorts();
  const environment = options.environment ?? "production";
  const app = options.app ?? "slack";
  const omit = new Set(options.omitConfiguration ?? []);
  const configuration: Record<string, string> = {
    PIPEDREAM_PROJECT_ID: double.projectId,
    PIPEDREAM_ENVIRONMENT: environment,
    PIPEDREAM_CLIENT_ID: double.clientId,
    PIPEDREAM_CLIENT_SECRET: double.clientSecret,
  };
  for (const [name, value] of Object.entries(configuration))
    if (!omit.has(name)) ports.configuration.set(name, value);

  const adapter = createPipedreamConnectAdapter({
    returnPath: RETURN_PATH,
    connectionWebhookPath: "/api/v1/connectors/pipedream/connections",
    ...(options.adapter ?? {}),
  });

  return {
    double,
    ports,
    adapter,
    environment,
    app,
    configuration,
    externalUserId: (actor: ActorContext = fixtureActor, ownerId?: string) =>
      pipedreamExternalUserId(
        {
          tenantId: actor.tenantId,
          ownerKind: "user",
          ownerId: ownerId ?? actor.subjectId,
        },
        options.adapter?.externalUserKey,
      ),
    async close() {
      await double.close();
    },
  };
}

export type BindingOptions = {
  apiOrigin: string;
  app?: string;
  tenantId?: string;
  bindingRef?: string;
  revision?: number;
  status?: "approved" | "suspended" | "retired";
  operations?: RuntimeBinding["operations"];
  destinations?: RuntimeBinding["destinations"];
  permittedTargets?: RuntimeBinding["permittedTargets"];
  settings?: Record<string, unknown>;
};

/** The operations the tests bind; a caller never supplies any of this. */
export function defaultOperations(): RuntimeBinding["operations"] {
  return [
    {
      operationRef: "proxy.post-message",
      nativeId: "chat.postMessage",
      destinationId: "api",
      transport: {
        kind: "delegated",
        route: "proxy:POST:https://slack.com/api/chat.postMessage",
      },
      effect: "write",
      outputClassification: "personal",
      cost: "unknown",
      consent: "confirm",
      replay: "none",
      targetParameters: [],
    },
    {
      operationRef: "proxy.read-channel",
      nativeId: "conversations.info",
      destinationId: "api",
      transport: {
        kind: "delegated",
        route: "proxy:GET:https://slack.com/api/conversations.info",
      },
      effect: "read",
      outputClassification: "personal",
      cost: "free",
      consent: "none",
      replay: "read-only",
      targetParameters: [],
    },
    {
      operationRef: "proxy.team",
      nativeId: "team.info",
      destinationId: "api",
      transport: {
        kind: "delegated",
        route: "proxy:GET:https://slack.com/api/teams/{teamId}/info",
      },
      effect: "read",
      outputClassification: "personal",
      cost: "free",
      consent: "none",
      replay: "read-only",
      targetParameters: ["teamId"],
    },
    {
      operationRef: "action.send-message",
      nativeId: "slack-send-message-to-channel",
      destinationId: "api",
      transport: {
        kind: "broker-action",
        action: "slack-send-message-to-channel",
      },
      effect: "write",
      outputClassification: "personal",
      cost: "metered",
      consent: "confirm",
      replay: "none",
      targetParameters: [],
    },
    {
      operationRef: "trigger.deploy",
      nativeId: "slack-new-message-in-channel",
      destinationId: "api",
      transport: {
        kind: "delegated",
        route: "trigger:deploy:slack-new-message-in-channel",
      },
      effect: "write",
      outputClassification: "personal",
      cost: "metered",
      consent: "confirm",
      replay: "reconciliation",
      targetParameters: [],
    },
    {
      operationRef: "trigger.list",
      nativeId: "slack-new-message-in-channel",
      destinationId: "api",
      transport: {
        kind: "delegated",
        route: "trigger:list:slack-new-message-in-channel",
      },
      effect: "read",
      outputClassification: "personal",
      cost: "free",
      consent: "none",
      replay: "read-only",
      targetParameters: [],
    },
    {
      operationRef: "trigger.delete",
      nativeId: "slack-new-message-in-channel",
      destinationId: "api",
      transport: {
        kind: "delegated",
        route: "trigger:delete:slack-new-message-in-channel",
      },
      effect: "write",
      outputClassification: "public",
      cost: "free",
      consent: "confirm",
      replay: "reconciliation",
      targetParameters: [],
    },
  ];
}

export function defaultSettings(app: string): Record<string, unknown> {
  return {
    app,
    operations: {
      "proxy.post-message": {
        body: "json",
        bodyFields: ["channel", "text"],
        headers: { "x-fixture-tag": "ceremony" },
      },
      "proxy.read-channel": { query: ["channel"] },
      "proxy.team": { path: ["teamId"], targets: { teamId: "slack-team" } },
      "action.send-message": {
        appProp: "slack",
        props: ["channel", "text"],
        version: "0.0.23",
      },
      "trigger.deploy": {
        appProp: "slack",
        props: ["conversations"],
        webhookDestinationId: "events",
        webhookPath: EVENTS_PREFIX,
        emitOnDeploy: false,
      },
      "trigger.list": {},
      "trigger.delete": {},
    },
  };
}

export function makeBinding(options: BindingOptions): RuntimeBinding {
  const app = options.app ?? "slack";
  return runtimeBindingSchema.parse({
    bindingRef: options.bindingRef ?? "binding:pipedream:slack",
    definitionRef: "definition:pipedream:slack",
    revision: options.revision ?? 3,
    adapterId: "pipedream-connect",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: "proj_fixture01:production",
    status: options.status ?? "approved",
    approvedAt: "2026-09-01T00:00:00.000Z",
    policyRevision: "policy-7",
    tenantId: options.tenantId ?? "tenant-a",
    profileId: "pipedream-connect",
    destinations: options.destinations ?? [
      { id: "api", origin: options.apiOrigin, network: "loopback-fixture" },
      {
        id: "events",
        origin: DEPLOYMENT_ORIGIN,
        pathPrefix: EVENTS_PREFIX,
        network: "public",
      },
    ],
    operations: options.operations ?? defaultOperations(),
    configuration: [
      "PIPEDREAM_PROJECT_ID",
      "PIPEDREAM_ENVIRONMENT",
      "PIPEDREAM_CLIENT_ID",
      "PIPEDREAM_CLIENT_SECRET",
    ],
    permittedTargets: options.permittedTargets ?? [
      { kind: "slack-team", id: "T01PERMITTED" },
    ],
    reviewedDigest: "a".repeat(64),
    settings: options.settings ?? defaultSettings(app),
  });
}

export type ConnectionOptions = {
  binding: RuntimeBinding;
  actor?: ActorContext;
  connectionRef?: string;
  generation?: number;
  lifecycle?: ConnectionRecord["lifecycle"];
  credentialRef?: string;
  externalIds?: Record<string, string>;
  state?: Record<string, unknown>;
  handoff?: ConnectionRecord["handoff"];
  ownerKind?: ConnectionRecord["ownerKind"];
  ownerId?: string;
};

export function makeConnection(options: ConnectionOptions): ConnectionRecord {
  const actor = options.actor ?? fixtureActor;
  const at = "2026-09-10T00:00:00.000Z";
  return {
    connectionRef: options.connectionRef ?? "connection:pipedream:1",
    bindingRef: options.binding.bindingRef,
    definitionRef: options.binding.definitionRef,
    ecosystem: "pipedream",
    service: "pipedream",
    displayName: "Pipedream Connect",
    ownerKind: options.ownerKind ?? "user",
    custody: "external-credential-broker",
    runtime: "hosted-server",
    lifecycle: options.lifecycle ?? "active",
    generation: options.generation ?? 1,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...(options.handoff ? { handoff: options.handoff } : {}),
    tenantId: actor.tenantId,
    ownerId: options.ownerId ?? actor.subjectId,
    authorityInstance: "proj_fixture01:production",
    bindingRevision: options.binding.revision,
    policyRevision: options.binding.policyRevision,
    configurationRevision: "cfg:1",
    ...(options.credentialRef ? { credentialRef: options.credentialRef } : {}),
    externalIds: options.externalIds ?? {},
    evidenceRefs: [],
    state: options.state ?? {},
  };
}

export type ContextOptions = {
  harness: Harness;
  binding: RuntimeBinding;
  connection?: ConnectionRecord;
  actor?: ActorContext;
  generation?: number;
  signal?: AbortSignal;
  origin?: string;
};

export function makeContext(options: ContextOptions): AdapterCallContext {
  const actor = options.actor ?? fixtureActor;
  return {
    actor,
    binding: options.binding,
    ...(options.connection ? { connection: options.connection } : {}),
    generation: options.generation ?? options.connection?.generation ?? 1,
    signal: options.signal ?? new AbortController().signal,
    environment: options.harness.ports.environment({
      fetch: globalThis.fetch,
      origin: options.origin ?? DEPLOYMENT_ORIGIN,
    }),
  };
}

/**
 * Records a connected account on a connection the way the command layer would
 * after a completion: a broker reference in custody, and the external ids that
 * pin the connection to this project, environment, external user and app.
 */
export async function bindAccount(
  harness: Harness,
  connection: ConnectionRecord,
  input: {
    accountId: string;
    externalUserId: string;
    projectId: string;
    environment: string;
    app: string;
  },
): Promise<ConnectionRecord> {
  const credentialRef = await harness.ports.credentials.store(
    {
      tenantId: connection.tenantId,
      ownerKind: connection.ownerKind,
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: connection.bindingRef,
      custody: "external-credential-broker",
    },
    {
      accountId: input.accountId,
      externalUserId: input.externalUserId,
      projectId: input.projectId,
      environment: input.environment,
      app: input.app,
    },
  );
  return {
    ...connection,
    credentialRef,
    externalIds: {
      ...connection.externalIds,
      accountId: input.accountId,
      externalUserId: input.externalUserId,
      projectId: input.projectId,
      environment: input.environment,
      app: input.app,
    },
  };
}

/** Issues a handoff the way the command layer would, from the adapter's proposal. */
export async function issueHandoff(
  harness: Harness,
  proposal: HandoffProposal,
  connection: ConnectionRecord,
  actor: ActorContext = fixtureActor,
) {
  return harness.ports.handoffs.issue({
    ...proposal,
    actor,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    generation: connection.generation,
  });
}

/** A private handoff record, for assertions that need the token the browser got. */
export async function handoffPrivate(
  harness: Harness,
  handoffRef: string,
  actor: ActorContext = fixtureActor,
): Promise<Record<string, string>> {
  const record = await harness.ports.handoffs.present(actor, handoffRef);
  if (!record) throw new Error("handoff not present");
  return record.private;
}

export const otherTenantActor: ActorContext = {
  tenantId: "tenant-b",
  subjectId: "subject-1",
  sessionId: "session-9",
  actorKind: "human",
  capabilities: ["executor"],
};

export const secondSubjectActor: ActorContext = {
  tenantId: "tenant-a",
  subjectId: "subject-2",
  sessionId: "session-2",
  actorKind: "human",
  capabilities: ["executor"],
};

export { fixtureActor, memoryPorts, randomUUID };
export type { ConnectorAdapter, PipedreamDouble };
