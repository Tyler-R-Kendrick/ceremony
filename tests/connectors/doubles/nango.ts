import { createHmac } from "node:crypto";
import { startHttpFixture, type RecordedRequest } from "./http-fixture.js";

/*
 * An independent double of the Nango HTTP API, written from the published
 * documentation (nango.dev/docs, retrieved 2026-09-18) and NOT from the
 * adapter under test. It asserts the documented request contract itself —
 * Authorization: Bearer <API key>, the exact paths, the required query
 * parameters and the Provider-Config-Key / Connection-Id proxy headers — and
 * answers with the documented response envelopes and StdError shapes. When a
 * request violates the contract the double answers the way the documentation
 * says the API answers (400/401/404), so a wrong adapter fails here rather
 * than being quietly accommodated.
 *
 * Documented surface implemented:
 *   POST   /connect/sessions                          201 { data: { token, expires_at, connect_link? } }
 *   POST   /connect/sessions/reconnect                201 same envelope
 *   GET    /integrations                              200 { data: Integration[] }
 *   GET    /integrations/{uniqueKey}                  200 { data: IntegrationFull }
 *   GET    /integrations/{uniqueKey}/functions        200 { data, pagination }
 *   GET    /connections                               200 { connections: [...] }  (no credentials)
 *   GET    /connections/{connectionId}                200 ConnectionFull (WITH credentials)
 *   DELETE /connections/{connectionId}                200 { success }
 *   {GET,POST,PUT,PATCH,DELETE} /proxy/{anyPath}      upstream response passed through
 *   POST   /action/trigger                            200 action result | { id, statusUrl }
 *   POST   /sync/{trigger,start,pause}                200 { success }
 *   GET    /sync/status                               200 { syncs: [...] }
 *   GET    /records                                   200 { records, next_cursor }
 */

export type DoubleIntegration = {
  unique_key: string;
  display_name: string;
  provider: string;
  logo?: string;
  created_at: string;
  updated_at: string;
  forward_webhooks?: boolean;
  webhook_url?: string | null;
};

export type DoubleFunction =
  | {
      type: "sync";
      name: string;
      description?: string;
      scopes?: string[];
      input?: string;
      returns?: string[];
      json_schema?: Record<string, unknown> | null;
      runs: string | null;
      auto_start: boolean;
      track_deletes: boolean;
      id: number;
      enabled: boolean;
      last_deployed: string;
      source: "catalog" | "standalone" | "repo";
    }
  | {
      type: "action";
      name: string;
      description?: string;
      scopes?: string[];
      input?: string;
      returns?: string[];
      json_schema?: Record<string, unknown> | null;
      id: number;
      enabled: boolean;
      last_deployed: string;
      source: "catalog" | "standalone" | "repo";
    }
  | {
      type: "on-event";
      name: string;
      description?: string;
      event: "post-connection-creation" | "pre-connection-deletion" | "validate-connection";
      id: number;
      enabled: boolean;
      last_deployed: string;
      source: "catalog" | "standalone" | "repo";
    };

/** A connection as Nango stores it: credentials included, list view excludes them. */
export type DoubleConnection = {
  id: number;
  connection_id: string;
  provider: string;
  provider_config_key: string;
  /** The Nango environment this connection lives in; the double serves one environment per key. */
  environment?: string;
  created: string;
  created_at?: string;
  updated_at?: string;
  last_fetched_at?: string;
  metadata?: Record<string, unknown> | null;
  connection_config?: Record<string, unknown>;
  tags?: Record<string, string>;
  errors?: Array<{ type: "auth" | "sync"; log_id: string }>;
  credentials?: Record<string, unknown>;
};

