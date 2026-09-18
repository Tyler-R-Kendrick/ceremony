import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type { NormalizedDefinition } from "../../../src/core/connectors/index.js";
import type {
  AdapterCallContext,
  ConnectorAdapter,
} from "../../../src/server/connectors/adapter.js";
import {
  runtimeBindingSchema,
  type ApprovedDestination,
  type BoundOperation,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import { memoryPorts, fixtureActor } from "../doubles/ports.js";
import {
  isReadResult,
  readOpenApi,
  type ReadResult,
} from "../../../src/server/connectors/formats/openapi/index.js";

/** Test-only helpers: fixture loading and a minimal approved binding around compiled operations. */

export const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/openapi/${name}`, import.meta.url)),
      "utf8",
    ),
  );

export async function readFixture(
  name: string,
  options: Parameters<typeof readOpenApi>[1] = {},
): Promise<ReadResult> {
  const result = await readOpenApi(fixture(name), options);
  if (!isReadResult(result))
    throw new Error(
      `fixture ${name} did not read: ${result.issues.map((issue) => issue.code).join(", ")}`,
    );
  return result;
}

export const loopbackDestination = (
  origin: string,
  id = "fixture",
): ApprovedDestination => ({
  id,
  origin,
  network: "loopback-fixture",
});

export function makeBinding(input: {
  destination: ApprovedDestination;
  operations: BoundOperation[];
  settings: Record<string, unknown>;
  definition: NormalizedDefinition;
  profileId?: string;
  permittedTargets?: RuntimeBinding["permittedTargets"];
}): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:openapi-test",
    definitionRef: input.definition.definitionRef,
    revision: 1,
    adapterId: "openapi-http",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: input.destination.origin,
    status: "approved",
    approvedAt: "2026-01-01T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    destinations: [input.destination],
    operations: input.operations,
    configuration: [],
    permittedTargets: input.permittedTargets ?? [],
    reviewedDigest: "a".repeat(64),
    settings: input.settings,
  });
}

export function makeConnection(
  binding: RuntimeBinding,
  credentialRef: string | undefined,
  actor: ActorContext = fixtureActor,
): ConnectionRecord {
  return {
    connectionRef: `connection:${randomUUID()}`,
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "openapi",
    service: "openapi",
    displayName: "Fixture connection",
    ownerKind: "user",
    custody: "host-owned",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 1,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tenantId: actor.tenantId,
    ownerId: actor.subjectId,
    authorityInstance: binding.authorityInstance,
    bindingRevision: binding.revision,
    policyRevision: binding.policyRevision,
    configurationRevision: "cfg:1",
    ...(credentialRef ? { credentialRef } : {}),
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
}

export interface Harness {
  ports: ReturnType<typeof memoryPorts>;
  ctx: AdapterCallContext;
  binding: RuntimeBinding;
  connection: ConnectionRecord;
}

/**
 * Builds a call context around a real binding and the in-memory ports. The
 * adapter under test reaches the fixture server through `fetch` exactly as it
 * would reach a provider.
 */
export async function harness(input: {
  binding: RuntimeBinding;
  credential?: Record<string, string>;
  actor?: ActorContext;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Harness> {
  const actor = input.actor ?? fixtureActor;
  const ports = memoryPorts();
  const connectionBase = makeConnection(input.binding, undefined, actor);
  let credentialRef: string | undefined;
  if (input.credential) {
    credentialRef = await ports.credentials.store(
      {
        tenantId: actor.tenantId,
        ownerKind: "user",
        ownerId: actor.subjectId,
        connectionRef: connectionBase.connectionRef,
        bindingRef: input.binding.bindingRef,
        custody: "host-owned",
      },
      input.credential,
    );
  }
  const connection: ConnectionRecord = credentialRef
    ? { ...connectionBase, credentialRef }
    : connectionBase;
  const ctx: AdapterCallContext = {
    actor,
    binding: input.binding,
    connection,
    generation: connection.generation,
    signal: input.signal ?? new AbortController().signal,
    environment: ports.environment({ fetch: input.fetch ?? fetch }),
  };
  return { ports, ctx, binding: input.binding, connection };
}

/** Every string a result, issue list or projection could carry, flattened for canary checks. */
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) allStrings(item, out);
  return out;
}

export function invokeAdapter(
  adapter: ConnectorAdapter,
  ctx: AdapterCallContext,
  request: { operationRef: string; input: unknown; commandId?: string; idempotencyKey?: string },
) {
  return adapter.invoke!(ctx, {
    operationRef: request.operationRef,
    input: request.input,
    commandId: request.commandId ?? `command:${randomUUID()}`,
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
  });
}
