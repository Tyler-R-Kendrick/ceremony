import { z } from "zod";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import {
  connectorReferenceSchema,
  evidenceTargetSchema,
  nativeIdentifierSchema,
  ownerKindSchema,
  safeTextSchema,
  type ConfigurationRequirement,
} from "../../../../core/connectors/index.js";

/*
 * Wire shapes of the Nango HTTP API as documented at nango.dev/docs on
 * 2026-09-18 (OpenAPI 3.1 fragments embedded in each reference page). Every
 * response schema here is a positive allowlist: unknown keys are stripped, so
 * a field the API adds later, or a credential a privileged endpoint returns,
 * is dropped at the boundary rather than carried into results.
 *
 * Source lock (retrieved 2026-09-18T00:37Z):
 *   POST /connect/sessions, POST /connect/sessions/reconnect,
 *   GET /integrations, GET /integrations/{uniqueKey},
 *   GET /integrations/{uniqueKey}/functions[/{name}],
 *   GET /connections, GET|PATCH|DELETE /connections/{connectionId},
 *   {GET,POST,PUT,PATCH,DELETE} /proxy/{anyPath}, POST /action/trigger,
 *   POST /sync/trigger, POST /sync/start, POST /sync/pause, GET /sync/status,
 *   GET /records; webhooks guide (X-Nango-Hmac-Sha256).
 */

export const NANGO_PROFILE = "nango-http-api-2026-09";
export const NANGO_DEFAULT_API_ORIGIN = "https://api.nango.dev";
export const NANGO_DEFAULT_CONNECT_ORIGIN = "https://connect.nango.dev";
/** Documented connect-session lifetime: "Creates a short-lived connect session (30m)". */
export const NANGO_SESSION_TTL_MS = 30 * 60_000;

export const NANGO_CONFIGURATION_NAMES = Object.freeze({
  secretKey: "NANGO_SECRET_KEY",
  environment: "NANGO_ENVIRONMENT",
  host: "NANGO_HOST",
  webhookSigningKey: "NANGO_WEBHOOK_SIGNING_KEY",
});

export const NANGO_CONFIGURATION: readonly ConfigurationRequirement[] =
  Object.freeze([
    {
      name: NANGO_CONFIGURATION_NAMES.secretKey,
      source: "host",
      classification: "secret",
      required: true,
      description:
        "Nango Environment API key, sent as Authorization: Bearer to the Nango API only.",
    },
    {
      name: NANGO_CONFIGURATION_NAMES.environment,
      source: "host",
      classification: "public",
      required: true,
      description:
        "Nango environment the key belongs to (prod, dev or a custom environment name).",
    },
    {
      name: NANGO_CONFIGURATION_NAMES.host,
      source: "host",
      classification: "public",
      required: false,
      description:
        "Self-hosted Nango API origin; must equal the approved api destination. Defaults to https://api.nango.dev.",
    },
    {
      name: NANGO_CONFIGURATION_NAMES.webhookSigningKey,
      source: "host",
      classification: "secret",
      required: false,
      description:
        "Environment webhook signing key (Environment Settings > Webhooks); distinct from the API key. Required for events.",
    },
  ]);

export const NANGO_LIMITS = Object.freeze({
  responseBytes: 1024 * 1024,
  actionResponseBytes: 10 * 1024 * 1024,
  webhookBytes: 1024 * 1024,
  deadlineMs: 10_000,
  metadataDepth: 8,
  metadataNodes: 512,
  metadataStringLength: 1024,
  pageLimit: 100,
});

const noControl = /^[^\p{Cc}]*$/u;
export const nangoEnvironmentSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "Nango environment must be a lowercase token");

/** Connection tags: "Keys are normalized to lowercase", at most 10 keys, values up to 255 characters. */
export const tagsSchema = z
  .record(z.string().min(1).max(64), z.string().max(255))
  .refine((value) => Object.keys(value).length <= 10, "At most 10 tags");
export type NangoTags = z.infer<typeof tagsSchema>;

export const stdErrorSchema = z.object({
  error: z.object({
    code: z.string().max(200),
    message: z.string().max(4096).optional(),
    errors: z.array(z.unknown()).max(64).optional(),
  }),
});

const isoish = z.string().max(64).regex(noControl);
const boundedText = (max: number) => z.string().max(max).regex(noControl);

export const integrationSchema = z.object({
  unique_key: z.string().min(1).max(512).regex(noControl),
  display_name: boundedText(200),
  provider: z.string().min(1).max(200).regex(noControl),
  logo: z.string().max(2048).optional(),
  created_at: isoish,
  updated_at: isoish,
  forward_webhooks: z.boolean().optional(),
});
export type NangoIntegration = z.infer<typeof integrationSchema>;
export const integrationListSchema = z.object({
  data: z.array(integrationSchema).max(10_000),
});
/**
 * GET /integrations/{uniqueKey} without `include=credentials`. Should a
 * credential block arrive anyway, it is stripped here and never parsed.
 */
