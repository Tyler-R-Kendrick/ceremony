import { z } from "zod";

/*
 * Wire shapes of the Integration Connectors API, pinned to the service's own
 * discovery documents at revision 20260907, fetched on 2026-09-18 from
 * https://connectors.googleapis.com/$discovery/rest?version=v1 and
 * https://connectors.googleapis.com/$discovery/rest?version=v2.
 *
 * `v1` is the administrative surface (connections and their schema metadata);
 * `v2` is the runtime surface (entity types, entities, actions, status). They
 * are different APIs with different shapes and are kept apart here, because a
 * connection's configuration and a connection's data are different authority.
 */

export const GOOGLE_CONNECTORS_ADAPTER_VERSION = "1.0.0";
export const GOOGLE_CONNECTORS_DISCOVERY_REVISION = "20260907";
export const GOOGLE_CONNECTORS_ADMIN_PROFILE = "google-connectors-v1-20260907";
export const GOOGLE_CONNECTORS_RUNTIME_PROFILE =
  "google-connectors-v2-20260907";
/** The only scope the documented methods list. */
export const GOOGLE_CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);

export const connectionStateSchema = z.enum([
  "STATE_UNSPECIFIED",
  "CREATING",
  "ACTIVE",
  "INACTIVE",
  "DELETING",
  "UPDATING",
  "ERROR",
  "AUTHORIZATION_REQUIRED",
]);

export const connectionSchema = z.object({
  name: z.string().max(512),
  description: text(2048).optional(),
  connectorVersion: z.string().max(512).optional(),
  status: z
    .object({
      state: connectionStateSchema.optional(),
      description: text(2048).optional(),
      status: text(512).optional(),
    })
    .optional(),
  serviceAccount: z.string().max(256).optional(),
  suspended: z.boolean().optional(),
  /** "Connection allows the customers to initiate async long running operations using the actions API." */
  asyncOperationsEnabled: z.boolean().optional(),
  /** "Connection allows the backend service auth to be overridden in the entities/actions API." */
  authOverrideEnabled: z.boolean().optional(),
  fallbackOnAdminCredentials: z.boolean().optional(),
  eventingEnablementType: z.string().max(64).optional(),
  connectionRevision: z.string().max(64).optional(),
  /** Set when the connection reaches a private endpoint through Service Directory. */
  serviceDirectory: z.string().max(512).optional(),
  tlsServiceDirectory: z.string().max(512).optional(),
  host: z.string().max(256).optional(),
  createTime: z.string().max(64).optional(),
  updateTime: z.string().max(64).optional(),
});
export type GoogleConnection = z.infer<typeof connectionSchema>;

export const listConnectionsResponseSchema = z.object({
  connections: z.array(z.unknown()).max(1000).default([]),
  nextPageToken: z.string().max(4096).optional(),
  unreachable: z.array(text(256)).max(64).optional(),
});

export const dataTypeSchema = z.string().max(64);

export const fieldSchema = z.object({
  name: z.string().max(200),
  dataType: dataTypeSchema.optional(),
  key: z.boolean().optional(),
  nullable: z.boolean().optional(),
  description: text(2048).optional(),
  defaultValue: z.unknown().optional(),
  jsonSchema: z.unknown().optional(),
  reference: z.unknown().optional(),
  additionalDetails: z.unknown().optional(),
});

/** `RuntimeEntitySchema` of the v1 metadata surface. */
export const runtimeEntitySchema = z.object({
  entity: z.string().max(200),
  fields: z.array(fieldSchema).max(4096).default([]),
  operations: z.array(z.string().max(64)).max(32).optional(),
  jsonSchema: z.unknown().optional(),
});
export type RuntimeEntitySchema = z.infer<typeof runtimeEntitySchema>;

export const listEntityTypesMetadataResponseSchema = z.object({
  entityTypes: z.array(z.unknown()).max(1000).default([]),
  nextPageToken: z.string().max(4096).optional(),
});

export const inputParameterSchema = z.object({
  name: z.string().max(200),
  dataType: dataTypeSchema.optional(),
  nullable: z.boolean().optional(),
  description: text(2048).optional(),
  defaultValue: z.unknown().optional(),
  jsonSchema: z.unknown().optional(),
});

/** `RuntimeActionSchema` of the v1 metadata surface. */
export const runtimeActionSchema = z.object({
  action: z.string().max(200),
  displayName: text(200).optional(),
  description: text(2048).optional(),
  inputParameters: z.array(inputParameterSchema).max(512).default([]),
  resultMetadata: z.array(inputParameterSchema).max(512).default([]),
  inputJsonSchema: z.unknown().optional(),
  resultJsonSchema: z.unknown().optional(),
});
export type RuntimeActionSchema = z.infer<typeof runtimeActionSchema>;

export const listActionsMetadataResponseSchema = z.object({
  actions: z.array(z.unknown()).max(1000).default([]),
  nextPageToken: z.string().max(4096).optional(),
});

/** `ListEntityTypesResponse` of the v2 runtime surface. */
export const runtimeListEntityTypesResponseSchema = z.object({
  types: z.array(z.unknown()).max(1000).default([]),
  nextPageToken: z.string().max(4096).optional(),
  /** "List of entity type names which contain unsupported Datatypes." */
  unsupportedTypeNames: z.array(z.string().max(200)).max(1000).optional(),
});

export const runtimeListActionsResponseSchema = z.object({
  actions: z.array(z.unknown()).max(1000).default([]),
  nextPageToken: z.string().max(4096).optional(),
  unsupportedActionNames: z.array(z.string().max(200)).max(1000).optional(),
});

export const entitySchema = z.object({
  name: z.string().max(1024).optional(),
  fields: z.record(z.string().max(200), z.unknown()).optional(),
});

export const listEntitiesResponseSchema = z.object({
  entities: z.array(entitySchema).max(1000).default([]),
  nextPageToken: z.string().max(4096).optional(),
});

export const executeActionResponseSchema = z.object({
  results: z.array(z.unknown()).max(1000).optional(),
});

export const checkStatusResponseSchema = z.object({
  state: z.enum(["STATE_UNSPECIFIED", "ACTIVE", "ERROR", "AUTH_ERROR"]),
  description: text(2048).optional(),
});

/** Google API error envelope; the provider's own message never leaves server code. */
export const googleErrorSchema = z.object({
  error: z
    .object({
      code: z.number().int().optional(),
      message: z.string().max(4096).optional(),
      status: z.string().max(64).optional(),
    })
    .optional(),
});
