import { startHttpFixture, type RecordedRequest } from "./http-fixture.js";

/*
 * An independent double of the Smithery Platform API, written from Smithery's
 * published documentation (retrieved 2026-09-18):
 *
 *   https://smithery.ai/docs/use/connect
 *   https://smithery.ai/docs/use/token-scoping
 *   https://smithery.ai/docs/api-reference/servers/list-all-servers
 *   https://smithery.ai/docs/api-reference/servers/get-a-server
 *   https://smithery.ai/docs/api-reference/connect/{list,create,get,create-or-update,delete}-connection
 *   https://smithery.ai/docs/api-reference/tokens/create-a-service-token
 *   https://smithery.ai/docs/api-reference/namespaces/get-users-namespaces-or-search-namespaces
 *
 * It implements the documented request validation itself — Bearer
 * authentication, namespace ownership, service-token policy, pagination,
 * search filters, connection status states and the documented status codes —
 * so a test fails when the adapter speaks a different protocol than the one
 * Smithery documents. It shares no code with the adapter under test.
 */

export type SmitheryConnectionSeed = {
  connectionId: string;
  namespace: string;
  name?: string;
  transport?: "http" | "uplink";
  mcpUrl?: string;
  metadata?: Record<string, string>;
  /** Status the server reports for this connection, as documented. */
  status:
    | { state: "connected" }
    | { state: "disconnected" }
    | { state: "auth_required"; setupUrl: string }
    | {
        state: "input_required";
        setupUrl: string;
        http: {
          headers: Record<string, unknown>;
          query: Record<string, unknown>;
        };
        missing: { headers: string[]; query: string[] };
      }
    | { state: "error"; message: string };
  serverInfo?: {
    name: string;
    version: string;
    title?: string;
    websiteUrl?: string;
    description?: string;
  };
  createdAt?: string;
};

export type SmitheryServerSeed = {
  id: string;
  qualifiedName: string;
  namespace: string;
  slug: string;
  displayName: string;
  description: string;
  iconUrl?: string | null;
  verified?: boolean;
  useCount?: number;
  remote?: boolean | null;
  isDeployed?: boolean;
  createdAt?: string;
  homepage?: string;
  bySmithery?: boolean;
  owner?: string | null;
  detail?: {
    deploymentUrl?: string | null;
    connections?: Array<Record<string, unknown>>;
    security?: { scanPassed: boolean };
    tools?: Array<Record<string, unknown>>;
  };
};

export type SmitheryTokenPolicy = {
  namespaces?: string | string[];
  resources?: string | string[];
  operations?: string | string[];
  metadata?: Record<string, string> | Array<Record<string, string>>;
  ttl?: string | number;
};

export type SmitheryDoubleOptions = {
  apiKey: string;
  /** Namespaces the API key owns. Anything else is "not found or access denied". */
  namespaces: string[];
  servers?: SmitheryServerSeed[];
  connections?: SmitheryConnectionSeed[];
  now?: () => number;
};