export const integrationFullSchema = integrationSchema.extend({
  webhook_url: z.string().max(2048).nullable().optional(),
});

const functionAvailability = {
  id: z.number(),
  enabled: z.boolean(),
  last_deployed: isoish,
  source: z.string().max(32).regex(noControl),
};
const functionCommon = {
  name: z.string().min(1).max(255).regex(noControl),
  description: z.string().max(4096).optional(),
  scopes: z.array(z.string().max(512)).max(256).optional(),
  input: z.string().max(255).nullable().optional(),
  returns: z.array(z.string().max(255)).max(64).optional(),
  json_schema: z.unknown().optional(),
};
export const nangoFunctionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sync"),
    ...functionCommon,
    runs: z.string().max(120).nullable(),
    auto_start: z.boolean(),
    track_deletes: z.boolean(),
    ...functionAvailability,
  }),
  z.object({
    type: z.literal("action"),
    ...functionCommon,
    ...functionAvailability,
  }),
  z.object({
    type: z.literal("on-event"),
    ...functionCommon,
    event: z.string().max(64).regex(noControl),
    ...functionAvailability,
  }),
]);
export type NangoFunction = z.infer<typeof nangoFunctionSchema>;
export const functionListSchema = z.object({
  data: z.array(nangoFunctionSchema).max(NANGO_LIMITS.pageLimit),
  pagination: z.object({
    total: z.number().int().nonnegative(),
    page: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
});

export const connectSessionSchema = z.object({
  data: z.object({
    token: z.string().min(1).max(4096),
    expires_at: z.string().max(64),
    connect_link: z.string().max(4096).optional(),
  }),
});

export const connectionErrorSchema = z.object({
  type: z.string().max(32).regex(noControl),
  log_id: z.string().max(200).regex(noControl),
});
export const connectionListItemSchema = z.object({
  id: z.number().int(),
  connection_id: z.string().min(1).max(512).regex(noControl),
  provider: z.string().min(1).max(200).regex(noControl),
  provider_config_key: z.string().min(1).max(512).regex(noControl),
  created: isoish,
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  tags: tagsSchema.optional(),
  errors: z.array(connectionErrorSchema).max(64).optional(),
});
export type NangoConnectionListItem = z.infer<typeof connectionListItemSchema>;
export const connectionListSchema = z.object({
  connections: z.array(connectionListItemSchema).max(10_000),
});

/**
 * Privileged GET /connections/{connectionId}: the documented response carries
 * `credentials` (tokens, secrets, raw provider payloads) and fetching it may
 * refresh them. Only expiry and scheme are read from that block; everything
 * else in it is stripped by this allowlist before the value leaves the parser.
 */
export const connectionFullAllowlistSchema = z.object({
  id: z.number().int(),
  connection_id: z.string().min(1).max(512).regex(noControl),
  provider_config_key: z.string().min(1).max(512).regex(noControl),
  provider: z.string().min(1).max(200).regex(noControl),
  errors: z.array(connectionErrorSchema).max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  tags: tagsSchema.optional(),
  created_at: isoish,
  updated_at: isoish,
  last_fetched_at: isoish.optional(),
  credentials: z
    .object({
      type: z.string().max(32).regex(noControl).optional(),
      expires_at: z.string().max(64).optional(),
    })
    .optional(),
});

export const successSchema = z.object({ success: z.boolean().optional() });

export const actionAsyncSchema = z.object({
  id: z.string().min(1).max(200),
  statusUrl: z.string().max(2048),
});

export const syncStatusSchema = z.object({
  syncs: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]).optional(),
        connection_id: z.string().max(512).optional(),
        name: z.string().max(255),
        variant: z.string().max(255).optional(),
        status: z.string().max(32),
        type: z.string().max(32).optional(),
        finishedAt: z.string().max(64).nullable().optional(),
        nextScheduledSyncAt: z.string().max(64).nullable().optional(),
        frequency: z.string().max(120).nullable().optional(),
        latestResult: z.unknown().optional(),
        recordCount: z.unknown().optional(),
        checkpoint: z.unknown().optional(),
      }),
    )
    .max(1000),
});
export type NangoSyncStatus = z.infer<typeof syncStatusSchema>["syncs"][number];

export const recordsPageSchema = z.object({
  records: z
    .array(
      z.looseObject({
        _nango_metadata: z.object({
          deleted_at: z.string().nullable().optional(),
          last_action: z.string().max(16),
          first_seen_at: z.string().max(64),
          last_modified_at: z.string().max(64),
          cursor: z.string().max(4096),
          pruned_at: z.string().nullable().optional(),
        }),
      }),
    )
    .max(10_000),
  next_cursor: z.string().max(4096).nullable(),
});

