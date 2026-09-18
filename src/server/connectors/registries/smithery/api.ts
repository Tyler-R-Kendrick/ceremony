import { z } from "zod";
import {
  measureJsonValue,
  type JsonValueLimits,
} from "../../../../core/connectors/json-bounds.js";
import { encodePathSegment } from "../../../../core/connectors/identity.js";
import { ConnectorError } from "../../errors.js";

/*
 * Pinned wire shapes of the Smithery Platform API, from Smithery's published
 * API reference (retrieved 2026-09-18):
 *
 *   https://smithery.ai/docs/api-reference/servers/list-all-servers
 *   https://smithery.ai/docs/api-reference/servers/get-a-server
 *   https://smithery.ai/docs/api-reference/connect/list-connections
 *   https://smithery.ai/docs/api-reference/connect/create-or-update-connection
 *   https://smithery.ai/docs/api-reference/connect/get-connection
 *   https://smithery.ai/docs/api-reference/connect/delete-connection
 *   https://smithery.ai/docs/api-reference/tokens/create-a-service-token
 *   https://smithery.ai/docs/use/connect , https://smithery.ai/docs/use/token-scoping
 *
 * Responses are read with loose objects: a field Smithery adds later travels
 * as inert data instead of failing the read or being silently trusted. The
 * Smithery registry is its own catalog, not the official MCP registry: nothing
 * here claims `server.json` compatibility, and no field is renamed to look
 * like it.
 */

export const SMITHERY_API_BASE_URL = "https://api.smithery.ai";
/** The namespace MCP endpoint; tools are prefixed `{connectionId}.{toolName}`. */
export const SMITHERY_MCP_BASE_URL = "https://mcp.smithery.run";
export const SMITHERY_REGISTRY_PROFILE = "smithery-registry-2026-09";
export const SMITHERY_CONNECT_PROFILE = "smithery-connect-2026-09";
export const SMITHERY_IMPORTER_ID = "smithery-registry";
export const SMITHERY_IMPORTER_VERSION = "1.0.0";
export const SMITHERY_ADAPTER_VERSION = "1.0.0";
export const SMITHERY_API_KEY = "SMITHERY_API_KEY";
export const SMITHERY_ECOSYSTEM = "smithery" as const;

/** Documented list bounds: pageSize 1..100 (default 10); connection limit 1..100. */
export const SMITHERY_LIMITS = Object.freeze({
  serverPageSize: 100,
  connectionLimit: 100,
  responseBytes: 4 * 1024 * 1024,
  tokenTtlSeconds: 3600,
});

const jsonLimits: JsonValueLimits = {
  depth: 24,
  nodes: 100_000,
  bytes: 4 * 1024 * 1024,
  stringLength: 64 * 1024,
};

/** Reads a bounded JSON body, refusing reserved keys and hostile nesting. */
export async function readBoundedJson(
  response: Response,
  limits: JsonValueLimits = jsonLimits,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limits.bytes)
    throw new ConnectorError("upstream-rejected", {
      detail: "smithery.response.too-large",
    });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limits.bytes)
    throw new ConnectorError("upstream-rejected", {
      detail: "smithery.response.too-large",
    });
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    );
  } catch {
    throw new ConnectorError("upstream-rejected", {
      detail: "smithery.response.invalid-json",
    });
  }
  const measured = measureJsonValue(value, limits);
  if (!measured.ok)
    throw new ConnectorError("upstream-rejected", {
      detail:
        measured.reason === "reserved-key"
          ? "smithery.response.reserved-key"
          : "smithery.response.unbounded",
    });
  return value;
}

/** Maps a documented Smithery status code to a sanitized connector failure. */
export function smitheryFailure(status: number): ConnectorError {
  if (status === 401)
    return new ConnectorError("unauthenticated", {
      detail: "smithery.key.rejected",
    });
  if (status === 403)
    return new ConnectorError("denied", { detail: "smithery.token.scope" });
  if (status === 404)
    // Smithery answers "not found or access denied" identically; a caller
    // learns nothing about namespaces it cannot see, and neither do we.
    return new ConnectorError("not-found", {
      detail: "smithery.namespace.not-found",
    });
  if (status === 409)
    return new ConnectorError("conflict", { detail: "smithery.url.mismatch" });
  if (status === 422)
    return new ConnectorError("upstream-rejected", {
      detail: "smithery.tool.failed",
    });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "smithery.rate.limit",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "smithery.upstream.unavailable",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "smithery.request.rejected",
  });
}

