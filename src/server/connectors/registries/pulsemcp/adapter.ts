import { z } from "zod";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CapabilityStatus,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
  type DiscoveredItem,
  type ImportInput,
  type ImportOutcome,
  type NormalizedDefinition,
} from "../../adapter.js";
import {
  pulseMcpFailure,
  pulseMcpServerListSchema,
  pulseMcpIntegrationListSchema,
  pulseMcpServerSchema,
  pulseMcpSubregistryListSchema,
  readBoundedJson,
  PULSEMCP_ADAPTER_VERSION,
  PULSEMCP_API_KEY,
  PULSEMCP_ECOSYSTEM,
  PULSEMCP_LIMITS,
  PULSEMCP_NATIVE_PROFILE,
  PULSEMCP_NATIVE_SUNSET,
  PULSEMCP_SUBREGISTRY_PROFILE,
  PULSEMCP_TENANT_ID,
} from "./api.js";
import {
  normalizePulseMcpServer,
  pulseMcpDiscoveredItem,
  pulseMcpSourceRecord,
  subregistryDiscoveredItem,
} from "./normalize.js";

/*
 * CAT-04: PulseMCP discovery over PulseMCP's own API.
 *
 * Pagination is PulseMCP's (`offset`/`count_per_page` natively, `cursor`/
 * `limit` in the sub-registry) and the adapter reports whichever it used.
 * Results are cached per principal for a bounded time; when PulseMCP is
 * unreachable the last snapshot is served with `stale: true` and
 * `source: "snapshot"` rather than an empty list that would read as "nothing
 * exists". A `/v0.1` entry wraps a `server.json`, which belongs to the MCP
 * registry importer: this adapter hands the inner document to that importer
 * when the deployment supplies it, and reports the gap when it does not.
 */

export const PULSEMCP_OPERATIONS = {
  nativeServers: "pulsemcp.servers.list",
  nativeIntegrations: "pulsemcp.integrations.list",
  subregistryServers: "pulsemcp.subregistry.list",
} as const;

export const pulseMcpSettingsSchema = z.looseObject({
  profile: z.enum(["native-v0beta", "subregistry-v0.1"]).optional(),
});

export type ServerJsonImporter = (
  document: unknown,
  provenance: { location?: string; capturedAt: string },
) => Promise<NormalizedDefinition[]>;

export type PulseMcpCacheEntry = {
  items: DiscoveredItem[];
  nextCursor?: string;
  fetchedAt: number;
};

export type PulseMcpAdapterOptions = {
  /** Bounded freshness window; capped at one hour. */
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  /** Supplied by the host to import a `/v0.1` server.json document. */
  importServerJson?: ServerJsonImporter;
};

type Profile = "native-v0beta" | "subregistry-v0.1";

function profileOf(ctx: AdapterCallContext): Profile {
  const parsed = pulseMcpSettingsSchema.safeParse(ctx.binding.settings ?? {});
  return parsed.success && parsed.data.profile
    ? parsed.data.profile
    : "native-v0beta";
}

function integerCursor(cursor: string | undefined, detail: string): number {
  if (cursor === undefined) return 0;
  if (!/^[0-9]{1,9}$/.test(cursor))
    throw new ConnectorError("invalid-request", { detail });
  return Number(cursor);
}

