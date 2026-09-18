import { z } from "zod";
import {
  canonicalConnectorJson,
  canonicalDigest,
  encodePathSegment,
  sourceIdentityDigest,
  type ConnectorSourceIdentity,
} from "../../../../core/connectors/identity.js";
import type { CompatibilityIssue } from "../../../../core/connectors/contracts.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import type { ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  DEFAULT_JSON_BOUNDS,
  parseBoundedJsonBytes,
  type JsonBounds,
} from "./json.js";
import {
  MCP_REGISTRY_API_VERSION,
  MCP_REGISTRY_OFFICIAL_BASE_URL,
  MCP_REGISTRY_OFFICIAL_META_KEY,
  isoDateTime,
  registryOfficialMetaSchema,
  registryRequestVersionSchema,
  registryServerNameSchema,
  serverJsonExportSchema,
  serverListEnvelopeSchema,
  serverResponseSchema,
  splitRegistryServerName,
  type RegistryOfficialMeta,
  type RegistryStatus,
  type ServerJson,
  type ServerJsonExport,
} from "./schemas.js";

/*
 * A read client for any registry that implements the MCP registry API, with
 * bounded pagination and no trust in what comes back. Names and versions are
 * validated before they are encoded exactly once into a path segment; every
 * response is size-bounded, structurally scanned, then validated entry by
 * entry so that one poisoned entry is reported and skipped rather than hiding
 * a whole page. Publishing is a separate, opt-in capability that the official
 * registry constant never enables.
 */

export type McpRegistryLimits = {
  /** Page size requested; the documented maximum is 100. */
  pageLimit: number;
  /** Pages one refresh may fetch before it has to persist progress and stop. */
  maxPagesPerRefresh: number;
  /** Bytes one response may carry. */
  maxPageBytes: number;
  /** Bytes one refresh may read across all its pages. */
  maxBytesPerRefresh: number;
  /** Canonical bytes one entry may occupy; larger entries are reported and skipped. */
  maxEntryBytes: number;
  requestTimeoutMs: number;
  json: JsonBounds;
};

export const DEFAULT_MCP_REGISTRY_LIMITS: McpRegistryLimits = Object.freeze({
  pageLimit: 100,
  maxPagesPerRefresh: 50,
  maxPageBytes: 4 * 1024 * 1024,
  maxBytesPerRefresh: 32 * 1024 * 1024,
  maxEntryBytes: 64 * 1024,
  requestTimeoutMs: 20_000,
  json: DEFAULT_JSON_BOUNDS,
});

/** A configured registry source: where to read, under which network policy, and how to authenticate privately. */
export type McpRegistrySource = {
  id: string;
  baseUrl: string;
  network: ApprovedDestination["network"];
  /** Configuration name holding a bearer token for a private source; read privately at call time. */
  authorization?: { kind: "bearer"; configurationName: string };
  /** Whether documents may be published to this source at all. */
  publication?: { allowed: boolean };
};

export const mcpRegistrySourceSchema = z.strictObject({
  id: identifierSchema,
  baseUrl: z.string().max(2048),
  network: z.enum(["public", "approved-private", "loopback-fixture"]),
  authorization: z
    .strictObject({
      kind: z.literal("bearer"),
      configurationName: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
    })
    .optional(),
  publication: z.strictObject({ allowed: z.boolean() }).optional(),
});

/** The official registry as a read-only public source. Publication stays off unless a deployment opts in explicitly. */
export const OFFICIAL_MCP_REGISTRY_SOURCE: McpRegistrySource = Object.freeze({
  id: "mcp-registry-official",
  baseUrl: MCP_REGISTRY_OFFICIAL_BASE_URL,
  network: "public",
  publication: { allowed: false },
});

/** The same source as an approved destination for a runtime binding. */
export const OFFICIAL_MCP_REGISTRY_DESTINATION: ApprovedDestination =
  Object.freeze({
    id: "mcp-registry-official",
    origin: MCP_REGISTRY_OFFICIAL_BASE_URL,
    network: "public",
  });

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

