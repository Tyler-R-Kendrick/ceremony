import { readFileSync } from "node:fs";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import {
  runtimeBindingSchema,
  type BoundOperation,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import type {
  AdapterCallContext,
  AdapterEnvironment,
} from "../../../src/server/connectors/adapter.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  readCustomConnector,
  type CustomConnectorReadResult,
} from "../../../src/server/connectors/formats/microsoft/read.js";
import type { DynamicFieldContract } from "../../../src/server/connectors/formats/microsoft/dynamic.js";
import { memoryPorts, type MemoryPorts } from "../doubles/ports.js";

/*
 * Shared scaffolding for the Microsoft custom-connector tests. Fixtures are
 * read from disk exactly as the Power Platform CLI writes them, bindings are
 * parsed by the real binding schema, and connections carry the same ownership
 * fields the state layer stores, so a test cannot pass here on a shape the
 * product would reject.
 */

export const AT = "2026-09-18T00:00:00.000Z";

export function fixtureJson(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/microsoft/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

export function fixtureText(name: string): string {
  return readFileSync(
    new URL(`../fixtures/microsoft/${name}`, import.meta.url),
    "utf8",
  );
}

export const swaggerFixture = () => fixtureJson("apiDefinition.swagger.json");
export const apiPropertiesFixture = () => fixtureJson("apiProperties.json");
export const settingsFixture = () => fixtureJson("settings.json");

/** The whole connector as downloaded: swagger plus both companion files. */
export function readFixtureConnector(
  overrides: {
    swagger?: unknown;
    apiProperties?: unknown;
    settings?: unknown;
    scriptPresent?: boolean;
  } = {},
): Promise<CustomConnectorReadResult> {
  return readCustomConnector({
    swagger: overrides.swagger ?? swaggerFixture(),
    ...(overrides.apiProperties === null
      ? {}
      : { apiProperties: overrides.apiProperties ?? apiPropertiesFixture() }),
    settings: overrides.settings ?? settingsFixture(),
    ...(overrides.scriptPresent === undefined
      ? {}
      : { scriptPresent: overrides.scriptPresent }),
    definitionRef: "definition:contoso",
    sourceRef: "source:contoso",
  });
}

const HEX = "0123456789abcdef".repeat(4);

export function buildMicrosoftBinding(options: {
  origin: string;
  operations: BoundOperation[];
  dynamicFields?: DynamicFieldContract[];
  verifier?: { operationRef: string; operationId: string };
  connectorId?: string;
  authentication?: {
    kind: "api-key" | "http-basic" | "oauth2" | "none";
    placement?: "header" | "query";
    parameterName?: string;
  };
  permittedTargets?: Array<{ kind: string; id: string }>;
  tenantId?: string;
  bindingRef?: string;
  cacheTtlMs?: number;
  pathPrefix?: string;
}): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: options.bindingRef ?? "binding:contoso",
    definitionRef: "definition:contoso",
    revision: 1,
    adapterId: "microsoft-custom-connector",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: options.origin,
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:1",
    tenantId: options.tenantId ?? "tenant-a",
    destinations: [
      {
        id: "api",
        origin: options.origin,
        ...(options.pathPrefix ? { pathPrefix: options.pathPrefix } : {}),
        network: "loopback-fixture",
      },
    ],
    operations: options.operations,
    configuration: [],
    permittedTargets: options.permittedTargets ?? [],
    reviewedDigest: HEX,
    settings: {
      ...(options.connectorId ? { connectorId: options.connectorId } : {}),
      ...(options.authentication
        ? { authentication: options.authentication }
        : {}),
      dynamicFields: options.dynamicFields ?? [],
      ...(options.verifier ? { verifier: options.verifier } : {}),
      ...(options.cacheTtlMs === undefined
        ? {}
        : { cacheTtlMs: options.cacheTtlMs }),
    },
  });
}

