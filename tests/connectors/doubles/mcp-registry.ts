import { startHttpFixture, type FixtureReply } from "./http-fixture.js";

/*
 * A loopback double of an MCP registry, written from the documented API and
 * not from the client under test:
 *
 * - https://modelcontextprotocol.io/registry/registry-aggregators
 *   `GET /v0.1/servers` with `limit` (max 100) and `cursor`; `nextCursor` in
 *   `metadata`; `updated_since` (RFC 3339); path parameters URL-encoded once
 *   (`io.modelcontextprotocol%2Feverything`); status may move to `deprecated`
 *   or `deleted`.
 * - https://registry.modelcontextprotocol.io/openapi.yaml (Official MCP
 *   Registry 1.0.0): `search`, `version`, `include_deleted` (forced on with
 *   `updated_since`), `GET /v0.1/servers/{serverName}/versions`,
 *   `GET /v0.1/servers/{serverName}/versions/{version}` with the `latest`
 *   alias, `POST /v0.1/publish` with a bearer registry token, problem+json
 *   errors, and `_meta["io.modelcontextprotocol.registry/official"]` carrying
 *   `status`, `publishedAt`, `updatedAt`, `statusChangedAt`, `isLatest`.
 *
 * Cursors follow the official registry's observable shape `name:version`.
 * Faults (outages, stale cursors, poisoned entries, oversized or malformed
 * bodies, a looping cursor) are injected through the returned handle.
 */

export const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

export type DoubleOfficialMeta = {
  status: "active" | "deprecated" | "deleted";
  publishedAt: string;
  updatedAt: string;
  statusChangedAt: string;
  isLatest: boolean;
  statusMessage?: string;
};

export type DoubleEntry = {
  server: Record<string, unknown> & { name: string; version: string };
  _meta: Record<string, unknown> & { [OFFICIAL_META]: DoubleOfficialMeta };
};

export type RegistryDoubleFaults = {
  /** Fail the Nth list request (1-based). */
  failListRequest?:
    | { at: number; status?: number; disconnect?: boolean; repeat?: boolean }
    | undefined;
  /** Cursor values rejected with 400 as the registry does for unknown cursors. */
  staleCursors?: Set<string> | undefined;
  /** Answer the next list request with `nextCursor` equal to the request cursor. */
  loopOnce?: boolean | undefined;
  /** Serve a body larger than any sane page. */
  oversizedList?: boolean | undefined;
  /** Serve syntactically broken JSON. */
  malformedList?: boolean | undefined;
};

export type McpRegistryDoubleOptions = {
  entries?: DoubleEntry[];
  /** Raw values spliced into list results after the given entry index; never validated by the double. */
  poisoned?: Array<{ afterIndex: number; raw: unknown }>;
  /** When set, every read requires this bearer token (a private registry). */
  readToken?: string;
  /** Registry tokens accepted by `POST /v0.1/publish`. */
  publishTokens?: string[];
  faults?: RegistryDoubleFaults;
  now?: () => number;
};

const namePattern = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

function problem(status: number, title: string, detail: string): FixtureReply {
  return {
    status,
    headers: { "content-type": "application/problem+json" },
    body: { type: "about:blank", title, status, detail },
  };
}

/** Builds an entry the way the registry would after `publish`. */
export function registryEntry(
  server: Record<string, unknown> & { name: string; version: string },
  official: Partial<DoubleOfficialMeta> = {},
  extraMeta: Record<string, unknown> = {},
): DoubleEntry {
  const at = official.publishedAt ?? "2026-01-01T00:00:00Z";
  return {
    server,
    _meta: {
      ...extraMeta,
      [OFFICIAL_META]: {
        status: "active",
        publishedAt: at,
        updatedAt: at,
        statusChangedAt: at,
        isLatest: true,
        ...official,
      },
    },
  };
}

