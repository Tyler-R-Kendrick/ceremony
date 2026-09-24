import { z } from "zod";

export const identifierSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/)
  .refine(
    (value) => !["__proto__", "prototype", "constructor"].includes(value),
  );
export const semanticVersionSchema = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
/**
 * The id of an operation a signed operation pack provides:
 * `pack:<packId>/<operation>`. The slash never occurs in a host operation id,
 * so a pack can neither shadow a built-in step nor another pack's, and only
 * `OperationRegistry.registerPack` accepts this shape.
 */
export const packOperationIdSchema = z
  .string()
  .regex(/^pack:[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,47}$/);
/** A registered operation's id: a host identifier or a pack operation id. */
export const operationIdSchema = z.union([
  identifierSchema,
  packOperationIdSchema,
]);
export const fieldClassificationSchema = z.enum([
  "public",
  "personal",
  "secret",
  "artifact",
  "unclassified",
]);
export type FieldClassification = z.infer<typeof fieldClassificationSchema>;
/** This is a reference into host-owned vocabulary, never a caller-defined schema. */
export const registeredInputContractSchema = z
  .object({ contract: identifierSchema, required: z.boolean() })
  .strict();
export type RegisteredInputContract = z.infer<
  typeof registeredInputContractSchema
>;
export const publicValueSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const operationContractSchema = z
  .object({
    id: operationIdSchema,
    version: semanticVersionSchema,
    provider: identifierSchema,
    profile: identifierSchema,
    inputs: z.record(identifierSchema, registeredInputContractSchema),
    outputs: z.record(identifierSchema, registeredInputContractSchema),
    effects: z.array(operationIdSchema).max(16),
    verifier: operationIdSchema,
    humanFallback: identifierSchema,
  })
  .strict();
export type OperationContract = z.infer<typeof operationContractSchema>;
/** Parsing this shape does not authenticate it. Only a trusted host identity adapter may derive it. */
export const actorIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const actorContextSchema = z
  .object({
    tenantId: actorIdentifierSchema,
    subjectId: actorIdentifierSchema,
    sessionId: actorIdentifierSchema,
    actorKind: z.enum(["human", "agent", "system"]),
    capabilities: z
      .array(z.enum(["author", "reviewer", "publisher", "executor", "admin"]))
      .max(5),
    delegationId: actorIdentifierSchema.optional(),
  })
  .strict();
export type ActorContext = z.infer<typeof actorContextSchema>;
