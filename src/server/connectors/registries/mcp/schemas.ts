import { z } from "zod";
import {
  nativeIdentifierSchema,
  nativeVersionSchema,
} from "../../../../core/connectors/identity.js";

/*
 * Pinned wire shapes of the official MCP registry and of the `server.json`
 * document it serves. Two independent versions are pinned on purpose: the REST
 * API (`/v0.1`, "Official MCP Registry" OpenAPI 1.0.0, generic registry spec
 * `2025-12-01`) and the `server.json` schema (`2025-12-11`). Upstream shapes are
 * read with loose objects so that fields this code does not know are carried
 * as inert data instead of being dropped or trusted; the export shape is strict
 * because a document this deployment publishes must be exactly what it claims.
 *
 * Sources, fetched 2026-09-18:
 * - https://modelcontextprotocol.io/registry/registry-aggregators
 * - https://modelcontextprotocol.io/registry/about
 * - https://registry.modelcontextprotocol.io/openapi.yaml
 * - https://raw.githubusercontent.com/modelcontextprotocol/registry/main/docs/reference/api/openapi.yaml
 * - https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 */

/** Production host of the official registry (documented base URL). */
export const MCP_REGISTRY_OFFICIAL_BASE_URL =
  "https://registry.modelcontextprotocol.io";
/** Documented staging host; never a default. */
export const MCP_REGISTRY_STAGING_BASE_URL =
  "https://staging.registry.modelcontextprotocol.io";
export const MCP_REGISTRY_API_VERSION = "v0.1";
/** Profile identifier reported on capability rows. */
export const MCP_REGISTRY_API_PROFILE = "mcp-registry-api-v0.1";
/** The generic registry OpenAPI document this client is written against. */
export const MCP_REGISTRY_GENERIC_SPEC_ID =
  "https://modelcontextprotocol.io/schemas/draft/2025-12-01/server-registry-openapi";
export const MCP_REGISTRY_OFFICIAL_META_KEY =
  "io.modelcontextprotocol.registry/official";
export const MCP_REGISTRY_PUBLISHER_META_KEY =
  "io.modelcontextprotocol.registry/publisher-provided";
export const SERVER_JSON_SCHEMA_VERSION = "2025-12-11";
export const SERVER_JSON_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
export const SERVER_JSON_PROFILE = "server-json-2025-12-11";
/**
 * Schema versions whose field names this reader understands (camelCase since
 * 2025-09-16). Older snake_case documents are refused, not guessed at.
 */
export const SERVER_JSON_COMPATIBLE_SCHEMA_VERSIONS = [
  "2025-09-16",
  "2025-09-29",
  "2025-10-11",
  "2025-10-17",
  "2025-12-11",
] as const;
export const MCP_REGISTRY_IMPORTER_ID = "mcp-registry-server-json";
export const MCP_REGISTRY_IMPORTER_VERSION = "1.0.0";
export const MCP_REGISTRY_ADAPTER_VERSION = "1.0.0";

/** Server names: reverse-DNS namespace, exactly one slash, registry pattern. */
export const registryServerNamePattern = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
export const registryServerNameSchema = nativeIdentifierSchema
  .refine((value) => value.length >= 3 && value.length <= 200)
  .refine(
    (value) => registryServerNamePattern.test(value),
    "Server name must be namespace/name in reverse-DNS form",
  );
/** A version as a document field: opaque, bounded, never the `latest` alias and never a range. */
const versionRange = /^[\^~<>=]|[\s]|[*]|(^|\.)x($|\.)/;
export const registryVersionSchema = nativeVersionSchema
  .refine((value) => value !== "latest", "latest is a request alias")
  .refine((value) => !versionRange.test(value), "Version ranges are rejected");
/** A version in a request path: an exact version or the documented `latest` alias. */
export const registryRequestVersionSchema = nativeVersionSchema;

export function splitRegistryServerName(name: string): {
  namespace: string;
  server: string;
} {
  const parsed = registryServerNameSchema.parse(name);
  const slash = parsed.indexOf("/");
  return { namespace: parsed.slice(0, slash), server: parsed.slice(slash + 1) };
}

