import { z } from "zod";
import { type CeremonySnapshot, type Field, snapshotSchema } from "./schema.js";
import {
  type FieldClassification,
  publicValueSchema,
} from "./operation-contracts.js";
import {
  demonstrationEventSchema,
  type DemonstrationEvent,
} from "./teaching-contracts.js";
import { recipeDefinitionSchema } from "./recipe-contracts.js";

export function classifyField(field: Field): FieldClassification {
  if (field.type === "password" || ["password", "token"].includes(field.name))
    return "secret";
  return field.classification ?? "unclassified";
}

/** Trusted human rendering only. Never pass this projection to agent tooling or history. */
export function humanProjection(snapshot: CeremonySnapshot): CeremonySnapshot {
  return snapshotSchema.parse({
    id: snapshot.id,
    revision: snapshot.revision,
    connectorId: snapshot.connectorId,
    connectorName: snapshot.connectorName,
    description: snapshot.description,
    method: snapshot.method,
    step: snapshot.step,
    fields: snapshot.fields,
    actions: snapshot.actions,
    expiresAt: snapshot.expiresAt,
    ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
    ...(snapshot.authorizationUrl === undefined
      ? {}
      : { authorizationUrl: snapshot.authorizationUrl }),
    ...(snapshot.verificationUri === undefined
      ? {}
      : { verificationUri: snapshot.verificationUri }),
    ...(snapshot.userCode === undefined ? {} : { userCode: snapshot.userCode }),
    ...(snapshot.outcome === undefined
      ? {}
      : {
          outcome: {
            connectionRef: snapshot.outcome.connectionRef,
            ownership: snapshot.outcome.ownership,
            scopes: snapshot.outcome.scopes,
          },
        }),
    ...(snapshot.prerequisites === undefined
      ? {}
      : {
          prerequisites: snapshot.prerequisites.map((item) => ({
            id: item.id,
            label: item.label,
            status: item.status,
          })),
        }),
  });
}

/** Non-authorizing correlation IDs are retained; values, messages and URLs are not. */
export function agentProjection(snapshot: CeremonySnapshot) {
  return {
    id: snapshot.id,
    revision: snapshot.revision,
    connectorId: snapshot.connectorId,
    methodId: snapshot.method.id,
    step: snapshot.step,
    actions: [...snapshot.actions],
    fields: snapshot.fields.map((field) => ({
      name: field.name,
      required: field.required,
      collection: classifyField(field) === "public" ? "public" : "private",
    })),
    prerequisites: (snapshot.prerequisites ?? []).map((item) => ({
      id: item.id,
      status: item.status,
    })),
    ownership: snapshot.outcome?.ownership ?? null,
  };
}

export type PublicBindingPolicy = Readonly<
  Record<string, { classification: FieldClassification; schema: z.ZodType }>
>;
/** Policy is supplied by the trusted operation registry, never the caller/event. */
export function demonstrationProjection(
  event: DemonstrationEvent,
  policy: PublicBindingPolicy,
): DemonstrationEvent {
  const publicBindings: DemonstrationEvent["publicBindings"] = {};
  for (const [name, rule] of Object.entries(policy)) {
    if (
      rule.classification !== "public" ||
      !Object.hasOwn(event.publicBindings, name)
    )
      continue;
    const value = rule.schema.safeParse(event.publicBindings[name]);
    if (value.success) {
      const primitive = publicValueSchema.safeParse(value.data);
      if (primitive.success) publicBindings[name] = primitive.data;
    }
  }
  return demonstrationEventSchema.parse({
    schemaVersion: 1,
    eventId: event.eventId,
    demonstrationId: event.demonstrationId,
    sequence: event.sequence,
    nodeId: event.nodeId,
    operationId: event.operationId,
    operationVersion: event.operationVersion,
    actorKind: event.actorKind,
    kind: event.kind,
    beforeState: event.beforeState,
    afterState: event.afterState,
    publicBindings,
    verification: event.verification,
    ...(event.diagnosticCode === undefined
      ? {}
      : { diagnosticCode: event.diagnosticCode }),
  });
}

export function auditProjection(event: DemonstrationEvent) {
  return {
    sequence: event.sequence,
    operationId: event.operationId,
    operationVersion: event.operationVersion,
    actorKind: event.actorKind,
    kind: event.kind,
    verification: event.verification,
    ...(event.diagnosticCode === undefined
      ? {}
      : { diagnosticCode: event.diagnosticCode }),
  };
}

/** Reject provenance/authority additions, rather than silently exporting them. */
export function exportProjection(definition: unknown) {
  return recipeDefinitionSchema.parse(definition);
}