/** Origin plus optional path prefix; HTTPS, or loopback HTTP for fixtures; no userinfo, query, fragment or traversal. */
export function normalizeRegistryBaseUrl(value: string): string {
  const fail = () =>
    new ConnectorError("network-policy", { detail: "registry.base-url.invalid" });
  if (typeof value !== "string" || value.length > 2048 || !URL.canParse(value))
    throw fail();
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && loopbackHosts.includes(url.hostname))
    )
  )
    throw fail();
  const path = url.pathname.replace(/\/+$/, "");
  if (path.split("/").includes("..") || /%2f/i.test(path) || /\/\//.test(path))
    throw fail();
  return `${url.origin}${path}`;
}

/** Base URL of an approved destination: its exact origin and prefix, never a caller-supplied string. */
export function registryBaseUrlForDestination(
  destination: ApprovedDestination,
): string {
  return normalizeRegistryBaseUrl(
    `${destination.origin}${destination.pathPrefix ?? ""}`,
  );
}

export type RegistryEntry = {
  identity: ConnectorSourceIdentity;
  identityDigest: string;
  /** Digest of the canonical server.json alone; changes when the document changes. */
  serverDigest: string;
  /** Digest of the whole entry as received (document and registry metadata); the content address of a snapshot record. */
  entryDigest: string;
  server: ServerJson;
  status: RegistryStatus;
  official?: RegistryOfficialMeta;
  /** `_meta` namespaces other than the official one (subregistry extensions); inert. */
  meta: Record<string, unknown>;
};

export type RegistryPage = {
  entries: RegistryEntry[];
  nextCursor?: string;
  count?: number;
  issues: CompatibilityIssue[];
  bytes: number;
  fetchedAt: number;
};

export type RegistryListQuery = {
  cursor?: string;
  limit?: number;
  search?: string;
  updatedSince?: string;
  version?: string;
  includeDeleted?: boolean;
};

export type McpRegistryClientOptions = {
  baseUrl: string;
  fetch: typeof fetch;
  limits?: Partial<McpRegistryLimits>;
  /** Reads the bearer token privately at call time; the value never enters results, errors or logs. */
  bearer?: () => Promise<string | undefined>;
  /** Enables `publish`; off by default and never for the official constant unless a deployment says so. */
  allowPublication?: boolean;
  now?: () => number;
};

const cursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\p{Cc}]+$/u);
const searchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]+$/u);

function rejected(
  pointer: string,
  code: string,
  message: string,
): CompatibilityIssue {
  return {
    code,
    category: "structure",
    sourcePointer: pointer,
    dimension: "discover",
    disposition: "rejected",
    severity: "warning",
    executionImpact: "none",
    message,
  };
}

/**
 * Validates one raw entry. Anything wrong with it becomes an issue naming the
 * entry's position; nothing about the entry is trusted before this returns.
 */
export async function normalizeRegistryEntry(
  raw: unknown,
  pointer: string,
  limits: Pick<McpRegistryLimits, "maxEntryBytes">,
): Promise<{ entry: RegistryEntry } | { issue: CompatibilityIssue }> {
  const canonical = canonicalConnectorJson(raw);
  if (canonical === undefined || canonical.length > limits.maxEntryBytes)
    return {
      issue: rejected(
        pointer,
        "registry.entry.oversized",
        "Registry entry exceeds the entry size bound and was skipped",
      ),
    };
  const parsed = serverResponseSchema.safeParse(raw);
  if (!parsed.success)
    return {
      issue: rejected(
        pointer,
        "registry.entry.invalid",
        "Registry entry does not match the pinned response shape and was skipped",
      ),
    };
  const meta = parsed.data._meta ?? {};
  let official: RegistryOfficialMeta | undefined;
  if (Object.hasOwn(meta, MCP_REGISTRY_OFFICIAL_META_KEY)) {
    const parsedMeta = registryOfficialMetaSchema.safeParse(
      meta[MCP_REGISTRY_OFFICIAL_META_KEY],
    );
    if (!parsedMeta.success)
      return {
        issue: rejected(
          pointer,
          "registry.entry.meta-invalid",
          "Registry-managed metadata does not match the pinned shape; entry skipped",
        ),
      };
    official = parsedMeta.data;
  }
  const server = parsed.data.server;
  const { namespace } = splitRegistryServerName(server.name);
  const identity: ConnectorSourceIdentity = {
    ecosystem: "mcp-registry",
    authorityNamespace: namespace,
    nativeId: server.name,
    nativeVersion: server.version,
  };
  const others: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta))
    if (key !== MCP_REGISTRY_OFFICIAL_META_KEY) others[key] = value;
  const [identityDigest, serverDigest, entryDigest] = await Promise.all([
    sourceIdentityDigest(identity),
    canonicalDigest(server),
    canonicalDigest({ server, official: official ?? null, meta: others }),
  ]);
  return {
    entry: {
      identity,
      identityDigest,
      serverDigest,
      entryDigest,
      server,
      status: official?.status ?? "unknown",
      ...(official ? { official } : {}),
      meta: others,
    },
  };
}