/* ---------------------------------------------------------------- webhooks */

const webhookBase = {
  connectionId: z.string().min(1).max(512).regex(noControl),
  providerConfigKey: z.string().min(1).max(512).regex(noControl),
};
const webhookError = z
  .object({
    type: z.string().max(200).optional(),
    description: z.string().max(4096).optional(),
  })
  .optional();
export const authWebhookSchema = z.object({
  type: z.literal("auth"),
  operation: z.string().max(32).regex(noControl),
  ...webhookBase,
  provider: z.string().max(200).regex(noControl).optional(),
  authMode: z.string().max(64).regex(noControl).optional(),
  environment: z.string().max(64).regex(noControl).optional(),
  success: z.boolean(),
  tags: tagsSchema.optional(),
  error: webhookError,
});
export const authWebhookOperations = [
  "creation",
  "override",
  "refresh",
  "deletion",
] as const;
const checkpointObject = z.record(
  z.string().max(200),
  z.union([z.string().max(4096), z.number(), z.boolean()]),
);
export const syncWebhookSchema = z.object({
  type: z.literal("sync"),
  ...webhookBase,
  syncName: z.string().min(1).max(255).regex(noControl),
  model: z.string().min(1).max(255).regex(noControl),
  syncType: z.string().max(32).optional(),
  success: z.boolean(),
  modifiedAfter: z.string().max(64).optional(),
  responseResults: z
    .object({
      added: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
    })
    .optional(),
  checkpoints: z
    .object({
      from: checkpointObject.nullable().optional(),
      to: checkpointObject.nullable().optional(),
    })
    .nullable()
    .optional(),
  error: webhookError,
  startedAt: z.string().max(64).optional(),
  failedAt: z.string().max(64).optional(),
});
export const forwardWebhookSchema = z.object({
  type: z.literal("forward"),
  from: z.string().max(200).regex(noControl),
  ...webhookBase,
  payload: z.unknown(),
});
export const genericWebhookSchema = z.looseObject({
  type: z.string().max(64).regex(noControl).optional(),
});

/* ------------------------------------------------- host-approved contracts */

export type JsonType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";
const jsonTypeSchema = z.enum([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const jsonScalar = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);

/**
 * The bounded JSON Schema subset an operation contract may use. It is
 * validated structurally when a binding is read; keywords that would require
 * remote references, regular expressions or composition are refused rather
 * than silently ignored, because a silently ignored constraint is a widened
 * input contract.
 */
export type JsonSubsetSchema = {
  type?: JsonType | JsonType[];
  properties?: Record<string, JsonSubsetSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSubsetSchema;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
};
export const jsonSubsetSchema: z.ZodType<JsonSubsetSchema> = z.lazy(() =>
  z.strictObject({
    type: z.union([jsonTypeSchema, z.array(jsonTypeSchema).min(1).max(7)]).optional(),
    properties: z
      .record(identifierSchema, jsonSubsetSchema)
      .refine((value) => Object.keys(value).length <= 128)
      .optional(),
    required: z.array(identifierSchema).max(128).optional(),
    additionalProperties: z.boolean().optional(),
    items: jsonSubsetSchema.optional(),
    enum: z.array(jsonScalar).min(1).max(256).optional(),
    const: jsonScalar.optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    description: safeTextSchema.optional(),
  }),
);

export type JsonIssue = { path: string; code: string };

/** Validates a value against the subset; objects reject unknown keys unless the schema says otherwise. */
export function validateJsonSubset(
  schema: JsonSubsetSchema,
  value: unknown,
  path = "",
  depth = 0,
): JsonIssue[] {
  const issues: JsonIssue[] = [];
  if (depth > 32) return [{ path, code: "depth" }];
  const types = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : undefined;
  const actual: JsonType | undefined =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "object"
          ? "object"
          : typeof value === "string"
            ? "string"
            : typeof value === "boolean"
              ? "boolean"
              : typeof value === "number" && Number.isFinite(value)
                ? Number.isInteger(value)
                  ? "integer"
                  : "number"
                : undefined;
  if (actual === undefined) return [{ path, code: "type" }];
  if (
    types &&
    !types.some((type) => type === actual || (type === "number" && actual === "integer"))
  )
    return [{ path, code: "type" }];
  if (schema.enum && !schema.enum.some((item) => item === value))
    issues.push({ path, code: "enum" });
  if (schema.const !== undefined && schema.const !== value)
    issues.push({ path, code: "const" });
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      issues.push({ path, code: "minimum" });
    if (schema.maximum !== undefined && value > schema.maximum)
      issues.push({ path, code: "maximum" });
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      issues.push({ path, code: "min-length" });
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      issues.push({ path, code: "max-length" });
    if (!noControl.test(value)) issues.push({ path, code: "control-characters" });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      issues.push({ path, code: "min-items" });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      issues.push({ path, code: "max-items" });
    if (value.length > 4096) issues.push({ path, code: "max-items" });
    else if (schema.items)
      value.forEach((item, index) =>
        issues.push(
          ...validateJsonSubset(schema.items!, item, `${path}/${index}`, depth + 1),
        ),
      );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
      issues.push({ path, code: "reserved-key" });
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(record, key))
        issues.push({ path: `${path}/${key}`, code: "required" });
    for (const key of keys) {
      const property = schema.properties?.[key];
      if (property)
        issues.push(
          ...validateJsonSubset(property, record[key], `${path}/${key}`, depth + 1),
        );
      else if (schema.additionalProperties !== true)
        issues.push({ path: `${path}/${key}`, code: "additional-property" });
    }
  }
  return issues;
}