export type ProxyHandler = (input: {
  method: string;
  /** Path after `/proxy`, e.g. "/user" for GET /proxy/user. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  connectionId: string;
  providerConfigKey: string;
}) => { status?: number; headers?: Record<string, string>; body?: unknown } | undefined;

export type ActionHandler = (input: {
  actionName: string;
  input: unknown;
  connectionId: string;
  providerConfigKey: string;
  async: boolean;
}) => { status?: number; body?: unknown } | undefined;

export type SyncStatusRow = {
  id?: string;
  connection_id?: string;
  name: string;
  variant?: string;
  status: "RUNNING" | "PAUSED" | "STOPPED" | "SUCCESS" | "ERROR";
  type?: "INCREMENTAL" | "INITIAL";
  finishedAt?: string | null;
  nextScheduledSyncAt?: string | null;
  frequency?: string | null;
  latestResult?: Record<string, unknown>;
  recordCount?: Record<string, unknown>;
  checkpoint?: Record<string, unknown> | null;
};

export type NangoDoubleOptions = {
  /** The Environment API key the double accepts; anything else is 401, as documented. */
  apiKey: string;
  environment?: string;
  integrations?: DoubleIntegration[];
  functions?: Record<string, DoubleFunction[]>;
  connections?: DoubleConnection[];
  proxy?: ProxyHandler;
  action?: ActionHandler;
  syncStatus?: SyncStatusRow[];
  records?: Record<string, { records: Array<Record<string, unknown>>; next_cursor: string | null }>;
  /** Fixed session token/link generator; defaults to counting tokens. */
  session?: (input: {
    kind: "connect" | "reconnect";
    body: Record<string, unknown>;
    index: number;
  }) => { token: string; expires_at: string; connect_link?: string };
  /** Overrides a response entirely, for fault injection (rate limits, outages). */
  intercept?: (
    request: RecordedRequest,
  ) => { status: number; headers?: Record<string, string>; body?: unknown } | undefined;
};

export type SessionRecord = {
  kind: "connect" | "reconnect";
  token: string;
  body: Record<string, unknown>;
  allowedIntegrations: string[] | undefined;
  tags: Record<string, string> | undefined;
  webhookUrlOverride: string | undefined;
};

const stdError = (code: string, message?: string) => ({
  error: { code, ...(message ? { message } : {}) },
});

/** The documented signature: HMAC-SHA256 of the raw body with the webhook signing key, hex. */
export function signNangoWebhook(signingKey: string, body: string | Uint8Array): string {
  return createHmac("sha256", signingKey)
    .update(typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body))
    .digest("hex");
}

/** The legacy header Nango still sends: plain SHA-256, documented as "should not be used". */
export function legacyNangoSignature(secretKey: string, body: string): string {
  return createHmac("sha256", secretKey).update(body).digest("hex");
}

