import { z } from "zod";
import {
  capabilityStatusSchema,
  connectionSummarySchema,
  connectorReferenceSchema,
  credentialCustodySchema,
  handoffKindSchema,
  handoffStateSchema,
  nativeIdentifierSchema,
  nativeVersionSchema,
  normalizedDefinitionSchema,
  ownerKindSchema,
  runtimeClassSchema,
  safeTextSchema,
  sha256HexSchema,
  sourceRecordSchema,
  verificationClaimSchema,
} from "../../../core/connectors/index.js";
import { runtimeBindingSchema } from "../binding.js";

/*
 * Every value the state layer writes is described here and re-validated on
 * every read. `schemaVersion: 1` is the forward-compatibility hook: a later
 * layout is a new literal with a reader that upgrades the old one, never an
 * in-place rewrite of encrypted rows. The record table itself is generic, so
 * adding these kinds needs no SQL migration.
 */

const schemaVersion = z.literal(1);
const bounded = z.string().min(1).max(200);
const noControl = /^[^\p{Cc}]*$/u;
const time = z.number().int().nonnegative();
const isoTime = z.iso.datetime({ offset: true });
/** A sanitized code: a purpose, a reason or an outcome, never provider prose. */
export const stateCodeSchema = safeTextSchema.min(1).max(120);
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const namedKey = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}]+$/u)
  .refine((key) => !reserved.has(key), "Reserved key");

export const stringRecordSchema = (maxKeys: number, maxBytes: number) =>
  z
    .record(namedKey, z.string().max(maxBytes))
    .refine(
      (value) =>
        Object.keys(value).length <= maxKeys &&
        Object.values(value).reduce(
          (size, item) => size + Buffer.byteLength(item),
          0,
        ) <= maxBytes,
      "Record exceeds its bounds",
    );

export const credentialMaterialSchema = stringRecordSchema(32, 65536);
export const credentialScopeSchema = z.strictObject({
  tenantId: bounded,
  ownerKind: ownerKindSchema,
  ownerId: bounded,
  connectionRef: connectorReferenceSchema,
  bindingRef: connectorReferenceSchema,
  custody: credentialCustodySchema,
});
export const storedCredentialSchema = z.strictObject({
  schemaVersion,
  ref: connectorReferenceSchema,
  scope: credentialScopeSchema,
  material: credentialMaterialSchema,
  expiresAt: z.number().int().positive().optional(),
  generation: z.number().int().positive(),
  createdAt: time,
  rotatedAt: time,
});
export type StoredCredential = z.infer<typeof storedCredentialSchema>;

export const handoffPresentationSchema = z.enum([
  "same-window",
  "popup",
  "second-device",
  "in-app",
]);
export const handoffIssueInputSchema = z.strictObject({
  connectionRef: connectorReferenceSchema,
  bindingRef: connectorReferenceSchema,
  generation: z.number().int().nonnegative(),
  kind: handoffKindSchema,
  presentation: handoffPresentationSchema,
  expiresAt: z.number().int().positive(),
  intent: stateCodeSchema,
  correlationKey: z.string().min(1).max(1024).regex(noControl).optional(),
  private: stringRecordSchema(32, 65536),
});
export const storedHandoffSchema = handoffIssueInputSchema.safeExtend({
  schemaVersion,
  handoffRef: connectorReferenceSchema,
  tenantId: bounded,
  subjectId: bounded,
  sessionId: bounded,
  state: handoffStateSchema,
  issuedAt: time,
  completedAt: time.optional(),
  reason: stateCodeSchema.optional(),
});
export type StoredHandoff = z.infer<typeof storedHandoffSchema>;
export const correlationIndexSchema = z.strictObject({
  schemaVersion,
  handoffRef: connectorReferenceSchema,
  expiresAt: z.number().int().positive(),
});
export const handoffPointerSchema = z.strictObject({
  schemaVersion,
  handoffRef: connectorReferenceSchema,
});

export const effectStatusSchema = z.enum([
  "applied",
  "not-applied",
  "failed",
  "indeterminate",
  "reconciled",
]);
export const effectOutcomeSchema = z.strictObject({
  status: effectStatusSchema,
  code: stateCodeSchema.optional(),
  at: time,
});
export const effectIntentInputSchema = z.strictObject({
  connectionRef: connectorReferenceSchema.optional(),
  bindingRef: connectorReferenceSchema.optional(),
  operation: z.string().min(1).max(200).regex(noControl),
  digest: z.string().min(1).max(200).regex(noControl),
  idempotency: z
    .strictObject({
      key: z.string().min(1).max(512).regex(noControl),
      scope: z.string().min(1).max(200).regex(noControl),
    })
    .optional(),
  commandId: z.string().min(1).max(200).regex(noControl).optional(),
});
export const storedEffectSchema = effectIntentInputSchema.safeExtend({
  schemaVersion,
  effectRef: connectorReferenceSchema,
  tenantId: bounded,
  subjectId: bounded,
  sessionId: bounded,
  actorKind: z.enum(["human", "agent", "system"]),
  beganAt: time,
  worker: z.string().min(1).max(200),
  status: z.enum(["begun", "orphaned", "completed"]),
  outcome: effectOutcomeSchema.optional(),
  completedAt: time.optional(),
});
export type StoredEffect = z.infer<typeof storedEffectSchema>;
export const effectPointerSchema = z.strictObject({
  schemaVersion,
  effectRef: connectorReferenceSchema,
});

