import { z } from "zod";
import {
  measureJsonValue,
  type JsonValueLimits,
} from "../../../../core/connectors/json-bounds.js";
import { ConnectorError } from "../../errors.js";
import { readBoundedBytes } from "../bounded-read.js";

/*
 * Pinned wire shapes of PulseMCP's own APIs, from PulseMCP's published
 * documentation (retrieved 2026-09-18):
 *
 *   https://www.pulsemcp.com/api
 *   https://www.pulsemcp.com/api/docs/v0beta
 *   https://www.pulsemcp.com/api/docs/v0.1
 *   https://api.pulsemcp.com/api/openapi_v01.yaml  (PulseMCP Sub-Registry API 0.1.9)
 *
 * PulseMCP serves two different contracts and this module keeps them apart.
 *
 *  - `/v0beta` is PulseMCP's native list API: no authentication, `query`,
 *    `count_per_page` (max 5000) and `offset`, answering `servers`,
 *    `total_count` and an absolute `next` link. It is documented as deprecated
 *    with a sunset in September 2026, which is a fact about the source, not a
 *    reason to guess at a replacement shape.
 *  - `/v0.1` is a tenant-scoped sub-registry that implements the generic MCP
 *    registry specification: `X-API-Key` and `X-Tenant-ID` headers, `cursor`
 *    and `limit`, and servers wrapped as `{ server, _meta }` where `server` is
 *    a `server.json` document. The official-registry document shape belongs to
 *    the MCP registry importer, not here: this module reads the envelope and
 *    the PulseMCP `_meta` extensions, and hands the inner document to that
 *    importer when the deployment supplies it.
 *
 * Neither profile is assumed to be the other. That is AC-EXT-09.
 */

export const PULSEMCP_ECOSYSTEM = "pulsemcp" as const;
export const PULSEMCP_API_BASE_URL = "https://api.pulsemcp.com";
export const PULSEMCP_NATIVE_PROFILE = "pulsemcp-v0beta";
export const PULSEMCP_SUBREGISTRY_PROFILE = "pulsemcp-subregistry-v0.1";
export const PULSEMCP_SUBREGISTRY_SPEC_VERSION = "0.1.9";
export const PULSEMCP_IMPORTER_ID = "pulsemcp-native";
export const PULSEMCP_IMPORTER_VERSION = "1.0.0";
export const PULSEMCP_ADAPTER_VERSION = "1.0.0";
export const PULSEMCP_API_KEY = "PULSEMCP_API_KEY";
export const PULSEMCP_TENANT_ID = "PULSEMCP_TENANT_ID";

/** Documented bounds: v0beta `count_per_page` max 5000; v0.1 `limit` 1..100 (default 30). */
export const PULSEMCP_LIMITS = Object.freeze({
  nativeCountPerPage: 5000,
  nativeDefaultCount: 100,
  subregistryLimit: 100,
  subregistryDefaultLimit: 30,
  responseBytes: 8 * 1024 * 1024,
  cacheEntries: 64,
  cacheTtlMs: 5 * 60 * 1000,
  maxCacheTtlMs: 60 * 60 * 1000,
});

/** The documented deprecation of the native list API; reported, never hidden. */
export const PULSEMCP_NATIVE_SUNSET =
  "PulseMCP documents the /v0beta API as deprecated with a sunset by September 2026; pin the profile and revisit before then.";

const jsonLimits: JsonValueLimits = {
  depth: 24,
  nodes: 200_000,
  bytes: PULSEMCP_LIMITS.responseBytes,
  stringLength: 64 * 1024,
};

export async function readBoundedJson(
  response: Response,
  limits: JsonValueLimits = jsonLimits,
): Promise<unknown> {
  // Both PulseMCP profiles answer chunked, so the bound has to hold while the
  // body streams; the shared reader stops at `limits.bytes` and cancels.
  const bytes = await readBoundedBytes(
    response,
    limits.bytes,
    "pulsemcp.response.too-large",
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ConnectorError("upstream-rejected", {
      detail: "pulsemcp.response.invalid-json",
    });
  }
  const measured = measureJsonValue(value, limits);
  if (!measured.ok)
    throw new ConnectorError("upstream-rejected", {
      detail:
        measured.reason === "reserved-key"
          ? "pulsemcp.response.reserved-key"
          : "pulsemcp.response.unbounded",
    });
  return value;
}