export const smitheryPaginationSchema = z.looseObject({
  currentPage: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});

export const smitheryServerListItemSchema = z.looseObject({
  qualifiedName: z.string().min(1).max(512),
  displayName: z.string().max(500).optional(),
  description: z.string().max(4096).optional(),
  namespace: z.string().max(256).nullish(),
  slug: z.string().max(256).nullish(),
  id: z.string().max(256).optional(),
  iconUrl: z.string().max(2048).nullish(),
  verified: z.boolean().optional(),
  useCount: z.number().optional(),
  remote: z.boolean().nullish(),
  isDeployed: z.boolean().optional(),
  createdAt: z.string().max(64).optional(),
  homepage: z.string().max(2048).optional(),
  bySmithery: z.boolean().optional(),
  owner: z.string().max(256).nullish(),
});
export type SmitheryServerListItem = z.infer<
  typeof smitheryServerListItemSchema
>;

export const smitheryServerListSchema = z.looseObject({
  servers: z.array(smitheryServerListItemSchema).max(500),
  pagination: smitheryPaginationSchema.optional(),
});

export const smitheryConnectionDescriptorSchema = z.looseObject({
  type: z.string().max(64).optional(),
  deploymentUrl: z.string().max(2048).nullish(),
  bundleUrl: z.string().max(2048).nullish(),
  runtime: z.string().max(64).nullish(),
  configSchema: z.unknown().optional(),
});

