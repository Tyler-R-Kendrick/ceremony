import { startHttpFixture } from "./http-fixture.js";

/*
 * An independent double of PulseMCP's own REST API, written from PulseMCP's
 * published documentation (retrieved 2026-09-18):
 *
 *   https://www.pulsemcp.com/api
 *   https://www.pulsemcp.com/api/docs/v0beta   (native list API, no auth)
 *   https://www.pulsemcp.com/api/docs/v0.1     (tenant sub-registry API)
 *   https://api.pulsemcp.com/api/openapi_v01.yaml
 *
 * Two shapes are served on purpose, because PulseMCP serves two and they do
 * not agree: the native `/v0beta` list (`query`, `count_per_page`, `offset`,
 * `total_count`, `next`) and the `/v0.1` sub-registry (`X-API-Key`,
 * `X-Tenant-ID`, `cursor`, `limit`, `metadata.nextCursor`, servers wrapped as
 * `{ server, _meta }`). A client that assumes the official MCP registry's
 * pagination against `/v0beta` fails here, which is the point.
 */

export type PulseMcpRemoteSeed = {
  url_direct?: string | null;
  url_setup?: string | null;
  transport?: string;
  authentication_method?: string | null;
  cost?: string | null;
};

export type PulseMcpServerSeed = {
  name: string;
  url?: string;
  external_url?: string | null;
  short_description?: string | null;
  source_code_url?: string | null;
  github_stars?: number | null;
  package_registry?: string | null;
  package_name?: string | null;
  package_download_count?: number | null;
  EXPERIMENTAL_ai_generated_description?: string | null;
  remotes?: PulseMcpRemoteSeed[];
  integrations?: Array<{ name: string; slug: string; url?: string }>;
};

export type PulseMcpIntegrationSeed = {
  name: string;
  slug: string;
  url?: string;
  server_count?: number;
};

/** A `/v0.1` entry: a generic-registry server document plus PulseMCP metadata. */
export type PulseMcpSubregistrySeed = {
  server: Record<string, unknown>;
  meta?: {
    isOfficial?: boolean;
    visitorsEstimateLastFourWeeks?: number;
    source?: "registry.modelcontextprotocol.io" | "pulsemcp.com";
    status?: "active" | "deprecated" | "deleted";
    isLatest?: boolean;
    publishedAt?: string;
    updatedAt?: string;
    statusMessage?: string;
  };
};

export type PulseMcpDoubleOptions = {
  servers?: PulseMcpServerSeed[];
  integrations?: PulseMcpIntegrationSeed[];
  subregistry?: PulseMcpSubregistrySeed[];
  /** Credentials the `/v0.1` API requires; `/v0beta` requires none. */
  apiKey?: string;
  tenantId?: string;
  /** Documented default and maximum of `count_per_page`. */
  maxCountPerPage?: number;
  rateLimit?: { limitMinute?: number; remainingMinute?: number };
};