/** Documented status codes of both PulseMCP profiles, sanitized. */
export function pulseMcpFailure(status: number): ConnectorError {
  if (status === 400)
    return new ConnectorError("invalid-request", {
      detail: "pulsemcp.request.invalid",
    });
  if (status === 401)
    return new ConnectorError("unauthenticated", {
      detail: "pulsemcp.key.rejected",
    });
  if (status === 403)
    return new ConnectorError("denied", { detail: "pulsemcp.tenant.denied" });
  if (status === 404)
    return new ConnectorError("not-found", { detail: "pulsemcp.not-found" });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "pulsemcp.rate.limit",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "pulsemcp.upstream.unavailable",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "pulsemcp.request.rejected",
  });
}

export const pulseMcpRemoteSchema = z.looseObject({
  url_direct: z.string().max(2048).nullish(),
  url_setup: z.string().max(2048).nullish(),
  transport: z.string().max(64).nullish(),
  authentication_method: z.string().max(64).nullish(),
  cost: z.string().max(64).nullish(),
});

export const pulseMcpIntegrationSchema = z.looseObject({
  name: z.string().max(200),
  slug: z.string().max(200),
  url: z.string().max(2048).nullish(),
  server_count: z.number().nullish(),
});

export const pulseMcpServerSchema = z.looseObject({
  name: z.string().min(1).max(200),
  url: z.string().max(2048).nullish(),
  external_url: z.string().max(2048).nullish(),
  short_description: z.string().max(4096).nullish(),
  source_code_url: z.string().max(2048).nullish(),
  github_stars: z.number().nullish(),
  package_registry: z.string().max(64).nullish(),
  package_name: z.string().max(256).nullish(),
  package_download_count: z.number().nullish(),
  EXPERIMENTAL_ai_generated_description: z.string().max(8192).nullish(),
  remotes: z.array(pulseMcpRemoteSchema).max(32).nullish(),
  integrations: z.array(pulseMcpIntegrationSchema).max(64).nullish(),
});
export type PulseMcpServer = z.infer<typeof pulseMcpServerSchema>;

export const pulseMcpServerListSchema = z.looseObject({
  servers: z.array(pulseMcpServerSchema).max(5000),
  total_count: z.number().int().nonnegative().optional(),
  next: z.string().max(2048).nullish(),
});

export const pulseMcpIntegrationListSchema = z.looseObject({
  integrations: z.array(pulseMcpIntegrationSchema).max(5000),
  total_count: z.number().int().nonnegative().optional(),
  next: z.string().max(2048).nullish(),
});

export const PULSEMCP_SERVER_META = "com.pulsemcp/server";
export const PULSEMCP_VERSION_META = "com.pulsemcp/server-version";

export const pulseMcpSubregistryEntrySchema = z.looseObject({
  /** The inner document is a server.json; this module does not reinterpret it. */
  server: z.looseObject({
    name: z.string().min(1).max(200),
    description: z.string().max(4096).optional(),
    version: z.string().max(255).optional(),
    title: z.string().max(200).nullish(),
    websiteUrl: z.string().max(2048).nullish(),
    repository: z
      .looseObject({ url: z.string().max(2048).optional() })
      .nullish(),
  }),
  _meta: z
    .looseObject({
      [PULSEMCP_SERVER_META]: z
        .looseObject({
          isOfficial: z.boolean().optional(),
          visitorsEstimateMostRecentWeek: z.number().nullish(),
          visitorsEstimateLastFourWeeks: z.number().nullish(),
          visitorsEstimateTotal: z.number().nullish(),
        })
        .optional(),
      [PULSEMCP_VERSION_META]: z
        .looseObject({
          source: z.string().max(200).optional(),
          status: z.string().max(32).optional(),
          isLatest: z.boolean().optional(),
          publishedAt: z.string().max(64).optional(),
          updatedAt: z.string().max(64).optional(),
          statusChangedAt: z.string().max(64).optional(),
          statusMessage: z.string().max(500).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type PulseMcpSubregistryEntry = z.infer<
  typeof pulseMcpSubregistryEntrySchema
>;

export const pulseMcpSubregistryListSchema = z.looseObject({
  servers: z.array(pulseMcpSubregistryEntrySchema).max(100).nullable(),
  metadata: z
    .looseObject({
      count: z.number().int().nonnegative().optional(),
      nextCursor: z.string().max(2048).optional(),
    })
    .optional(),
});
