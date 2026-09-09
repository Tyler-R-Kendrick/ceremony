import { z } from "zod";
import {
  identifierSchema,
  publicValueSchema,
  semanticVersionSchema,
} from "./operation-contracts.js";
import { bindingSchema } from "./recipe-contracts.js";

export const commandEnvelopeSchema = z
  .object({
    commandId: identifierSchema,
    runId: identifierSchema,
    nodeId: identifierSchema,
    expectedRevision: z.number().int().nonnegative(),
    operationId: identifierSchema,
    operationVersion: semanticVersionSchema,
    bindings: z
      .record(identifierSchema, bindingSchema)
      .refine((v) => Object.keys(v).length <= 32),
  })
  .strict();
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export const diagnosticCodeSchema = z.enum([
  "denied",
  "conflict",
  "unavailable",
  "invalid-input",
  "awaiting-human",
  "uncertain",
  "verification-rejected",
  "cancelled",
  "expired",
]);
export const demonstrationEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: identifierSchema,
    demonstrationId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    nodeId: identifierSchema,
    operationId: identifierSchema,
    operationVersion: semanticVersionSchema,
    actorKind: z.enum(["human", "agent", "system"]),
    kind: z.enum([
      "choice",
      "transition",
      "handoff",
      "verification",
      "failure",
    ]),
    beforeState: identifierSchema,
    afterState: identifierSchema,
    publicBindings: z
      .record(identifierSchema, publicValueSchema)
      .refine((v) => Object.keys(v).length <= 32),
    verification: z.enum(["none", "pending", "accepted", "rejected"]),
    diagnosticCode: diagnosticCodeSchema.optional(),
  })
  .strict();
export type DemonstrationEvent = z.infer<typeof demonstrationEventSchema>;
export const demonstrationConsentSchema = z.enum([
  "recording",
  "paused",
  "stopped",
  "discarded",
]);
export const evidenceReferenceSchema = z
  .object({
    id: identifierSchema,
    verifier: identifierSchema,
    status: z.enum(["pending", "accepted", "rejected"]),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export const handoffSummarySchema = z
  .object({
    state: z.enum(["required", "waiting", "verifying", "expired", "cancelled"]),
    purpose: z.enum(["provider-consent", "private-input", "owner-choice"]),
  })
  .strict();
export type HandoffSummary = z.infer<typeof handoffSummarySchema>;