export const externalIdNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
export const connectionRecordSchema = connectionSummarySchema.safeExtend({
  tenantId: bounded,
  ownerId: bounded,
  sessionId: bounded.optional(),
  authorityInstance: z.string().max(256).regex(noControl),
  bindingRevision: z.number().int().nonnegative(),
  policyRevision: bounded,
  configurationRevision: bounded,
  credentialRef: connectorReferenceSchema.optional(),
  externalIds: z
    .record(externalIdNameSchema, nativeIdentifierSchema)
    .refine((value) => Object.keys(value).length <= 32, "Too many ids"),
  evidenceRefs: z.array(connectorReferenceSchema).max(256),
  state: z
    .record(namedKey, z.unknown())
    .refine(
      (value) =>
        Object.keys(value).length <= 64 &&
        Buffer.byteLength(JSON.stringify(value)) <= 65536,
      "State exceeds its bounds",
    ),
});
const {
  connectionRef: _connectionRef,
  tenantId: _tenantId,
  ownerId: _ownerId,
  ownerKind: _ownerKind,
  createdAt: _createdAt,
  generation: _generation,
  revision: _revision,
  ...patchableShape
} = connectionRecordSchema.shape;
/** Identity, ownership and the fenced counters are not patchable; everything else is. */
export const connectionPatchSchema = z.strictObject(patchableShape).partial();

export const disconnectOutcomeSchema = z.enum([
  "applied",
  "unsupported",
  "failed",
  "not-attempted",
  "indeterminate",
]);
export const disconnectScopeSchema = z.enum(["local", "broker", "upstream"]);
export const disconnectRecordSchema = z.strictObject({
  scope: disconnectScopeSchema,
  local: disconnectOutcomeSchema,
  broker: disconnectOutcomeSchema,
  upstream: disconnectOutcomeSchema,
  at: isoTime,
  sharedWith: z.array(connectorReferenceSchema).max(256),
  sharedImpactAcknowledged: z.boolean(),
  codes: z.array(stateCodeSchema).max(16),
});
export type DisconnectRecord = z.infer<typeof disconnectRecordSchema>;
export const storedConnectionSchema = z.strictObject({
  schemaVersion,
  record: connectionRecordSchema,
  keyDigest: sha256HexSchema,
  disconnect: disconnectRecordSchema.optional(),
});
export type StoredConnectionValue = z.infer<typeof storedConnectionSchema>;
export const externalIndexSchema = z.strictObject({
  schemaVersion,
  connectionRef: connectorReferenceSchema,
  authorityInstance: z.string().max(256).regex(noControl),
  name: externalIdNameSchema,
  value: nativeIdentifierSchema,
  exclusive: z.boolean(),
  createdAt: time,
});

export const storedEvidenceSchema = z.strictObject({
  schemaVersion,
  connectionRef: connectorReferenceSchema,
  claim: verificationClaimSchema,
  appendedAt: time,
  stale: z.strictObject({ reason: stateCodeSchema, at: time }).optional(),
});

export const mediaTypeSchema = z
  .string()
  .max(120)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i);
export const storedArtifactSchema = z.strictObject({
  schemaVersion,
  artifactRef: connectorReferenceSchema,
  digest: sha256HexSchema,
  mediaType: mediaTypeSchema,
  byteLength: z.number().int().nonnegative(),
  bytes: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  createdAt: time,
  retainUntil: z.number().int().positive().optional(),
});

export const storedSourceSchema = z.strictObject({
  schemaVersion,
  source: sourceRecordSchema,
});
export const storedDefinitionSchema = z.strictObject({
  schemaVersion,
  definition: normalizedDefinitionSchema,
});
export const storedBindingSchema = z.strictObject({
  schemaVersion,
  binding: runtimeBindingSchema,
});
export const bindingHeadSchema = z.strictObject({
  schemaVersion,
  bindingRef: connectorReferenceSchema,
  revision: z.number().int().nonnegative(),
});

export const budgetSchema = z.strictObject({
  schemaVersion,
  count: z.number().int().nonnegative(),
  expires: time,
  openUntil: time.optional(),
  openCode: stateCodeSchema.optional(),
});

export const supportSnapshotSchema = z.strictObject({
  adapterId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z][a-z0-9-]*$/),
  adapterVersion: nativeVersionSchema,
  runtime: runtimeClassSchema,
  capabilities: z.array(capabilityStatusSchema).max(64),
  capturedAt: isoTime,
});
export type SupportSnapshot = z.infer<typeof supportSnapshotSchema>;
export const storedSupportSchema = z.strictObject({
  schemaVersion,
  snapshot: supportSnapshotSchema,
});