export function createPulseMcpAdapter(
  options: PulseMcpAdapterOptions = {},
): ConnectorAdapter {
  const ttl = Math.min(
    Math.max(options.cacheTtlMs ?? PULSEMCP_LIMITS.cacheTtlMs, 0),
    PULSEMCP_LIMITS.maxCacheTtlMs,
  );
  const maxEntries = Math.max(
    options.maxCacheEntries ?? PULSEMCP_LIMITS.cacheEntries,
    1,
  );
  // Cache keys carry the tenant and the configuration revision: a snapshot
  // taken for one principal with one set of credentials is never served to
  // another.
  const cache = new Map<string, PulseMcpCacheEntry>();

  function remember(key: string, entry: PulseMcpCacheEntry): void {
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, entry);
  }

  async function requestUrl(
    ctx: AdapterCallContext,
    operationRef: string,
  ): Promise<URL> {
    const operation = boundOperation(ctx.binding, operationRef);
    if (!operation || operation.transport.kind !== "http")
      throw new ConnectorError("configuration-required", {
        detail: "pulsemcp.operation.unbound",
      });
    if (operation.transport.method !== "GET")
      throw new ConnectorError("invalid-request", {
        detail: "pulsemcp.operation.method",
      });
    const destination = destinationFor(ctx.binding, operation);
    return destinationUrl(destination, operation.transport.pathTemplate);
  }

  /** Credentials are optional natively and required by the sub-registry. */
  async function headersFor(
    ctx: AdapterCallContext,
    profile: Profile,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = { accept: "application/json" };
    const key = await ctx.environment.configuration.read(PULSEMCP_API_KEY);
    const tenant = await ctx.environment.configuration.read(PULSEMCP_TENANT_ID);
    if (profile === "subregistry-v0.1") {
      if (!key)
        throw new ConnectorError("configuration-required", {
          detail: "pulsemcp.api-key.missing",
        });
      headers["x-api-key"] = key;
      if (tenant) headers["x-tenant-id"] = tenant;
    } else if (key) headers["x-api-key"] = key;
    return headers;
  }

  async function fetchJson(
    ctx: AdapterCallContext,
    url: URL,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const response = await ctx.environment.fetch(url, {
      method: "GET",
      redirect: "error",
      signal: ctx.signal,
      headers,
    });
    if (!response.ok) throw pulseMcpFailure(response.status);
    return readBoundedJson(response);
  }

  const adapter: ConnectorAdapter = {
    id: "pulsemcp",
    ecosystem: PULSEMCP_ECOSYSTEM,
    adapterVersion: PULSEMCP_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "PulseMCP directory",
    description:
      "Discovers MCP servers through PulseMCP's own API, with PulseMCP's pagination, provenance and freshness. Descriptions only.",
    service: "pulsemcp",
    support: "catalog-only",
    custody: ["no-credential"],
    configuration: [
      {
        name: PULSEMCP_API_KEY,
        source: "session-environment",
        classification: "secret",
        required: false,
        description:
          "Required only for PulseMCP's tenant sub-registry profile; the native list API needs no credential.",
      },
      {
        name: PULSEMCP_TENANT_ID,
        source: "host",
        classification: "public",
        required: false,
        description: "Tenant identifier for PulseMCP's sub-registry profile.",
      },
    ],
    profiles: [PULSEMCP_NATIVE_PROFILE, PULSEMCP_SUBREGISTRY_PROFILE],
    capabilities(present: ReadonlySet<string>): CapabilityStatus[] {
      const rows: CapabilityStatus[] = [
        capabilityStatus(adapter, {
          dimension: "discover",
          profile: PULSEMCP_NATIVE_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "PulseMCP pages with offset and count_per_page; it is not the official registry's cursor contract.",
            PULSEMCP_NATIVE_SUNSET,
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "import",
          profile: PULSEMCP_NATIVE_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "A native listing has no version, tools or configuration schema; the description records that rather than inventing them.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "discover",
          profile: PULSEMCP_SUBREGISTRY_PROFILE,
          configuration: present.has(PULSEMCP_API_KEY) ? "ready" : "missing",
          evidence: "protocol-fixture",
          limitations: [
            "The sub-registry requires an API key and tenant id and pages with cursor and limit.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "import",
          profile: PULSEMCP_SUBREGISTRY_PROFILE,
          configuration: present.has(PULSEMCP_API_KEY) ? "ready" : "missing",
          ...(options.importServerJson
            ? { evidence: "protocol-fixture" as const }
            : { implementation: "unsupported" as const }),
          limitations: [
            options.importServerJson
              ? "A sub-registry entry wraps a server.json document, which the MCP registry importer reads."
              : "No server.json importer is wired into this deployment, so sub-registry entries stay discoverable but cannot be imported here.",
          ],
        }),
      ];
      for (const dimension of [
        "configure",
        "authorize",
        "verify",
        "invoke",
        "events",
        "reconnect",
        "disconnect",
        "revoke",
        "export",
        "delegate",
      ] as const)
        rows.push(
          capabilityStatus(adapter, {
            dimension,
            profile: PULSEMCP_NATIVE_PROFILE,
            implementation: "unsupported",
            limitations: [
              "Catalog-only: PulseMCP is a directory. Connecting to a server it lists is a separate MCP binding.",
            ],
          }),
        );
      return rows;
    },

    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const profile = profileOf(ctx);
      const configurationRevision =
        await ctx.environment.configuration.revision();
      const key = JSON.stringify([
        ctx.actor.tenantId,
        ctx.binding.bindingRef,
        ctx.binding.revision,
        configurationRevision,
        profile,
        input.query ?? "",
        input.cursor ?? "",
        input.limit ?? 0,
        input.scope?.integration ?? "",
      ]);
      const cached = cache.get(key);
      const now = ctx.environment.now();
      if (!input.refresh && cached && now - cached.fetchedAt < ttl)
        return {
          items: cached.items,
          ...(cached.nextCursor ? { nextCursor: cached.nextCursor } : {}),
          freshness: {
            fetchedAt: cached.fetchedAt,
            stale: false,
            source: "snapshot",
          },
          issues: [],
        };
      try {
        const result =
          profile === "native-v0beta"
            ? await discoverNative(ctx, input)
            : await discoverSubregistry(ctx, input);
        remember(key, {
          items: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          fetchedAt: now,
        });
        return {
          ...result,
          freshness: { fetchedAt: now, stale: false, source: "live" },
        };
      } catch (error) {
        // An outage does not turn into "there is nothing here": the last
        // snapshot is returned, explicitly marked stale.
        if (cached)
          return {
            items: cached.items,
            ...(cached.nextCursor ? { nextCursor: cached.nextCursor } : {}),
            freshness: {
              fetchedAt: cached.fetchedAt,
              stale: true,
              source: "snapshot",
            },
            issues: [
              {
                code: "pulsemcp.refresh.failed",
                category: "network",
                sourcePointer: "",
                dimension: "discover",
                disposition: "adapted",
                severity: "warning",
                executionImpact: "none",
                message:
                  "PulseMCP could not be reached; the previous snapshot is shown and is marked stale.",
              },
            ],
          };
        throw error;
      }
    },

    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      const capturedAt = new Date(ctx.environment.now()).toISOString();
      if (input.bytes.byteLength > PULSEMCP_LIMITS.responseBytes)
        throw new ConnectorError("invalid-request", {
          detail: "pulsemcp.document.too-large",
        });
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
        );
      } catch {
        throw new ConnectorError("invalid-request", {
          detail: "pulsemcp.document.invalid",
        });
      }
      const profile = profileOf(ctx);
      if (profile === "subregistry-v0.1") {
        const importer = options.importServerJson;
        if (!importer)
          throw new ConnectorError("unsupported", {
            detail: "pulsemcp.server-json.importer-missing",
          });
        const entry = value as { server?: unknown };
        const document =
          entry && typeof entry === "object" && "server" in entry
            ? entry.server
            : value;
        const definitions = await importer(document, {
          ...(input.origin.location ? { location: input.origin.location } : {}),
          capturedAt,
        });
        const source = pulseMcpSourceRecord({
          bytes: input.bytes,
          name:
            (document as { name?: string } | undefined)?.name ??
            "unknown/server",
          origin: input.origin,
          capturedAt,
        });
        return {
          source,
          definitions,
          issues: definitions.flatMap(
            (definition) => definition.compatibility.issues,
          ),
          executableCandidates: [],
        };
      }
      const parsed = pulseMcpServerSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "pulsemcp.document.unrecognized",
        });
      const source = pulseMcpSourceRecord({
        bytes: input.bytes,
        name: parsed.data.name,
        origin: input.origin,
        capturedAt,
      });
      const definition = await normalizePulseMcpServer({
        server: parsed.data,
        sourceRef: source.sourceRef,
      });
      return {
        source,
        definitions: [definition],
        issues: definition.compatibility.issues,
        executableCandidates: [],
      };
    },
  };

  async function discoverNative(
    ctx: AdapterCallContext,
    input: DiscoverInput,
  ): Promise<Omit<DiscoverResult, "freshness">> {
    const offset = integerCursor(input.cursor, "pulsemcp.offset.invalid");
    const count = Math.min(
      Math.max(input.limit ?? PULSEMCP_LIMITS.nativeDefaultCount, 1),
      PULSEMCP_LIMITS.nativeCountPerPage,
    );
    const url = await requestUrl(ctx, PULSEMCP_OPERATIONS.nativeServers);
    url.searchParams.set("count_per_page", String(count));
    url.searchParams.set("offset", String(offset));
    if (input.query) url.searchParams.set("query", input.query);
    if (input.scope?.integration)
      url.searchParams.set("integration", input.scope.integration);
    const payload = await fetchJson(
      ctx,
      url,
      await headersFor(ctx, "native-v0beta"),
    );
    const parsed = pulseMcpServerListSchema.safeParse(payload);
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "pulsemcp.list.unrecognized",
      });
    const items = parsed.data.servers.map(pulseMcpDiscoveredItem);
    const total = parsed.data.total_count;
    // `next` is an absolute PulseMCP URL; the cursor stays a local offset so
    // no upstream-supplied URL is ever followed.
    const hasMore =
      total === undefined
        ? Boolean(parsed.data.next)
        : offset + items.length < total;
    const issues =
      total !== undefined &&
      items.length < count &&
      offset + items.length < total
        ? [
            {
              code: "pulsemcp.page.short",
              category: "structure" as const,
              sourcePointer: "/servers",
              dimension: "discover" as const,
              disposition: "adapted" as const,
              severity: "warning" as const,
              executionImpact: "none" as const,
              message:
                "PulseMCP returned fewer servers than the page size while reporting more results; the page is incomplete and paging continues from the received count.",
            },
          ]
        : [];
    return {
      items,
      ...(hasMore
        ? { nextCursor: String(offset + Math.max(items.length, 1)) }
        : {}),
      issues,
    };
  }

  async function discoverSubregistry(
    ctx: AdapterCallContext,
    input: DiscoverInput,
  ): Promise<Omit<DiscoverResult, "freshness">> {
    const url = await requestUrl(ctx, PULSEMCP_OPERATIONS.subregistryServers);
    const limit = Math.min(
      Math.max(input.limit ?? PULSEMCP_LIMITS.subregistryDefaultLimit, 1),
      PULSEMCP_LIMITS.subregistryLimit,
    );
    url.searchParams.set("limit", String(limit));
    if (input.cursor !== undefined)
      url.searchParams.set("cursor", input.cursor);
    if (input.query) url.searchParams.set("search", input.query);
    if (input.scope?.version)
      url.searchParams.set("version", input.scope.version);
    if (input.scope?.updatedSince)
      url.searchParams.set("updated_since", input.scope.updatedSince);
    const payload = await fetchJson(
      ctx,
      url,
      await headersFor(ctx, "subregistry-v0.1"),
    );
    const parsed = pulseMcpSubregistryListSchema.safeParse(payload);
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "pulsemcp.subregistry.unrecognized",
      });
    const next = parsed.data.metadata?.nextCursor;
    return {
      items: (parsed.data.servers ?? []).map(subregistryDiscoveredItem),
      ...(next ? { nextCursor: next } : {}),
      issues: [],
    };
  }

  return adapter;
}

/** PulseMCP's integration list; a grouping aid, never an authority claim. */
export async function listPulseMcpIntegrations(
  ctx: AdapterCallContext,
): Promise<Array<{ name: string; slug: string; url?: string }>> {
  const operation = boundOperation(
    ctx.binding,
    PULSEMCP_OPERATIONS.nativeIntegrations,
  );
  if (!operation || operation.transport.kind !== "http")
    throw new ConnectorError("configuration-required", {
      detail: "pulsemcp.operation.unbound",
    });
  const destination = destinationFor(ctx.binding, operation);
  const url = destinationUrl(destination, operation.transport.pathTemplate);
  const response = await ctx.environment.fetch(url, {
    method: "GET",
    redirect: "error",
    signal: ctx.signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw pulseMcpFailure(response.status);
  const parsed = pulseMcpIntegrationListSchema.safeParse(
    await readBoundedJson(response),
  );
  if (!parsed.success)
    throw new ConnectorError("upstream-rejected", {
      detail: "pulsemcp.integrations.unrecognized",
    });
  return parsed.data.integrations.map((integration) => ({
    name: integration.name,
    slug: integration.slug,
    ...(integration.url ? { url: integration.url } : {}),
  }));
}
