import { z } from "zod";
import { identifierSchema } from "../../../core/operation-contracts.js";
import {
  DEFINITION_LIMITS,
  boundedJsonGuard,
  connectorReferenceSchema,
  credentialCustodySchema,
  nativeIdentifierSchema,
  ownerKindSchema,
} from "../../../core/connectors/index.js";
import { boundOperationSchema } from "../binding.js";

/*
 * Everything a caller may say to a connector command. Note what is absent:
 * no tenant, subject, session, role, capability, URL, header, scope owner or
 * credential. The actor comes from host authentication; destinations,
 * transports and credential authority come from a reviewed binding. Unknown
 * keys are rejected, so a forged `tenantId` in a body is an invalid request
 * rather than a silently ignored one.
 */

export const referenceSchema = connectorReferenceSchema;
export const commandIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/);
export const adapterIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,119}$/);
const configurationNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const noControl = /^[^\p{Cc}]*$/u;

export const targetInputSchema = z.strictObject({
  kind: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/),
  id: nativeIdentifierSchema,
});
export type TargetInput = z.infer<typeof targetInputSchema>;

export const intentInputSchema = z.strictObject({
  profileId: identifierSchema.optional(),
  requestedPermissions: z
    .array(z.string().min(1).max(200).regex(noControl))
    .max(64)
    .default([]),
  target: targetInputSchema.optional(),
  /** Explicit human intent to replace the verified account; never inferred. */
  accountSwitch: z.boolean().default(false),
  /** "none" may yield human-required; it is never a bypass. */
  interruption: z.enum(["allowed", "none"]).default("allowed"),
});
export type IntentInput = z.infer<typeof intentInputSchema>;

export const connectInputSchema = z.strictObject({
  bindingRef: referenceSchema,
  ownerKind: ownerKindSchema.default("user"),
  /** A connection that outlives the session; requires explicit host authorization. */
  durable: z.boolean().default(false),
  intent: intentInputSchema.default({
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  }),
});
export type ConnectInput = z.infer<typeof connectInputSchema>;

export const reconnectInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  accountSwitch: z.boolean().default(false),
  interruption: z.enum(["allowed", "none"]).default("allowed"),
  requestedPermissions: z
    .array(z.string().min(1).max(200).regex(noControl))
    .max(64)
    .optional(),
  target: targetInputSchema.optional(),
});
export type ReconnectInput = z.infer<typeof reconnectInputSchema>;

export const disconnectScopeSchema = z.enum(["local", "broker", "upstream"]);
export const disconnectInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  scope: disconnectScopeSchema.default("local"),
  /** Required when other local connections share the affected upstream grant. */
  acknowledgeSharedImpact: z.boolean().default(false),
});
export type DisconnectInput = z.infer<typeof disconnectInputSchema>;

export const administrativeInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});

export const INVOKE_INPUT_LIMITS = Object.freeze({
  depth: 16,
  nodes: 2048,
  bytes: 64 * 1024,
  stringLength: 8192,
});
export const invokeInputSchema = z.strictObject({
  operationRef: referenceSchema,
  input: z
    .preprocess(
      boundedJsonGuard(INVOKE_INPUT_LIMITS),
      z.record(z.string().min(1).max(120), z.unknown()),
    )
    .default({}),
  commandId: commandIdSchema,
  /** An authenticated human's explicit confirmation; ignored for any other actor kind. */
  confirm: z.boolean().default(false),
});
export type InvokeInput = z.infer<typeof invokeInputSchema>;

export const handoffValuesSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/),
    z.string().max(4096),
  )
  .refine((values) => Object.keys(values).length <= 32, "Too many fields");
export const handoffInputSchema = z.strictObject({
  values: handoffValuesSchema,
});

export const mediaTypeSchema = z
  .string()
  .max(120)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i);
export const importInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("upload"),
    mediaType: mediaTypeSchema,
    text: z.string().max(DEFINITION_LIMITS.bytes),
    adapterId: adapterIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("url"),
    url: z.url().max(2048),
    adapterId: adapterIdSchema.optional(),
  }),
]);
export type ImportInput = z.infer<typeof importInputSchema>;

/** A reviewer's per-operation decision; strings mean "as the definition declares it". */
export const operationApprovalSchema = z.strictObject({
  nativeId: nativeIdentifierSchema,
  transport: boundOperationSchema.shape.transport.optional(),
  /** Approved destination by index (1-based) or exact origin; defaults to the only approved destination. */
  destination: z
    .union([z.number().int().positive(), z.string().max(2048)])
    .optional(),
  effect: boundOperationSchema.shape.effect.optional(),
  outputClassification:
    boundOperationSchema.shape.outputClassification.optional(),
  cost: boundOperationSchema.shape.cost.optional(),
  consent: boundOperationSchema.shape.consent.optional(),
  replay: boundOperationSchema.shape.replay.optional(),
  targetParameters: boundOperationSchema.shape.targetParameters.optional(),
  authenticationProfile: identifierSchema.optional(),
});
export type OperationApproval = z.infer<typeof operationApprovalSchema>;

export const bindingApprovalSchema = z.strictObject({
  definitionRef: referenceSchema,
  adapterId: adapterIdSchema,
  approvals: z.strictObject({
    /** Each entry is one explicit decision: a declared server URL, its origin, or a host-allowlisted origin. */
    destinations: z.array(z.string().min(1).max(2048).regex(noControl)).max(32),
    operations: z
      .array(z.union([nativeIdentifierSchema, operationApprovalSchema]))
      .max(DEFINITION_LIMITS.capabilities),
    profileId: identifierSchema.optional(),
    permittedTargets: z.array(targetInputSchema).max(256).default([]),
    configuration: z.array(configurationNameSchema).max(48).optional(),
    custody: credentialCustodySchema.optional(),
    authorityInstance: z.string().max(256).regex(noControl).optional(),
    /** Owner consent that assistants may read personal outputs; only a person can give it. */
    agentOutputConsent: z.enum(["none", "personal"]).optional(),
    /** Inert adapter settings a reviewer approves (client id, API version); never a secret or an executable URL. */
    settings: z
      .preprocess(
        boundedJsonGuard(
          { depth: 4, nodes: 256, bytes: 16 * 1024, stringLength: 2048 },
          { maxKeys: 64 },
        ),
        z.record(z.string().min(1).max(120), z.unknown()),
      )
      .default({}),
  }),
});
export type BindingApprovalInput = z.infer<typeof bindingApprovalSchema>;

export const configureInputSchema = z.strictObject({
  /** A one-use reference from the private collection path; values never travel in this JSON. */
  secretRef: z.uuid(),
  names: z.array(configurationNameSchema).min(1).max(48).optional(),
});
export type ConfigureInput = z.infer<typeof configureInputSchema>;

/** Native extension key under which an importer may declare an operation's transport. */
export const TRANSPORT_EXTENSION = "x-ceremony-transport";
/** Native extension key naming which declared server an operation targets (URL or 1-based index). */
export const SERVER_EXTENSION = "x-ceremony-server";