const parameterSpecSchema = z.strictObject({
  type: z.enum(["string", "integer", "number", "boolean"]).default("string"),
  required: z.boolean().default(false),
  maxLength: z.number().int().positive().max(4096).default(512),
  enum: z.array(z.string().max(512)).min(1).max(256).optional(),
  description: safeTextSchema.optional(),
});
export type ParameterSpec = z.infer<typeof parameterSpecSchema>;

/** Headers Nango consumes for routing or authority; a contract can never set them. */
export const reservedProxyHeaders = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection-id",
  "provider-config-key",
  "base-url-override",
  "retries",
  "retry-on",
  "decompress",
  "x-async",
  "x-max-retries",
  "proxy-authorization",
]);
const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
  .refine((name) => !reservedProxyHeaders.has(name.toLowerCase()));

/**
 * Per-operation execution contract, host-approved inside the binding's
 * settings. It declares the parameters a caller may supply, the body and
 * output shapes, and the deadline, response ceiling, rate limit and retry
 * budget the adapter enforces. Anything not declared here is not an input.
 */
export const operationContractSchema = z.strictObject({
  path: z.record(identifierSchema, parameterSpecSchema).optional(),
  query: z.record(identifierSchema, parameterSpecSchema).optional(),
  headers: z.record(headerNameSchema, z.string().max(1024).regex(noControl)).optional(),
  body: jsonSubsetSchema.optional(),
  output: jsonSubsetSchema.optional(),
  deadlineMs: z.number().int().min(1000).max(120_000).default(NANGO_LIMITS.deadlineMs),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(NANGO_LIMITS.actionResponseBytes)
    .default(NANGO_LIMITS.responseBytes),
  rateLimit: z
    .strictObject({ perMinute: z.number().int().min(1).max(100_000) })
    .optional(),
  retries: z.number().int().min(0).max(3).default(0),
});
export type OperationContract = z.infer<typeof operationContractSchema>;

const httpsOrLoopback = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}, "HTTPS or loopback HTTP without credentials");

/**
 * Adapter-owned binding settings. They are written by the host when the
 * binding is approved and never by a caller. `integration` is the one Nango
 * integration this binding may touch; `webhookUrlOverride` is default-deny and
 * exists only when an administrator recorded the approval.
 */
export const nangoBindingSettingsSchema = z.strictObject({
  integration: z.strictObject({
    uniqueKey: nativeIdentifierSchema,
    provider: z.string().min(1).max(200).regex(noControl),
  }),
  presentation: z.enum(["popup", "same-window"]).default("popup"),
  webhookUrlOverride: z
    .strictObject({
      url: httpsOrLoopback,
      approvedBy: safeTextSchema.min(1),
      approvedAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
  verification: z
    .strictObject({
      operationRef: connectorReferenceSchema,
      /** JSON pointer into the operation output naming the account identity. */
      identityPointer: z.string().regex(/^(\/[^/\p{Cc}~]{1,120}){1,8}$/u),
      targetKind: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    })
    .optional(),
  operations: z
    .record(connectorReferenceSchema, operationContractSchema)
    .refine((value) => Object.keys(value).length <= 4096)
    .default({}),
});
export type NangoBindingSettings = z.infer<typeof nangoBindingSettingsSchema>;

/** A strict reading of the shared intent: unknown fields are an attempt to smuggle policy. */
export const authorizationIntentSchema = z.strictObject({
  profileId: identifierSchema.optional(),
  ownerKind: ownerKindSchema,
  requestedPermissions: z.array(z.string().min(1).max(200)).max(64),
  target: evidenceTargetSchema.optional(),
  accountSwitch: z.boolean(),
  interruption: z.enum(["allowed", "none"]),
});

export const NANGO_PROFILE_IDS = Object.freeze({
  connection: "nango-connection",
  proxy: "nango-proxy",
});