export async function startNangoDouble(options: NangoDoubleOptions) {
  const environment = options.environment ?? "dev";
  const integrations = [...(options.integrations ?? [])];
  const functions = { ...(options.functions ?? {}) };
  const connections = [...(options.connections ?? [])];
  const sessions: SessionRecord[] = [];
  const deleted: Array<{ connectionId: string; providerConfigKey: string }> = [];
  const syncCommands: Array<{
    command: string;
    body: Record<string, unknown>;
  }> = [];
  const credentialReads: Array<{
    connectionId: string;
    providerConfigKey: string;
    forceRefresh: string | null;
    refreshToken: string | null;
  }> = [];
  let sessionIndex = 0;

  const fixture = await startHttpFixture((request) => {
    const intercepted = options.intercept?.(request);
    if (intercepted) return intercepted;
    const { pathname } = request.url;
    const query = request.url.searchParams;
    const auth = request.headers.authorization;
    // Documented authentication: "Use a Nango API key as a Bearer token in
    // the Authorization header." A missing or wrong key is 401.
    if (auth !== `Bearer ${options.apiKey}`)
      return { status: 401, body: stdError("unauthorized", "Invalid API key") };

    const json = (): Record<string, unknown> | undefined => {
      if (!request.body.length) return undefined;
      try {
        return JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    };

    /* ------------------------------------------------- connect sessions */
    if (pathname === "/connect/sessions" || pathname === "/connect/sessions/reconnect") {
      if (request.method !== "POST")
        return { status: 404, body: stdError("not_found") };
      const body = json();
      if (!body) return { status: 400, body: stdError("invalid_body") };
      const kind = pathname.endsWith("/reconnect") ? "reconnect" : "connect";
      if (kind === "reconnect" && (!body.connection_id || !body.integration_id))
        return { status: 400, body: stdError("invalid_body", "connection_id and integration_id are required") };
      const tags = body.tags as Record<string, string> | undefined;
      if (tags && Object.keys(tags).length > 10)
        return { status: 400, body: stdError("invalid_body", "at most 10 tags") };
      const allowed = body.allowed_integrations as string[] | undefined;
      const index = sessionIndex++;
      const issued =
        options.session?.({ kind, body, index }) ??
        {
          token: `nango_connect_session_${index}_${Math.random().toString(36).slice(2, 10)}`,
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          connect_link: `https://connect.nango.dev/?session_token=session-${index}`,
        };
      sessions.push({
        kind,
        token: issued.token,
        body,
        allowedIntegrations: allowed,
        tags,
        webhookUrlOverride: body.webhook_url_override as string | undefined,
      });
      return { status: 201, body: { data: issued } };
    }

    /* ---------------------------------------------------- integrations */
    if (pathname === "/integrations" && request.method === "GET")
      return {
        status: 200,
        body: {
          data: integrations.map((integration) => ({
            unique_key: integration.unique_key,
            display_name: integration.display_name,
            provider: integration.provider,
            ...(integration.logo ? { logo: integration.logo } : {}),
            created_at: integration.created_at,
            updated_at: integration.updated_at,
            ...(integration.forward_webhooks === undefined
              ? {}
              : { forward_webhooks: integration.forward_webhooks }),
          })),
        },
      };

    const functionsMatch = /^\/integrations\/([^/]+)\/functions$/.exec(pathname);
    if (functionsMatch && request.method === "GET") {
      const uniqueKey = decodeURIComponent(functionsMatch[1]!);
      if (!integrations.some((item) => item.unique_key === uniqueKey))
        return { status: 404, body: stdError("not_found") };
      const all = (functions[uniqueKey] ?? []).filter((fn) => {
        const type = query.get("type");
        return !type || fn.type === type;
      });
      const page = Number(query.get("page") ?? "0");
      const limit = Number(query.get("limit") ?? "20");
      if (!Number.isInteger(page) || page < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
        return { status: 400, body: stdError("invalid_query_params") };
      return {
        status: 200,
        body: {
          data: all.slice(page * limit, page * limit + limit),
          pagination: { total: all.length, page, limit },
        },
      };
    }

    const integrationMatch = /^\/integrations\/([^/]+)$/.exec(pathname);
    if (integrationMatch && request.method === "GET") {
      const uniqueKey = decodeURIComponent(integrationMatch[1]!);
      const integration = integrations.find((item) => item.unique_key === uniqueKey);
      if (!integration) return { status: 404, body: stdError("not_found") };
      const include = query.getAll("include");
      return {
        status: 200,
        body: {
          data: {
            unique_key: integration.unique_key,
            display_name: integration.display_name,
            provider: integration.provider,
            ...(integration.logo ? { logo: integration.logo } : {}),
            created_at: integration.created_at,
            updated_at: integration.updated_at,
            ...(integration.forward_webhooks === undefined
              ? {}
              : { forward_webhooks: integration.forward_webhooks }),
            ...(include.includes("webhook") ? { webhook_url: integration.webhook_url ?? null } : {}),
            // Only returned when explicitly requested, per the documented
            // `include` parameter and the *_credentials API key scopes.
            ...(include.includes("credentials")
              ? {
                  credentials: {
                    type: "OAUTH2",
                    client_id: "fixture-client-id",
                    client_secret: "fixture-client-secret-DO-NOT-LEAK",
                    scopes: "read,write",
                  },
                }
              : {}),
          },
        },
      };
    }

    /* ----------------------------------------------------- connections */
    if (pathname === "/connections" && request.method === "GET") {
      const connectionId = query.get("connectionId");
      const tagFilters: Array<[string, string]> = [];
      for (const [key, value] of query.entries()) {
        const tag = /^tags\[([^\]]+)\]$/.exec(key);
        if (tag) tagFilters.push([tag[1]!, value]);
      }
      const matching = connections.filter((connection) => {
        if (connection.environment !== undefined && connection.environment !== environment)
          return false;
        if (connectionId && connection.connection_id !== connectionId) return false;
        return tagFilters.every(([key, value]) => connection.tags?.[key] === value);
      });
      return {
        status: 200,
        body: {
          // Documented as "Returns a list of connections without credentials".
          connections: matching.map((connection) => ({
            id: connection.id,
            connection_id: connection.connection_id,
            provider: connection.provider,
            provider_config_key: connection.provider_config_key,
            created: connection.created,
            metadata: connection.metadata ?? null,
            tags: connection.tags ?? {},
            errors: connection.errors ?? [],
          })),
        },
      };
    }

    const connectionMatch = /^\/connections\/([^/]+)$/.exec(pathname);
    if (connectionMatch) {
      const connectionId = decodeURIComponent(connectionMatch[1]!);
      const providerConfigKey = query.get("provider_config_key");
      // Documented as required on both GET and DELETE.
      if (!providerConfigKey)
        return { status: 400, body: stdError("invalid_query_params", "provider_config_key is required") };
      const index = connections.findIndex(
        (connection) =>
          connection.connection_id === connectionId &&
          connection.provider_config_key === providerConfigKey &&
          (connection.environment === undefined || connection.environment === environment),
      );
      if (request.method === "GET") {
        credentialReads.push({
          connectionId,
          providerConfigKey,
          forceRefresh: query.get("force_refresh"),
          refreshToken: query.get("refresh_token"),
        });
        if (index < 0) return { status: 404, body: stdError("not_found") };
        const connection = connections[index]!;
        return {
          status: 200,
          body: {
            id: connection.id,
            connection_id: connection.connection_id,
            provider_config_key: connection.provider_config_key,
            provider: connection.provider,
            errors: connection.errors ?? [],
            metadata: connection.metadata ?? {},
            connection_config: connection.connection_config ?? {},
            tags: connection.tags ?? {},
            created_at: connection.created_at ?? connection.created,
            updated_at: connection.updated_at ?? connection.created,
            last_fetched_at: connection.last_fetched_at ?? connection.created,
            // The documented behaviour: this endpoint returns credentials.
            credentials: connection.credentials ?? {
              type: "OAUTH2",
              access_token: "fixture-access-token-DO-NOT-LEAK",
              refresh_token: "fixture-refresh-token-DO-NOT-LEAK",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              raw: { scope: "read write", token_type: "bearer" },
            },
          },
        };
      }
      if (request.method === "DELETE") {
        if (index < 0) return { status: 404, body: stdError("not_found") };
        connections.splice(index, 1);
        deleted.push({ connectionId, providerConfigKey });
        return { status: 200, body: { success: true } };
      }
      return { status: 404, body: stdError("not_found") };
    }

    /* ---------------------------------------------------------- proxy */
    if (pathname === "/proxy" || pathname.startsWith("/proxy/")) {
      const connectionId = request.headers["connection-id"];
      const providerConfigKey = request.headers["provider-config-key"];
      // Both documented as required headers on every proxy request.
      if (!connectionId || !providerConfigKey)
        return { status: 400, body: stdError("missing_connection_headers") };
      const connection = connections.find(
        (item) =>
          item.connection_id === connectionId &&
          item.provider_config_key === providerConfigKey &&
          (item.environment === undefined || item.environment === environment),
      );
      if (!connection) return { status: 404, body: stdError("unknown_connection") };
      const handled = options.proxy?.({
        method: request.method,
        path: pathname.slice("/proxy".length) || "/",
        query,
        headers: request.headers,
        body: request.body,
        connectionId,
        providerConfigKey,
      });
      return handled ?? { status: 404, body: stdError("not_found") };
    }

    /* -------------------------------------------------------- actions */
    if (pathname === "/action/trigger" && request.method === "POST") {
      const connectionId = request.headers["connection-id"];
      const providerConfigKey = request.headers["provider-config-key"];
      if (!connectionId || !providerConfigKey)
        return { status: 400, body: stdError("missing_connection_headers") };
      const body = json();
      const actionName = body?.action_name;
      if (typeof actionName !== "string" || !actionName)
        return { status: 400, body: stdError("invalid_body", "action_name is required") };
      const handled = options.action?.({
        actionName,
        input: body?.input,
        connectionId,
        providerConfigKey,
        async: request.headers["x-async"] === "true",
      });
      return (
        handled ?? {
          status: 404,
          body: { error: { message: "Action not found", code: "unknown_action", payload: {} } },
        }
      );
    }

    /* ---------------------------------------------------------- syncs */
    const syncMatch = /^\/sync\/(trigger|start|pause)$/.exec(pathname);
    if (syncMatch && request.method === "POST") {
      const body = json();
      if (!body || typeof body.provider_config_key !== "string" || !Array.isArray(body.syncs))
        return { status: 400, body: { message: "provider_config_key and syncs are required" } };
      syncCommands.push({ command: syncMatch[1]!, body });
      return { status: 200, body: { success: true } };
    }
    if (pathname === "/sync/status" && request.method === "GET") {
      const syncs = query.get("syncs");
      const providerConfigKey = query.get("provider_config_key");
      if (!syncs || !providerConfigKey)
        return { status: 400, body: stdError("invalid_query_params") };
      const connectionId = query.get("connection_id");
      const names = syncs === "*" ? undefined : syncs.split(",").map((name) => name.split("::")[0]);
      return {
        status: 200,
        body: {
          syncs: (options.syncStatus ?? []).filter(
            (row) =>
              (!names || names.includes(row.name)) &&
              (!connectionId || row.connection_id === undefined || row.connection_id === connectionId),
          ),
        },
      };
    }

    /* -------------------------------------------------------- records */
    if (pathname === "/records" && request.method === "GET") {
      const connectionId = request.headers["connection-id"];
      const providerConfigKey = request.headers["provider-config-key"];
      if (!connectionId || !providerConfigKey)
        return { status: 400, body: stdError("missing_connection_headers") };
      const model = query.get("model");
      if (!model) return { status: 400, body: stdError("invalid_query_params", "model is required") };
      const page = options.records?.[model];
      return {
        status: 200,
        body: page ?? { records: [], next_cursor: null },
      };
    }

    return { status: 404, body: stdError("not_found") };
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    received: fixture.received,
    close: fixture.close,
    sessions,
    deleted,
    syncCommands,
    credentialReads,
    connections,
    integrations,
    /** Adds a connection as the Connect UI would after a successful authorization. */
    addConnection(connection: DoubleConnection) {
      connections.push({ environment, ...connection });
      return connection;
    },
    setConnectionErrors(connectionId: string, errors: DoubleConnection["errors"]) {
      const connection = connections.find((item) => item.connection_id === connectionId);
      if (connection) connection.errors = errors;
    },
  };
}

export type NangoDouble = Awaited<ReturnType<typeof startNangoDouble>>;