export async function startPulseMcpDouble(options: PulseMcpDoubleOptions = {}) {
  const servers = [...(options.servers ?? [])];
  const integrations = [...(options.integrations ?? [])];
  const subregistry = [...(options.subregistry ?? [])];
  const maxCountPerPage = options.maxCountPerPage ?? 5000;
  /** Flipped by a test to model an outage or a partial page. */
  const control = {
    failWith: undefined as number | undefined,
    truncateAfter: undefined as number | undefined,
    malformed: false,
  };

  const fixture = await startHttpFixture((request) => {
    const path = request.url.pathname;
    const query = request.url.searchParams;
    const rateHeaders = {
      "x-ratelimit-limit-minute": String(options.rateLimit?.limitMinute ?? 200),
      "x-ratelimit-remaining-minute": String(
        options.rateLimit?.remainingMinute ?? 199,
      ),
    };
    if (control.failWith)
      return {
        status: control.failWith,
        headers: rateHeaders,
        body: { error: "upstream failure", code: "internal_error" },
      };

    if (path === "/v0beta/servers" && request.method === "GET") {
      // The native API is documented as requiring no authentication.
      const search = query.get("query")?.toLowerCase();
      const countRaw = query.get("count_per_page");
      const count = countRaw === null ? maxCountPerPage : Number(countRaw);
      if (!Number.isInteger(count) || count < 1 || count > maxCountPerPage)
        return {
          status: 400,
          headers: rateHeaders,
          body: { error: "count_per_page out of range" },
        };
      const offsetRaw = query.get("offset");
      const offset = offsetRaw === null ? 0 : Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0)
        return {
          status: 400,
          headers: rateHeaders,
          body: { error: "offset out of range" },
        };
      const integrationSlug = query.get("integration");
      const filtered = servers.filter(
        (server) =>
          (!search ||
            server.name.toLowerCase().includes(search) ||
            (server.short_description ?? "").toLowerCase().includes(search)) &&
          (!integrationSlug ||
            (server.integrations ?? []).some(
              (item) => item.slug === integrationSlug,
            )),
      );
      const page = filtered.slice(offset, offset + count);
      const truncated =
        control.truncateAfter === undefined
          ? page
          : page.slice(0, control.truncateAfter);
      const nextOffset = offset + count;
      const next =
        nextOffset < filtered.length
          ? `${fixture.origin}/v0beta/servers?count_per_page=${count}&offset=${nextOffset}${
              search ? `&query=${encodeURIComponent(search)}` : ""
            }`
          : null;
      return {
        headers: rateHeaders,
        body: control.malformed
          ? { servers: "not-a-list", total_count: filtered.length }
          : {
              servers: truncated.map((server) => ({
                name: server.name,
                url:
                  server.url ??
                  `https://www.pulsemcp.com/servers/${server.name}`,
                external_url: server.external_url ?? null,
                short_description: server.short_description ?? null,
                source_code_url: server.source_code_url ?? null,
                github_stars: server.github_stars ?? null,
                package_registry: server.package_registry ?? null,
                package_name: server.package_name ?? null,
                package_download_count: server.package_download_count ?? null,
                EXPERIMENTAL_ai_generated_description:
                  server.EXPERIMENTAL_ai_generated_description ?? null,
                ...(server.remotes ? { remotes: server.remotes } : {}),
                ...(server.integrations
                  ? { integrations: server.integrations }
                  : {}),
              })),
              total_count: filtered.length,
              next,
            },
      };
    }

    if (path === "/v0beta/integrations" && request.method === "GET") {
      return {
        headers: rateHeaders,
        body: {
          integrations: integrations.map((integration) => ({
            name: integration.name,
            slug: integration.slug,
            url:
              integration.url ??
              `https://www.pulsemcp.com/integrations/${integration.slug}`,
            ...(integration.server_count === undefined
              ? {}
              : { server_count: integration.server_count }),
          })),
          total_count: integrations.length,
          next: null,
        },
      };
    }

    if (path === "/v0.1/servers" && request.method === "GET") {
      const key = request.headers["x-api-key"];
      const tenant = request.headers["x-tenant-id"];
      if (!key || (options.apiKey && key !== options.apiKey))
        return {
          status: 401,
          headers: rateHeaders,
          body: { error: "Invalid or missing API key", code: "unauthorized" },
        };
      if (options.tenantId && tenant !== options.tenantId)
        return {
          status: 403,
          headers: rateHeaders,
          body: { error: "Tenant access denied", code: "forbidden" },
        };
      const limitRaw = query.get("limit");
      const limit = limitRaw === null ? 30 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return {
          status: 400,
          headers: rateHeaders,
          body: {
            error: "limit must be between 1 and 100",
            code: "invalid_limit",
          },
        };
      const cursorRaw = query.get("cursor");
      if (cursorRaw !== null && !/^[0-9]+$/.test(cursorRaw))
        return {
          status: 400,
          headers: rateHeaders,
          body: {
            error: "cursor must be a valid base64-encoded pagination token",
            code: "invalid_cursor",
          },
        };
      const cursor = cursorRaw === null ? 0 : Number(cursorRaw);
      const search = query.get("search")?.toLowerCase();
      const filtered = subregistry.filter(
        (entry) =>
          !search ||
          String(entry.server.name ?? "")
            .toLowerCase()
            .includes(search),
      );
      const page = filtered.slice(cursor, cursor + limit);
      const nextCursor =
        cursor + limit < filtered.length ? String(cursor + limit) : undefined;
      return {
        headers: rateHeaders,
        body: {
          servers: page.map((entry) => ({
            server: entry.server,
            _meta: {
              "com.pulsemcp/server": {
                isOfficial: entry.meta?.isOfficial ?? false,
                ...(entry.meta?.visitorsEstimateLastFourWeeks === undefined
                  ? {}
                  : {
                      visitorsEstimateLastFourWeeks:
                        entry.meta.visitorsEstimateLastFourWeeks,
                    }),
              },
              "com.pulsemcp/server-version": {
                source: entry.meta?.source ?? "pulsemcp.com",
                status: entry.meta?.status ?? "active",
                isLatest: entry.meta?.isLatest ?? true,
                ...(entry.meta?.publishedAt
                  ? { publishedAt: entry.meta.publishedAt }
                  : {}),
                ...(entry.meta?.updatedAt
                  ? { updatedAt: entry.meta.updatedAt }
                  : {}),
                ...(entry.meta?.statusMessage
                  ? { statusMessage: entry.meta.statusMessage }
                  : {}),
              },
            },
          })),
          metadata: {
            count: page.length,
            ...(nextCursor ? { nextCursor } : {}),
          },
        },
      };
    }

    if (path === "/v0.1/health")
      return { headers: rateHeaders, body: { status: "healthy" } };

    return {
      status: 404,
      headers: rateHeaders,
      body: { error: "Not found", code: "not_found" },
    };
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    received: fixture.received.bind(fixture),
    close: fixture.close.bind(fixture),
    /** Test controls; the product never reaches these. */
    control,
    state: { servers, integrations, subregistry },
  };
}

export type PulseMcpDouble = Awaited<ReturnType<typeof startPulseMcpDouble>>;