export function buildConnection(options: {
  binding: RuntimeBinding;
  actor: ActorContext;
  credentialRef?: string;
  connectionRef?: string;
  generation?: number;
  service?: string;
}): ConnectionRecord {
  return {
    connectionRef: options.connectionRef ?? "connection:contoso-1",
    bindingRef: options.binding.bindingRef,
    definitionRef: options.binding.definitionRef,
    ecosystem: "microsoft-custom-connector",
    service: options.service ?? "contoso-projects",
    displayName: "Contoso Projects",
    ownerKind: "user",
    custody: "host-owned",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: options.generation ?? 0,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    tenantId: options.actor.tenantId,
    ownerId: options.actor.subjectId,
    authorityInstance: options.binding.authorityInstance,
    bindingRevision: options.binding.revision,
    policyRevision: options.binding.policyRevision,
    configurationRevision: "cfg:1",
    ...(options.credentialRef ? { credentialRef: options.credentialRef } : {}),
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
}

export const actorFor = (
  tenantId: string,
  subjectId: string,
  sessionId = "session-1",
): ActorContext => ({
  tenantId,
  subjectId,
  sessionId,
  actorKind: "human",
  capabilities: ["executor"],
});

/** Stores an API key for one principal and returns the connection that holds it. */
export async function connectedPrincipal(options: {
  ports: MemoryPorts;
  binding: RuntimeBinding;
  actor: ActorContext;
  apiKey: string;
  connectionRef?: string;
  generation?: number;
}): Promise<ConnectionRecord> {
  const connectionRef =
    options.connectionRef ?? `connection:${options.actor.subjectId}`;
  const credentialRef = await options.ports.credentials.store(
    {
      tenantId: options.actor.tenantId,
      ownerKind: "user",
      ownerId: options.actor.subjectId,
      connectionRef,
      bindingRef: options.binding.bindingRef,
      custody: "host-owned",
    },
    { value: options.apiKey },
  );
  return buildConnection({
    binding: options.binding,
    actor: options.actor,
    credentialRef,
    connectionRef,
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
  });
}

export function adapterContext(options: {
  actor: ActorContext;
  binding: RuntimeBinding;
  connection?: ConnectionRecord;
  environment: AdapterEnvironment;
  generation?: number;
  signal?: AbortSignal;
}): AdapterCallContext {
  return {
    actor: options.actor,
    binding: options.binding,
    ...(options.connection ? { connection: options.connection } : {}),
    generation: options.generation ?? options.connection?.generation ?? 0,
    signal: options.signal ?? AbortSignal.timeout(20_000),
    environment: options.environment,
  };
}

export function portsWithFetch(origin: string): {
  ports: MemoryPorts;
  environment: AdapterEnvironment;
} {
  const ports = memoryPorts();
  return { ports, environment: ports.environment({ fetch, origin }) };
}

export const contractById = (
  contracts: readonly DynamicFieldContract[],
  id: string,
): DynamicFieldContract => {
  const found = contracts.find((contract) => contract.id === id);
  if (!found)
    throw new Error(
      `No dynamic contract ${id}; have ${contracts.map((c) => c.id).join(", ")}`,
    );
  return found;
};

export const operationByRef = (
  operations: readonly BoundOperation[],
  operationRef: string,
): BoundOperation => {
  const found = operations.find((item) => item.operationRef === operationRef);
  if (!found)
    throw new Error(
      `No bound operation ${operationRef}; have ${operations.map((o) => o.operationRef).join(", ")}`,
    );
  return found;
};

/** Values that must never appear in a definition, an export or a diagnostic. */
export const canaries = Object.freeze({
  parameterDefault: "CANARY_SECRET_9f3",
  responseExample: "ghp_CANARYTOKEN4b2",
  scriptBody: "CANARY_SCRIPT_BODY_7d2",
  upstreamBody: "CANARY_UPSTREAM_DENIAL_5a8",
});