function statusError(status: number, cursorPresent: boolean): ConnectorError {
  if (status === 404)
    return new ConnectorError("not-found", { detail: "registry.not-found" });
  if (status === 401 || status === 403)
    return new ConnectorError("denied", { detail: "registry.unauthorized" });
  if (status === 429) return new ConnectorError("rate-limited");
  if (status === 400 && cursorPresent)
    return new ConnectorError("upstream-rejected", {
      detail: "registry.cursor.stale",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "registry.upstream-status",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "registry.bad-request",
  });
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ConnectorError("upstream-rejected", {
      detail: "registry.response.oversized",
    });
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ConnectorError("upstream-rejected", {
        detail: "registry.response.oversized",
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type McpRegistryClient = ReturnType<typeof createMcpRegistryClient>;

export function createMcpRegistryClient(options: McpRegistryClientOptions) {
  const base = normalizeRegistryBaseUrl(options.baseUrl);
  const limits: McpRegistryLimits = {
    ...DEFAULT_MCP_REGISTRY_LIMITS,
    ...options.limits,
  };
  if (
    !Number.isInteger(limits.pageLimit) ||
    limits.pageLimit < 1 ||
    limits.pageLimit > 100
  )
    throw new ConnectorError("invalid-request", {
      detail: "registry.limit.invalid",
    });
  const now = options.now ?? Date.now;
  const prefix = `/${MCP_REGISTRY_API_VERSION}`;

  async function request(
    path: string,
    query: Record<string, string | undefined>,
    call: {
      signal?: AbortSignal;
      method?: "GET" | "POST";
      body?: unknown;
      cursorPresent?: boolean;
    },
  ): Promise<{ value: unknown; bytes: number }> {
    const url = new URL(`${base}${prefix}${path}`);
    for (const [name, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(name, value);
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "ceremony-connectors-mcp-registry/1.0.0",
    };
    if (options.bearer) {
      const token = await options.bearer();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    if (call.body !== undefined) headers["content-type"] = "application/json";
    const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
    const signal = call.signal
      ? AbortSignal.any([call.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: call.method ?? "GET",
        headers,
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (call.signal?.aborted) throw new ConnectorError("cancelled");
      if (timeout.aborted)
        throw new ConnectorError("upstream-unavailable", {
          detail: "registry.timeout",
          cause: error,
        });
      throw new ConnectorError("upstream-unavailable", {
        detail: "registry.network",
        cause: error,
      });
    }
    const bytes = await readBounded(response, limits.maxPageBytes);
    if (!response.ok) throw statusError(response.status, call.cursorPresent === true);
    return { value: parseBoundedJsonBytes(bytes, limits.json), bytes: bytes.byteLength };
  }

  async function parseListPage(
    value: unknown,
    bytes: number,
    requestCursor: string | undefined,
  ): Promise<RegistryPage> {
    const envelope = serverListEnvelopeSchema.safeParse(value);
    if (!envelope.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "registry.response.invalid",
      });
    const entries: RegistryEntry[] = [];
    const issues: CompatibilityIssue[] = [];
    const rawEntries = envelope.data.servers ?? [];
    for (const [index, raw] of rawEntries.entries()) {
      const result = await normalizeRegistryEntry(raw, `servers[${index}]`, limits);
      if ("entry" in result) entries.push(result.entry);
      else issues.push(result.issue);
    }
    let nextCursor = envelope.data.metadata?.nextCursor ?? undefined;
    if (nextCursor === "") nextCursor = undefined;
    if (nextCursor !== undefined && nextCursor === requestCursor) {
      issues.push(
        rejected(
          "metadata.nextCursor",
          "registry.cursor.loop",
          "Registry returned the same cursor it was given; pagination stopped",
        ),
      );
      nextCursor = undefined;
    }
    const count = envelope.data.metadata?.count;
    return {
      entries,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(count === undefined ? {} : { count }),
      issues,
      bytes,
      fetchedAt: now(),
    };
  }

  function validateName(name: string): string {
    const parsed = registryServerNameSchema.safeParse(name);
    if (!parsed.success)
      throw new ConnectorError("invalid-request", {
        detail: "registry.name.invalid",
      });
    return parsed.data;
  }

  return {
    baseUrl: base,
    limits,
    /** One page of `GET /v0.1/servers`, bounded and validated entry by entry. */
    async list(
      query: RegistryListQuery = {},
      call: { signal?: AbortSignal } = {},
    ): Promise<RegistryPage> {
      const limit = query.limit ?? limits.pageLimit;
      if (!Number.isInteger(limit) || limit < 1 || limit > limits.pageLimit)
        throw new ConnectorError("invalid-request", {
          detail: "registry.limit.invalid",
        });
      const cursor =
        query.cursor === undefined ? undefined : cursorSchema.safeParse(query.cursor);
      if (cursor && !cursor.success)
        throw new ConnectorError("invalid-request", {
          detail: "registry.cursor.invalid",
        });
      const search =
        query.search === undefined ? undefined : searchSchema.safeParse(query.search);
      if (search && !search.success)
        throw new ConnectorError("invalid-request", {
          detail: "registry.search.invalid",
        });
      const since =
        query.updatedSince === undefined
          ? undefined
          : isoDateTime.safeParse(query.updatedSince);
      if (since && !since.success)
        throw new ConnectorError("invalid-request", {
          detail: "registry.updated-since.invalid",
        });
      const version =
        query.version === undefined
          ? undefined
          : registryRequestVersionSchema.safeParse(query.version);
      if (version && !version.success)
        throw new ConnectorError("invalid-request", {
          detail: "registry.version.invalid",
        });
      const { value, bytes } = await request(
        "/servers",
        {
          cursor: cursor?.data,
          limit: String(limit),
          search: search?.data,
          updated_since: since?.data,
          version: version?.data,
          include_deleted:
            query.includeDeleted === undefined
              ? undefined
              : String(query.includeDeleted),
        },
        { ...(call.signal ? { signal: call.signal } : {}), cursorPresent: cursor !== undefined },
      );
      return parseListPage(value, bytes, cursor?.data);
    },
    /**
     * Follows `nextCursor` within the page and byte budgets. Incomplete results say
     * so and hand back the cursor to continue from; they never pretend to be whole.
     */
    async listAll(
      query: Omit<RegistryListQuery, "cursor"> & { cursor?: string } = {},
      call: { signal?: AbortSignal; maxPages?: number; maxBytes?: number } = {},
    ): Promise<{
      pages: RegistryPage[];
      complete: boolean;
      nextCursor?: string;
      bytes: number;
      reason?: "pages" | "bytes";
    }> {
      const maxPages = call.maxPages ?? limits.maxPagesPerRefresh;
      const maxBytes = call.maxBytes ?? limits.maxBytesPerRefresh;
      const pages: RegistryPage[] = [];
      let cursor = query.cursor;
      let bytes = 0;
      for (let index = 0; index < maxPages; index++) {
        const page = await this.list(
          { ...query, ...(cursor === undefined ? {} : { cursor }) },
          call.signal ? { signal: call.signal } : {},
        );
        pages.push(page);
        bytes += page.bytes;
        cursor = page.nextCursor;
        if (cursor === undefined) return { pages, complete: true, bytes };
        if (bytes >= maxBytes)
          return { pages, complete: false, nextCursor: cursor, bytes, reason: "bytes" };
      }
      return {
        pages,
        complete: false,
        ...(cursor === undefined ? {} : { nextCursor: cursor }),
        bytes,
        reason: "pages",
      };
    },
    /** `GET /v0.1/servers/{serverName}/versions`; the name is encoded exactly once. */
    async versions(
      name: string,
      call: { includeDeleted?: boolean; signal?: AbortSignal } = {},
    ): Promise<RegistryPage> {
      const valid = validateName(name);
      const { value, bytes } = await request(
        `/servers/${encodePathSegment(valid)}/versions`,
        {
          include_deleted:
            call.includeDeleted === undefined
              ? undefined
              : String(call.includeDeleted),
        },
        call.signal ? { signal: call.signal } : {},
      );
      const page = await parseListPage(value, bytes, undefined);
      for (const entry of page.entries)
        if (entry.identity.nativeId !== valid)
          throw new ConnectorError("upstream-rejected", {
            detail: "registry.response.mismatch",
          });
      return page;
    },
    /** `GET /v0.1/servers/{serverName}/versions/{version}`; `latest` is the documented alias. */
    async version(
      name: string,
      version: string,
      call: { includeDeleted?: boolean; signal?: AbortSignal } = {},
    ): Promise<RegistryEntry> {
      const valid = validateName(name);
      const parsedVersion = registryRequestVersionSchema.safeParse(version);
      if (!parsedVersion.success)
        throw new ConnectorError("invalid-request", {
          detail: "registry.version.invalid",
        });
      const { value } = await request(
        `/servers/${encodePathSegment(valid)}/versions/${encodePathSegment(parsedVersion.data)}`,
        {
          include_deleted:
            call.includeDeleted === undefined
              ? undefined
              : String(call.includeDeleted),
        },
        call.signal ? { signal: call.signal } : {},
      );
      const result = await normalizeRegistryEntry(value, "", limits);
      if ("issue" in result)
        throw new ConnectorError("upstream-rejected", {
          detail: "registry.response.invalid",
        });
      if (
        result.entry.identity.nativeId !== valid ||
        (parsedVersion.data !== "latest" &&
          result.entry.identity.nativeVersion !== parsedVersion.data)
      )
        throw new ConnectorError("upstream-rejected", {
          detail: "registry.response.mismatch",
        });
      return result.entry;
    },
    /**
     * `POST /v0.1/publish`. Requires the client to have been constructed with
     * publication allowed, an explicit authorization flag on the call and a
     * privately read bearer token. The document is validated against the strict
     * export shape before anything leaves.
     */
    async publish(
      document: ServerJsonExport,
      call: { authorized: boolean; signal?: AbortSignal },
    ): Promise<RegistryEntry> {
      if (options.allowPublication !== true)
        throw new ConnectorError("denied", {
          detail: "registry.publication.disabled",
        });
      if (call.authorized !== true)
        throw new ConnectorError("denied", {
          detail: "registry.publication.unauthorized",
        });
      const valid = serverJsonExportSchema.parse(document);
      if (!options.bearer || !(await options.bearer()))
        throw new ConnectorError("configuration-required", {
          detail: "registry.authorization.missing",
        });
      const { value } = await request(
        "/publish",
        {},
        {
          method: "POST",
          body: valid,
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      const result = await normalizeRegistryEntry(value, "", limits);
      if ("issue" in result)
        throw new ConnectorError("upstream-rejected", {
          detail: "registry.response.invalid",
        });
      return result.entry;
    },
  };
}
