import { z } from "zod";
import {
  connectorReferenceSchema,
  nativeIdentifierSchema,
} from "../../../../core/connectors/index.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import type { RuntimeBinding } from "../../binding.js";
import { compiledSchemaSchema } from "./schema.js";

/*
 * A bound operation names a method and a path template; it cannot say how the
 * inputs are serialized or what shapes they must have. That knowledge is the
 * operation plan: inert, host-approved data stored beside the binding under
 * `settings["openapi-http"]`, pinned by the binding's reviewed digest, and
 * re-validated on every call. Plans carry no credentials, no URLs and no
 * examples — only names, locations, styles and the compiled schema subset.
 */

export const PLAN_SETTINGS_KEY = "openapi-http";
export const PLAN_VERSION = 1;

export const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const planParameterSchema = z.strictObject({
  name: z.string().min(1).max(256),
  in: z.enum(["path", "query", "header"]),
  required: z.boolean(),
  style: z.enum(["simple", "form"]),
  explode: z.boolean(),
  allowReserved: z.boolean(),
  schema: compiledSchemaSchema,
});
export type PlanParameter = z.infer<typeof planParameterSchema>;

export const planSecuritySchema = z.strictObject({
  /** Profiles presented together on one request (a conjunction); empty means anonymous access. */
  profiles: z
    .array(
      z.strictObject({
        profileId: identifierSchema,
        scheme: z.string().min(1).max(256),
        scopes: z.array(z.string().min(1).max(200)).max(64),
      }),
    )
    .max(8),
});

export const operationPlanSchema = z.strictObject({
  version: z.literal(PLAN_VERSION),
  nativeId: nativeIdentifierSchema,
  method: z.enum(HTTP_METHODS),
  pathTemplate: z
    .string()
    .max(1024)
    .regex(/^\/[^\p{Cc}?#]*$/u),
  parameters: z.array(planParameterSchema).max(64),
  requestBody: z
    .strictObject({
      required: z.boolean(),
      mediaType: z.string().min(1).max(120),
      schema: compiledSchemaSchema,
    })
    .optional(),
  /** Declared responses and whether a JSON body is documented for them; informational. */
  responses: z
    .array(z.strictObject({ status: z.string().min(1).max(8), json: z.boolean() }))
    .max(64),
  security: planSecuritySchema,
  definitions: z.record(z.string().min(1).max(1024), compiledSchemaSchema),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .optional(),
});
export type OperationPlan = z.infer<typeof operationPlanSchema>;

export const planSettingsSchema = z.strictObject({
  version: z.literal(PLAN_VERSION),
  readerVersion: z.string().min(1).max(64),
  plans: z.record(connectorReferenceSchema, operationPlanSchema),
  /** An approved read operation the host names as the credential verifier, with its fixed input. */
  verifier: z
    .strictObject({
      operationRef: connectorReferenceSchema,
      input: z.unknown().optional(),
    })
    .optional(),
});
export type PlanSettings = z.infer<typeof planSettingsSchema>;

/** The plan settings of a binding, or undefined when the binding carries none or carries an invalid one. */
export function planSettingsOf(binding: RuntimeBinding): PlanSettings | undefined {
  const raw = binding.settings[PLAN_SETTINGS_KEY];
  if (raw === undefined) return undefined;
  const parsed = planSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function planFromBinding(
  binding: RuntimeBinding,
  operationRef: string,
): OperationPlan | undefined {
  const settings = planSettingsOf(binding);
  if (!settings || !Object.hasOwn(settings.plans, operationRef)) return undefined;
  return settings.plans[operationRef];
}