export const smitheryToolSchema = z.looseObject({
  name: z.string().min(1).max(256),
  title: z.string().max(500).nullish(),
  description: z.string().max(4096).nullish(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  annotations: z.unknown().optional(),
});

export const smitheryServerDetailSchema = z.looseObject({
  qualifiedName: z.string().min(1).max(512),
  displayName: z.string().max(500).optional(),
  description: z.string().max(4096).optional(),
  iconUrl: z.string().max(2048).nullish(),
  remote: z.boolean().nullish(),
  deploymentUrl: z.string().max(2048).nullish(),
  connections: z.array(smitheryConnectionDescriptorSchema).max(32).optional(),
  security: z.looseObject({ scanPassed: z.boolean().nullish() }).optional(),
  tools: z.array(smitheryToolSchema).max(1024).optional(),
  resources: z
    .array(z.looseObject({ name: z.string().max(256) }))
    .max(512)
    .optional(),
  prompts: z
    .array(z.looseObject({ name: z.string().max(256) }))
    .max(512)
    .optional(),
});
export type SmitheryServerDetail = z.infer<typeof smitheryServerDetailSchema>;

export const smitheryConnectionStatusSchema = z.union([
  z.looseObject({ state: z.literal("connected") }),
  z.looseObject({ state: z.literal("disconnected") }),
  z.looseObject({
    state: z.literal("auth_required"),
    setupUrl: z.string().max(2048).optional(),
    authorizationUrl: z.string().max(2048).optional(),
  }),
  z.looseObject({
    state: z.literal("input_required"),
    setupUrl: z.string().max(2048).optional(),
    http: z
      .looseObject({
        headers: z.record(z.string().max(256), z.unknown()).optional(),
        query: z.record(z.string().max(256), z.unknown()).optional(),
      })
      .optional(),
    missing: z
      .looseObject({
        headers: z.array(z.string().max(256)).max(64).optional(),
        query: z.array(z.string().max(256)).max(64).optional(),
      })
      .optional(),
  }),
  z.looseObject({
    state: z.literal("error"),
    message: z.string().max(4096).optional(),
  }),
]);
export type SmitheryConnectionStatus = z.infer<
  typeof smitheryConnectionStatusSchema
>;

export const smitheryConnectionSchema = z.looseObject({
  connectionId: z.string().min(1).max(256),
  name: z.string().max(256).nullish(),
  transport: z.string().max(32).optional(),
  mcpUrl: z.string().max(2048).nullish(),
  metadata: z.record(z.string().max(128), z.unknown()).nullish(),
  iconUrl: z.string().max(2048).nullish(),
  createdAt: z.string().max(64).optional(),
  status: smitheryConnectionStatusSchema,
  serverInfo: z
    .looseObject({
      name: z.string().max(256).optional(),
      title: z.string().max(256).nullish(),
      version: z.string().max(128).optional(),
      websiteUrl: z.string().max(2048).nullish(),
      description: z.string().max(4096).nullish(),
    })
    .optional(),
});
export type SmitheryConnection = z.infer<typeof smitheryConnectionSchema>;

export const smitheryConnectionListSchema = z.looseObject({
  connections: z.array(smitheryConnectionSchema).max(200),
  nextCursor: z.string().max(512).nullish(),
});

export const smitheryTokenSchema = z.looseObject({
  token: z.string().min(1).max(4096),
  expiresAt: z.string().max(64).optional(),
});

/** Namespaces and connection ids are path segments; upstream spelling is preserved. */
export const smitheryNamespacePattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
export const smitheryConnectionIdPattern =
  /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
/** Documented qualified-name pattern of the upsert request body. */
export const smitheryQualifiedNamePattern =
  /^@?[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)?$/;

export function assertNamespace(value: string): string {
  if (!smitheryNamespacePattern.test(value))
    throw new ConnectorError("invalid-request", {
      detail: "smithery.namespace.invalid",
    });
  return value;
}

export function assertConnectionId(value: string): string {
  if (!smitheryConnectionIdPattern.test(value))
    throw new ConnectorError("invalid-request", {
      detail: "smithery.connection.invalid",
    });
  return value;
}

/** One-shot percent-encoding for a path segment that may contain `/` or `@`. */
export function segment(value: string): string {
  return encodePathSegment(value);
}

/**
 * Builds a request URL inside an approved destination from a base path and
 * pre-encoded path segments.
 *
 * `destinationUrl` refuses any `%2F`, because an encoded slash inside a path
 * *template* is how a caller smuggles an extra segment. Smithery's documented
 * detail endpoint is the opposite case: the qualified name is one segment that
 * legitimately contains a slash, and Smithery documents encoding it as `%2F`.
 * So the segments are encoded here, exactly once, by the caller, and this
 * helper repeats every other check `destinationUrl` performs: the base path is
 * absolute and free of encoded slashes, each segment is a single segment, the
 * result stays on the destination's origin, and no `..` survives decoding.
 */
export function smitheryUrl(
  destination: { origin: string; pathPrefix?: string | undefined },
  basePath: string,
  segments: readonly string[] = [],
): URL {
  if (
    !basePath.startsWith("/") ||
    basePath.startsWith("//") ||
    /%2f/i.test(basePath)
  )
    throw new ConnectorError("invalid-request", {
      detail: "smithery.path.invalid",
    });
  for (const part of segments)
    if (
      !part ||
      part.length > 512 ||
      /[/?#]/.test(part) ||
      decodeURIComponent(part).split("/").includes("..")
    )
      throw new ConnectorError("invalid-request", {
        detail: "smithery.segment.invalid",
      });
  const path = segments.length
    ? `${basePath.replace(/\/$/, "")}/${segments.join("/")}`
    : basePath;
  const url = new URL(path, destination.origin);
  if (url.origin !== destination.origin)
    throw new ConnectorError("network-policy", {
      detail: "smithery.destination.escaped",
    });
  const prefix = destination.pathPrefix ?? "/";
  if (
    prefix !== "/" &&
    !(
      url.pathname === prefix ||
      url.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
    )
  )
    throw new ConnectorError("network-policy", {
      detail: "smithery.destination.prefix",
    });
  if (decodeURIComponent(url.pathname).split("/").includes(".."))
    throw new ConnectorError("invalid-request", {
      detail: "smithery.path.traversal",
    });
  return url;
}