type StoredToken = {
  token: string;
  policy: SmitheryTokenPolicy[];
  expiresAt: number;
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function error(status: number, code: string, message: string) {
  return { status, body: { error: code, message } };
}

export async function startSmitheryDouble(options: SmitheryDoubleOptions) {
  const now = options.now ?? Date.now;
  const namespaces = new Set(options.namespaces);
  const servers = [...(options.servers ?? [])];
  const connections = new Map<string, SmitheryConnectionSeed>(
    (options.connections ?? []).map((connection) => [
      `${connection.namespace}/${connection.connectionId}`,
      { ...connection },
    ]),
  );
  const tokens = new Map<string, StoredToken>();
  const created: string[] = [];
  const deleted: string[] = [];
  const namespaceWrites: string[] = [];
  let tokenCounter = 0;

  /** Documented behaviour: a bearer is either the API key or a minted token. */
  function authorize(
    request: RecordedRequest,
    need: {
      namespace?: string;
      resource: "connections" | "servers" | "namespaces" | "skills";
      operation: "read" | "write" | "execute";
      metadata?: Record<string, string>;
    },
  ):
    | { ok: true; scoped: boolean }
    | { ok: false; reply: ReturnType<typeof error> } {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer "))
      return {
        ok: false,
        reply: error(401, "unauthorized", "Invalid or missing API key"),
      };
    const bearer = header.slice("Bearer ".length);
    if (bearer === options.apiKey) {
      if (need.namespace && !namespaces.has(need.namespace))
        return {
          ok: false,
          reply: error(
            404,
            "not_found",
            "Namespace not found or access denied",
          ),
        };
      return { ok: true, scoped: false };
    }
    const stored = tokens.get(bearer);
    if (!stored)
      return {
        ok: false,
        reply: error(401, "unauthorized", "Invalid API key"),
      };
    if (stored.expiresAt <= now())
      return { ok: false, reply: error(401, "unauthorized", "Token expired") };
    const matches = stored.policy.some((constraint) => {
      const allowedNamespaces = asList(constraint.namespaces);
      if (
        allowedNamespaces &&
        need.namespace &&
        !allowedNamespaces.includes(need.namespace)
      )
        return false;
      const resources = asList(constraint.resources);
      if (resources && !resources.includes(need.resource)) return false;
      const operations = asList(constraint.operations);
      if (operations && !operations.includes(need.operation)) return false;
      const metadata = constraint.metadata;
      if (metadata) {
        const alternatives = Array.isArray(metadata) ? metadata : [metadata];
        const observed = need.metadata ?? {};
        if (
          !alternatives.some((alternative) =>
            Object.entries(alternative).every(
              ([key, value]) => observed[key] === value,
            ),
          )
        )
          return false;
      }
      return true;
    });
    if (!matches)
      return {
        ok: false,
        reply: need.namespace
          ? error(404, "not_found", "Namespace not found or access denied")
          : error(403, "forbidden", "Token is not scoped for this request"),
      };
    if (need.namespace && !namespaces.has(need.namespace))
      return {
        ok: false,
        reply: error(404, "not_found", "Namespace not found or access denied"),
      };
    return { ok: true, scoped: true };
  }

  function connectionBody(connection: SmitheryConnectionSeed) {
    return {
      connectionId: connection.connectionId,
      name: connection.name ?? connection.connectionId,
      transport: connection.transport ?? "http",
      mcpUrl: connection.mcpUrl ?? null,
      metadata: connection.metadata ?? null,
      iconUrl: null,
      createdAt: connection.createdAt ?? "2026-09-18T00:00:00.000Z",
      status: connection.status,
      ...(connection.serverInfo ? { serverInfo: connection.serverInfo } : {}),
    };
  }

  const fixture = await startHttpFixture(async (request) => {
    const path = request.url.pathname;
    const method = request.method;

    if (method === "GET" && path === "/namespaces") {
      const auth = authorize(request, {
        resource: "namespaces",
        operation: "read",
      });
      if (!auth.ok) return auth.reply;
      return {
        body: {
          namespaces: [...namespaces].map((name) => ({ name })),
          pagination: {
            currentPage: 1,
            pageSize: 50,
            totalPages: 1,
            totalCount: namespaces.size,
          },
        },
      };
    }

    if (method === "POST" && path === "/namespaces") {
      // Recorded so a test can prove the adapter never creates a namespace.
      namespaceWrites.push(request.body.toString("utf8"));
      return error(
        403,
        "forbidden",
        "Namespace creation is not permitted here",
      );
    }

    if (method === "POST" && path === "/tokens") {
      const auth = authorize(request, {
        resource: "namespaces",
        operation: "write",
      });
      if (!auth.ok) return auth.reply;
      if (auth.scoped)
        return error(403, "forbidden", "A service token cannot mint tokens");
      let parsed: { policy?: SmitheryTokenPolicy[] };
      try {
        parsed = JSON.parse(request.body.toString("utf8")) as {
          policy?: SmitheryTokenPolicy[];
        };
      } catch {
        return error(400, "validation_error", "Body is not JSON");
      }
      if (!Array.isArray(parsed.policy) || parsed.policy.length === 0)
        return error(400, "validation_error", "policy is required");
      const token = `st_${++tokenCounter}`;
      const ttl = parsed.policy[0]?.ttl;
      const seconds =
        typeof ttl === "number"
          ? ttl / 1000
          : typeof ttl === "string" && /^(\d+)([smh])$/.test(ttl)
            ? Number(RegExp.$1) *
              ({ s: 1, m: 60, h: 3600 }[RegExp.$2 as "s" | "m" | "h"] ?? 1)
            : 3600;
      const expiresAt = now() + seconds * 1000;
      tokens.set(token, { token, policy: parsed.policy, expiresAt });
      return {
        body: { token, expiresAt: new Date(expiresAt).toISOString() },
      };
    }

    if (method === "GET" && path === "/servers") {
      const auth = authorize(request, {
        resource: "servers",
        operation: "read",
      });
      if (!auth.ok) return auth.reply;
      const query = request.url.searchParams;
      const pageSize = Math.min(
        Math.max(
          Number(query.get("pageSize") ?? DEFAULT_PAGE_SIZE) ||
            DEFAULT_PAGE_SIZE,
          1,
        ),
        MAX_PAGE_SIZE,
      );
      const page = Math.max(Number(query.get("page") ?? 1) || 1, 1);
      const q = query.get("q")?.toLowerCase();
      const namespaceFilter = query.get("namespace");
      const qualified = query.get("qualifiedName");
      const filtered = servers.filter(
        (server) =>
          (!q ||
            server.displayName.toLowerCase().includes(q) ||
            server.description.toLowerCase().includes(q) ||
            server.qualifiedName.toLowerCase().includes(q)) &&
          (!namespaceFilter || server.namespace === namespaceFilter) &&
          (!qualified || server.qualifiedName === qualified),
      );
      const start = (page - 1) * pageSize;
      return {
        body: {
          servers: filtered.slice(start, start + pageSize).map((server) => ({
            id: server.id,
            qualifiedName: server.qualifiedName,
            namespace: server.namespace,
            slug: server.slug,
            displayName: server.displayName,
            description: server.description,
            iconUrl: server.iconUrl ?? null,
            verified: server.verified ?? false,
            useCount: server.useCount ?? 0,
            remote: server.remote ?? null,
            isDeployed: server.isDeployed ?? false,
            createdAt: server.createdAt ?? "2026-01-01T00:00:00.000Z",
            homepage: server.homepage ?? "",
            bySmithery: server.bySmithery ?? false,
            owner: server.owner ?? null,
          })),
          pagination: {
            currentPage: page,
            pageSize,
            totalPages: Math.max(Math.ceil(filtered.length / pageSize), 1),
            totalCount: filtered.length,
          },
        },
      };
    }

    if (method === "GET" && path.startsWith("/servers/")) {
      const auth = authorize(request, {
        resource: "servers",
        operation: "read",
      });
      if (!auth.ok) return auth.reply;
      const qualifiedName = decodeURIComponent(path.slice("/servers/".length));
      const server = servers.find(
        (item) => item.qualifiedName === qualifiedName,
      );
      if (!server) return error(404, "not_found", "Server not found");
      return {
        body: {
          qualifiedName: server.qualifiedName,
          displayName: server.displayName,
          description: server.description,
          iconUrl: server.iconUrl ?? null,
          remote: server.remote ?? false,
          deploymentUrl: server.detail?.deploymentUrl ?? null,
          connections: server.detail?.connections ?? [],
          security: server.detail?.security ?? { scanPassed: false },
          tools: server.detail?.tools ?? [],
        },
      };
    }

    const connectionPath = /^\/connect\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (connectionPath) {
      const namespace = decodeURIComponent(connectionPath[1]!);
      const connectionId = connectionPath[2]
        ? decodeURIComponent(connectionPath[2])
        : undefined;
      const key = `${namespace}/${connectionId}`;
      const existing = connectionId ? connections.get(key) : undefined;
      const auth = authorize(request, {
        namespace,
        resource: "connections",
        operation:
          method === "GET" ? "read" : method === "DELETE" ? "write" : "write",
        ...(existing?.metadata ? { metadata: existing.metadata } : {}),
      });
      if (!auth.ok) return auth.reply;

      if (method === "GET" && !connectionId) {
        const limit = Math.min(
          Math.max(
            Number(request.url.searchParams.get("limit") ?? 100) || 100,
            1,
          ),
          100,
        );
        const cursor = Number(request.url.searchParams.get("cursor") ?? 0) || 0;
        const wantedMetadata: Record<string, string> = {};
        for (const [name, value] of request.url.searchParams)
          if (name.startsWith("metadata."))
            wantedMetadata[name.slice("metadata.".length)] = value;
        const all = [...connections.values()].filter(
          (connection) =>
            connection.namespace === namespace &&
            Object.entries(wantedMetadata).every(
              ([name, value]) => connection.metadata?.[name] === value,
            ),
        );
        const page = all.slice(cursor, cursor + limit);
        return {
          body: {
            connections: page.map(connectionBody),
            nextCursor:
              cursor + limit < all.length ? String(cursor + limit) : null,
          },
        };
      }

      if (method === "GET" && connectionId) {
        if (!existing) return error(404, "not_found", "Resource not found");
        return { body: connectionBody(existing) };
      }

      if ((method === "PUT" || method === "POST") && !auth.scoped) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(request.body.toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          return error(400, "validation_error", "Body is not JSON");
        }
        const mcpUrl =
          typeof parsed.mcpUrl === "string" ? parsed.mcpUrl : undefined;
        const server =
          typeof parsed.server === "string" ? parsed.server : undefined;
        if (!mcpUrl && !server)
          return error(
            400,
            "validation_error",
            "One of server or mcpUrl is required",
          );
        const id = connectionId ?? `generated-${connections.size + 1}`;
        const storedKey = `${namespace}/${id}`;
        const prior = connections.get(storedKey);
        if (
          prior &&
          mcpUrl &&
          prior.mcpUrl &&
          prior.mcpUrl !== mcpUrl &&
          prior.status.state !== "input_required"
        )
          return error(409, "conflict", "Connection targets a different URL");
        const seedStatus = prior?.status ?? { state: "connected" as const };
        const record: SmitheryConnectionSeed = {
          connectionId: id,
          namespace,
          ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
          transport:
            parsed.transport === "uplink" ? "uplink" : ("http" as const),
          ...(mcpUrl ? { mcpUrl } : {}),
          ...(parsed.metadata && typeof parsed.metadata === "object"
            ? { metadata: parsed.metadata as Record<string, string> }
            : {}),
          status: seedStatus,
          ...(prior?.serverInfo ? { serverInfo: prior.serverInfo } : {}),
        };
        connections.set(storedKey, record);
        if (!prior) created.push(storedKey);
        return {
          status: prior ? 200 : 201,
          body: connectionBody(record),
        };
      }
      if (method === "PUT" || method === "POST")
        return error(403, "forbidden", "A read/execute token cannot write");

      if (method === "DELETE" && connectionId) {
        if (!existing) return error(404, "not_found", "Resource not found");
        connections.delete(key);
        deleted.push(key);
        return { body: { success: true } };
      }
    }

    const toolPath = /^\/connect\/([^/]+)\/([^/]+)\/\.tools(?:\/(.+))?$/.exec(
      path,
    );
    if (toolPath) {
      const namespace = decodeURIComponent(toolPath[1]!);
      const connectionId = decodeURIComponent(toolPath[2]!);
      const existing = connections.get(`${namespace}/${connectionId}`);
      const auth = authorize(request, {
        namespace,
        resource: "connections",
        operation: method === "GET" ? "read" : "execute",
        ...(existing?.metadata ? { metadata: existing.metadata } : {}),
      });
      if (!auth.ok) return auth.reply;
      if (!existing) return error(404, "not_found", "Resource not found");
      if (method === "GET")
        return {
          body: {
            tools: [{ name: "search", inputSchema: { type: "object" } }],
          },
        };
      return {
        body: { content: [{ type: "text", text: "ok" }], isError: false },
      };
    }

    return error(404, "not_found", "Resource not found");
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    received: fixture.received.bind(fixture),
    close: fixture.close.bind(fixture),
    /** Inspection for assertions; the product never reads these. */
    state: {
      connections,
      tokens,
      created,
      deleted,
      namespaceWrites,
      bearers: () =>
        fixture.requests.map((request) =>
          (request.headers.authorization ?? "").replace("Bearer ", ""),
        ),
    },
    mintToken(policy: SmitheryTokenPolicy[], ttlMs = 3600_000): string {
      const token = `st_${++tokenCounter}`;
      tokens.set(token, { token, policy, expiresAt: now() + ttlMs });
      return token;
    },
  };
}

export type SmitheryDouble = Awaited<ReturnType<typeof startSmitheryDouble>>;