export async function startMcpRegistryDouble(options: McpRegistryDoubleOptions = {}) {
  const entries: DoubleEntry[] = structuredClone(options.entries ?? []);
  const poisoned = [...(options.poisoned ?? [])];
  const faults: RegistryDoubleFaults = { ...options.faults };
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  let listRequests = 0;
  const key = (entry: DoubleEntry) => `${entry.server.name}:${entry.server.version}`;

  const authorized = (header: string | undefined, tokens: string[]) => {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    return match !== null && tokens.includes(match[1]!.trim());
  };

  const fixture = await startHttpFixture(async (request, raw) => {
    const segments = request.url.pathname.split("/").slice(1).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
    const [api, resource] = segments;
    if (api !== "v0.1") return problem(404, "Not Found", "unknown API version");
    const authHeader = request.headers.authorization;
    if (
      options.readToken !== undefined &&
      request.method === "GET" &&
      !authorized(authHeader, [options.readToken])
    )
      return problem(401, "Unauthorized", "registry token required");

    if (request.method === "GET" && resource === "servers" && segments.length === 2) {
      listRequests++;
      const fault = faults.failListRequest;
      if (fault && (fault.repeat ? listRequests >= fault.at : listRequests === fault.at)) {
        if (fault.disconnect) {
          raw.res.socket?.destroy();
          return undefined;
        }
        return problem(fault.status ?? 503, "Service Unavailable", "injected outage");
      }
      if (faults.malformedList)
        return { status: 200, headers: { "content-type": "application/json" }, body: "{\"servers\": [" };
      if (faults.oversizedList)
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: `{"servers":[],"metadata":{"count":0},"pad":"${"x".repeat(6 * 1024 * 1024)}"}`,
        };
      const params = request.url.searchParams;
      const limitParam = params.get("limit");
      const limit = limitParam === null ? 30 : Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return problem(400, "Bad Request", "limit must be between 1 and 100");
      const cursor = params.get("cursor") ?? undefined;
      if (cursor !== undefined) {
        if (faults.staleCursors?.has(cursor)) return problem(400, "Bad Request", "invalid cursor");
        if (!entries.some((entry) => key(entry) === cursor))
          return problem(400, "Bad Request", "invalid cursor");
      }
      const search = params.get("search")?.toLowerCase();
      const since = params.get("updated_since");
      let sinceMs: number | undefined;
      if (since !== null) {
        sinceMs = Date.parse(since);
        if (!Number.isFinite(sinceMs))
          return problem(400, "Bad Request", "updated_since must be RFC3339");
      }
      const version = params.get("version");
      const includeDeleted =
        since !== null || params.get("include_deleted") === "true";
      const ordered = [...entries];
      let start = 0;
      if (cursor !== undefined)
        start = ordered.findIndex((entry) => key(entry) === cursor) + 1;
      const filtered = ordered.filter((entry) => {
        const official = entry._meta[OFFICIAL_META];
        if (!includeDeleted && official.status === "deleted") return false;
        if (search && !entry.server.name.toLowerCase().includes(search)) return false;
        if (version === "latest" && !official.isLatest) return false;
        if (version && version !== "latest" && entry.server.version !== version) return false;
        if (sinceMs !== undefined && Date.parse(official.updatedAt) < sinceMs) return false;
        return true;
      });
      const startIndex = cursor === undefined ? 0 : filtered.findIndex((entry) => key(entry) === cursor) + 1;
      void start;
      const page = filtered.slice(startIndex, startIndex + limit);
      const servers: unknown[] = [];
      for (const entry of page) {
        servers.push(structuredClone(entry));
        const absolute = entries.indexOf(entry);
        for (const poison of poisoned)
          if (poison.afterIndex === absolute) servers.push(poison.raw);
      }
      const last = page.at(-1);
      const more = startIndex + page.length < filtered.length;
      const nextCursor = faults.loopOnce && cursor !== undefined ? cursor : last && more ? key(last) : undefined;
      if (faults.loopOnce) faults.loopOnce = false;
      return {
        status: 200,
        body: {
          servers,
          metadata: { count: servers.length, ...(nextCursor ? { nextCursor } : {}) },
        },
      };
    }

    if (request.method === "GET" && resource === "servers" && segments[3] === "versions") {
      const name = segments[2]!;
      const includeDeleted = request.url.searchParams.get("include_deleted") === "true";
      const versions = entries.filter(
        (entry) =>
          entry.server.name === name &&
          (includeDeleted || entry._meta[OFFICIAL_META].status !== "deleted"),
      );
      if (segments.length === 4) {
        if (!entries.some((entry) => entry.server.name === name))
          return problem(404, "Not Found", "server not found");
        return {
          status: 200,
          body: { servers: structuredClone(versions), metadata: { count: versions.length } },
        };
      }
      if (segments.length === 5) {
        const requested = segments[4]!;
        const entry =
          requested === "latest"
            ? versions.find((item) => item._meta[OFFICIAL_META].isLatest)
            : versions.find((item) => item.server.version === requested);
        if (!entry) return problem(404, "Not Found", "server version not found");
        return { status: 200, body: structuredClone(entry) };
      }
    }

    if (request.method === "POST" && resource === "publish" && segments.length === 2) {
      if (!authorized(authHeader, options.publishTokens ?? []))
        return problem(401, "Unauthorized", "registry token required");
      let document: Record<string, unknown>;
      try {
        document = JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
      } catch {
        return problem(400, "Bad Request", "invalid JSON");
      }
      const name = document.name;
      const version = document.version;
      const description = document.description;
      if (typeof document.$schema !== "string")
        return problem(400, "Bad Request", "$schema is required");
      if (typeof name !== "string" || !namePattern.test(name) || name.length > 200)
        return problem(400, "Bad Request", "invalid server name");
      if (typeof version !== "string" || !version || version.length > 255 || version === "latest")
        return problem(400, "Bad Request", "invalid version");
      if (typeof description !== "string" || !description || description.length > 100)
        return problem(400, "Bad Request", "description must be 1-100 characters");
      if (!Array.isArray(document.remotes ?? []) || !Array.isArray(document.packages ?? []))
        return problem(400, "Bad Request", "remotes and packages must be arrays");
      if (entries.some((entry) => entry.server.name === name && entry.server.version === version))
        return problem(400, "Bad Request", "version already exists");
      const at = iso();
      for (const entry of entries)
        if (entry.server.name === name && entry._meta[OFFICIAL_META].isLatest) {
          entry._meta[OFFICIAL_META].isLatest = false;
          entry._meta[OFFICIAL_META].updatedAt = at;
        }
      const created: DoubleEntry = {
        server: document as DoubleEntry["server"],
        _meta: {
          [OFFICIAL_META]: {
            status: "active",
            publishedAt: at,
            updatedAt: at,
            statusChangedAt: at,
            isLatest: true,
          },
        },
      };
      entries.push(created);
      return { status: 200, body: structuredClone(created) };
    }
    return problem(404, "Not Found", "no such route");
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    received: fixture.received,
    close: fixture.close,
    /** Live entry list; tests mutate it through the helpers below. */
    entries,
    faults,
    listRequestCount: () => listRequests,
    resetListRequests: () => {
      listRequests = 0;
    },
    /** Adds a version as a publisher would; older versions stop being `latest`. */
    publish(server: DoubleEntry["server"], official: Partial<DoubleOfficialMeta> = {}) {
      const at = official.publishedAt ?? iso();
      for (const entry of entries)
        if (entry.server.name === server.name && entry._meta[OFFICIAL_META].isLatest) {
          entry._meta[OFFICIAL_META].isLatest = false;
          entry._meta[OFFICIAL_META].updatedAt = at;
        }
      const created = registryEntry(server, {
        publishedAt: at,
        updatedAt: at,
        statusChangedAt: at,
        isLatest: true,
        ...official,
      });
      entries.push(created);
      return created;
    },
    /** Moves a version's status as a maintainer or moderator would. */
    setStatus(
      name: string,
      version: string,
      status: DoubleOfficialMeta["status"],
      statusMessage?: string,
    ) {
      const entry = entries.find(
        (item) => item.server.name === name && item.server.version === version,
      );
      if (!entry) throw new Error("unknown entry");
      const at = iso();
      const official = entry._meta[OFFICIAL_META];
      official.status = status;
      official.statusChangedAt = at;
      official.updatedAt = at;
      if (statusMessage === undefined) delete official.statusMessage;
      else official.statusMessage = statusMessage;
      return entry;
    },
    /** Hard removal, as after a data reset: the version is simply no longer listed. */
    remove(name: string, version: string) {
      const index = entries.findIndex(
        (item) => item.server.name === name && item.server.version === version,
      );
      if (index >= 0) entries.splice(index, 1);
    },
    /** Rewrites a published document in place (the registry says metadata is immutable; a double can misbehave). */
    rewrite(name: string, version: string, patch: Record<string, unknown>) {
      const entry = entries.find(
        (item) => item.server.name === name && item.server.version === version,
      );
      if (!entry) throw new Error("unknown entry");
      Object.assign(entry.server, patch);
      entry._meta[OFFICIAL_META].updatedAt = iso();
      return entry;
    },
  };
}