const noControl = /^[^\p{Cc}]*$/u;
const text = (max: number) => z.string().max(max).regex(noControl);
const nullableArray = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item).max(max).nullable().optional();
export const isoDateTime = z.iso.datetime({ offset: true });

/** `Input` from the pinned schema; unknown fields are kept. */
export const registryInputSchema = z.looseObject({
  description: text(4096).optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  format: z.enum(["string", "number", "boolean", "filepath"]).optional(),
  choices: nullableArray(text(1024), 256),
  default: text(8192).optional(),
  placeholder: text(2048).optional(),
  value: text(8192).optional(),
});
export type RegistryInput = z.infer<typeof registryInputSchema>;
const variables = z
  .record(text(120).min(1), registryInputSchema)
  .refine((value) => Object.keys(value).length <= 64)
  .optional();
export const registryKeyValueInputSchema = registryInputSchema.extend({
  name: text(512).min(1),
  variables,
});
export type RegistryKeyValueInput = z.infer<typeof registryKeyValueInputSchema>;
export const registryArgumentSchema = registryInputSchema.extend({
  type: z.enum(["positional", "named"]),
  name: text(512).optional(),
  valueHint: text(512).optional(),
  isRepeated: z.boolean().optional(),
  variables,
});
export type RegistryArgument = z.infer<typeof registryArgumentSchema>;
export const registryTransportSchema = z.looseObject({
  type: text(64).min(1),
  url: text(2048).optional(),
  headers: nullableArray(registryKeyValueInputSchema, 64),
  variables,
});
export type RegistryTransport = z.infer<typeof registryTransportSchema>;
export const knownTransportTypes = ["stdio", "streamable-http", "sse"] as const;
export const knownPackageRegistryTypes = [
  "npm",
  "pypi",
  "oci",
  "nuget",
  "mcpb",
  "cargo",
] as const;
export const registryPackageSchema = z.looseObject({
  registryType: text(64).min(1),
  identifier: text(2048).min(1),
  version: text(255).optional(),
  registryBaseUrl: text(2048).optional(),
  runtimeHint: text(256).optional(),
  transport: registryTransportSchema,
  runtimeArguments: nullableArray(registryArgumentSchema, 128),
  packageArguments: nullableArray(registryArgumentSchema, 128),
  environmentVariables: nullableArray(registryKeyValueInputSchema, 128),
  fileSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type RegistryPackage = z.infer<typeof registryPackageSchema>;
export const registryRepositorySchema = z.looseObject({
  url: text(2048),
  source: text(64),
  id: text(256).optional(),
  subfolder: text(1024).optional(),
});
export const registryIconSchema = z.looseObject({
  src: text(2048),
  mimeType: text(64).optional(),
  sizes: nullableArray(text(16), 32),
  theme: text(16).optional(),
});
const metaRecord = z
  .record(text(120).min(1), z.unknown())
  .refine((value) => Object.keys(value).length <= 64)
  .refine(
    (value) =>
      !["__proto__", "prototype", "constructor"].some((key) =>
        Object.hasOwn(value, key),
      ),
  );

/**
 * A `server.json` as read from a registry or an upload. Only identity fields are
 * hard requirements; everything else is bounded and preserved. Length limits
 * are wider than the official registry's publishing limits so that a lenient
 * subregistry still imports, with the excess reported as issues.
 */
export const serverJsonSchema = z.looseObject({
  $schema: text(2048).optional(),
  name: registryServerNameSchema,
  description: text(4096),
  title: text(1024).optional(),
  version: registryVersionSchema,
  websiteUrl: text(2048).optional(),
  repository: registryRepositorySchema.optional(),
  icons: nullableArray(registryIconSchema, 32),
  packages: nullableArray(registryPackageSchema, 64),
  remotes: nullableArray(registryTransportSchema, 64),
  _meta: metaRecord.optional(),
});
export type ServerJson = z.infer<typeof serverJsonSchema>;

/** Registry-managed metadata under `_meta["io.modelcontextprotocol.registry/official"]`. */
export const registryOfficialMetaSchema = z.looseObject({
  status: z.enum(["active", "deprecated", "deleted"]),
  publishedAt: isoDateTime.optional(),
  updatedAt: isoDateTime.optional(),
  statusChangedAt: isoDateTime.optional(),
  statusMessage: text(2048).optional(),
  isLatest: z.boolean().optional(),
});
export type RegistryOfficialMeta = z.infer<typeof registryOfficialMetaSchema>;
export const registryStatuses = [
  "active",
  "deprecated",
  "deleted",
  "unknown",
] as const;
export type RegistryStatus = (typeof registryStatuses)[number];

/** `ServerResponse`: the document plus registry-managed `_meta`. */
export const serverResponseSchema = z.looseObject({
  server: serverJsonSchema,
  _meta: metaRecord.optional(),
});
export type ServerResponse = z.infer<typeof serverResponseSchema>;

/** `ServerListResponse`: entries validated one by one by the client, so one poisoned entry cannot hide a page. */
export const serverListEnvelopeSchema = z.looseObject({
  servers: z.array(z.unknown()).max(1000).nullable(),
  metadata: z
    .looseObject({
      count: z.number().int().nonnegative().optional(),
      nextCursor: text(2048).nullable().optional(),
    })
    .optional(),
});

/** RFC 9457 problem details as the registry sends them; only `status` is ever used. */
export const problemDetailsSchema = z.looseObject({
  status: z.number().int().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
});

/** Names a deployment accepts as configuration; anything else is preserved but never a requirement. */
export const configurationNamePattern = /^[A-Z][A-Z0-9_]{0,95}$/;

const exportInput = z.strictObject({
  name: text(512).min(1),
  description: text(4096).optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  format: z.enum(["string", "number", "boolean", "filepath"]).optional(),
  choices: z.array(text(1024)).max(256).optional(),
  placeholder: text(2048).optional(),
});
const httpsOrLoopbackTransportUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\/[^\s]+$/);

/**
 * The exact shape this deployment is allowed to publish: `2025-12-11` fields
 * only, no packages, no values, no unknown keys. Publisher metadata is limited
 * to the documented namespaced key.
 */
export const serverJsonExportSchema = z.strictObject({
  $schema: z.literal(SERVER_JSON_SCHEMA_URL),
  name: registryServerNameSchema,
  description: text(100).min(1),
  title: text(100).min(1).optional(),
  version: registryVersionSchema.refine((value) => value.length <= 255),
  websiteUrl: httpsOrLoopbackTransportUrl.optional(),
  repository: z
    .strictObject({
      url: httpsOrLoopbackTransportUrl,
      source: text(64).min(1),
      id: text(256).optional(),
      subfolder: text(1024).optional(),
    })
    .optional(),
  remotes: z
    .array(
      z.strictObject({
        type: z.enum(["streamable-http", "sse"]),
        url: httpsOrLoopbackTransportUrl,
        headers: z.array(exportInput).max(32).optional(),
      }),
    )
    .min(1)
    .max(8),
  _meta: z
    .strictObject({
      [MCP_REGISTRY_PUBLISHER_META_KEY]: z
        .record(text(120).min(1), z.unknown())
        .refine((value) => Object.keys(value).length <= 32),
    })
    .optional(),
});
export type ServerJsonExport = z.infer<typeof serverJsonExportSchema>;

/** The schema version a document declares, or undefined when it declares none or something unknown. */
export function declaredSchemaVersion(schemaUrl: string | undefined): {
  declared: string | undefined;
  version: string | undefined;
  compatible: boolean;
} {
  if (!schemaUrl) return { declared: undefined, version: undefined, compatible: false };
  const match =
    /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/(\d{4}-\d{2}-\d{2})\/server\.schema\.json$/.exec(
      schemaUrl,
    );
  const version = match?.[1];
  return {
    declared: schemaUrl,
    version,
    compatible:
      version !== undefined &&
      (SERVER_JSON_COMPATIBLE_SCHEMA_VERSIONS as readonly string[]).includes(
        version,
      ),
  };
}
