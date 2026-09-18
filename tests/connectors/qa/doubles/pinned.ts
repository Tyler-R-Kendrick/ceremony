import { createHash, createHmac } from "node:crypto";
import {
  startHttpFixture,
  type FixtureReply,
  type RecordedRequest,
} from "../../doubles/http-fixture.js";

/*
 * QA-01: independent protocol doubles.
 *
 * These doubles are written against the pinned documented contracts recorded
 * in the charter (section 7) and the vendor references in section 11, not
 * against the adapters. Nothing here imports product code, so an adapter
 * cannot generate both sides of an assertion. Every double is fail-closed:
 * a request that does not match the documented method, path, query, headers,
 * encoding, authentication or body shape is answered with the provider's
 * documented error variant and recorded as a violation. A double that
 * accommodated a wrong request would prove nothing, so each one is also
 * exercised directly with deliberately wrong requests in
 * `protocol-conformance.test.ts`.
 *
 * Pinned profiles:
 *   nango-http-api-2026-09      https://nango.dev/docs/reference/backend/http-api
 *   supabase-management-oauth-v1 https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration
 *   mcp-registry-v0.1           https://modelcontextprotocol.io/registry/about
 *   rfc6749/rfc7636/rfc8414/rfc9728 authorization server
 */

export type Violation = {
  /** Stable code so a test asserts the reason, not a message. */
  code: string;
  method: string;
  path: string;
  detail: string;
};

export type DoubleHandle = {
  origin: string;
  requests: RecordedRequest[];
  violations: Violation[];
  close(): Promise<void>;
};

function jsonBody(request: RecordedRequest): unknown {
  try {
    return JSON.parse(request.body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function formBody(request: RecordedRequest): URLSearchParams | undefined {
  try {
    return new URLSearchParams(request.body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function bearer(request: RecordedRequest): string | undefined {
  const header = request.headers.authorization;
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  return match?.[1];
}

/** Collects violations and turns the first one into the documented error reply. */
function recorder() {
  const violations: Violation[] = [];
  return {
    violations,
    fail(
      request: RecordedRequest,
      code: string,
      detail: string,
      reply: FixtureReply,
    ): FixtureReply {
      violations.push({
        code,
        method: request.method,
        path: request.url.pathname,
        detail,
      });
      return reply;
    },
  };
}

/* ------------------------------------------------------------------ Nango */

export type NangoContractOptions = {
  /** The environment secret key; `Authorization: Bearer <secret>` is mandatory. */
  secretKey: string;
  /** The webhook signing key, a different secret from the API key. */
  webhookSigningKey?: string;
  /** Integration unique keys the environment knows about. */
  integrations?: string[];
  /** Connection ids that exist, by integration unique key. */
  connections?: Record<string, string[]>;
  /** When set, `webhook_url_override` is accepted on a connect session. */
  allowWebhookUrlOverride?: boolean;
  /** Answer the Nth matching request with the documented 429 instead. */
  rateLimitAt?: { path: string; nth: number; retryAfterSeconds: number };
};

export type NangoContractDouble = DoubleHandle & {
  /** Connect sessions the double actually issued, in order. */
  sessions: Array<{
    kind: "connect" | "reconnect";
    token: string;
    body: Record<string, unknown>;
  }>;
  /** Proxy calls forwarded through `/proxy/...`. */
  proxied: Array<{ method: string; path: string; body: string }>;
  signWebhook(rawBody: string): string;
};

/**
 * Nango HTTP API, documented subset.
 *
 * - every call: `Authorization: Bearer <environment secret key>`,
 *   `Accept: application/json`; a JSON body carries
 *   `Content-Type: application/json`.
 * - `POST /connect/sessions` — body `{ allowed_integrations, tags }`.
 *   `end_user` and `organization` are deprecated inputs and are refused here so
 *   an adapter that still sends them fails. Answers `201` with
 *   `{ data: { token, expires_at, connect_link } }`.
 * - `POST /connect/sessions/reconnect` — adds `connection_id`, `integration_id`.
 * - `GET /connections` — page/limit pagination, `connectionId` and `tags[k]`
 *   filters; no credentials in the rows.
 * - `GET /connections/{id}?provider_config_key=` — privileged: the documented
 *   response carries credentials, and `force_refresh`/`refresh_token` switches.
 * - `DELETE /connections/{id}?provider_config_key=`.
 * - errors: `401 { error: { code: "unauthorized" } }`,
 *   `404 { error: { code: "not_found" } }`,
 *   `400 { error: { code: "invalid_body" } }`,
 *   `429` with `Retry-After`.
 */
export async function startNangoContract(
  options: NangoContractOptions,
): Promise<NangoContractDouble> {
  const { violations, fail } = recorder();
  const integrations = options.integrations ?? ["github-prod"];
  const connections = options.connections ?? { "github-prod": ["conn-1"] };
  const sessions: NangoContractDouble["sessions"] = [];
  const proxied: NangoContractDouble["proxied"] = [];
  const counts = new Map<string, number>();
  let issued = 0;

  const error = (status: number, code: string): FixtureReply => ({
    status,
    body: { error: { code, message: `documented ${code} variant` } },
  });

  const fixture = await startHttpFixture((request) => {
    const path = request.url.pathname;
    const seen = (counts.get(path) ?? 0) + 1;
    counts.set(path, seen);

    // Authentication is checked before anything else, on every route.
    const token = bearer(request);
    if (token === undefined)
      return fail(
        request,
        "nango.auth.missing-bearer",
        "no Authorization: Bearer header",
        error(401, "unauthorized"),
      );
    if (token !== options.secretKey)
      return fail(
        request,
        "nango.auth.wrong-secret",
        "bearer token is not the environment secret key",
        error(401, "unauthorized"),
      );
    if ((request.headers.accept ?? "") !== "application/json")
      return fail(
        request,
        "nango.headers.accept",
        `Accept was ${request.headers.accept ?? "(absent)"}`,
        error(400, "invalid_headers"),
      );

    if (
      options.rateLimitAt &&
      options.rateLimitAt.path === path &&
      seen === options.rateLimitAt.nth
    )
      return {
        status: 429,
        headers: {
          "retry-after": String(options.rateLimitAt.retryAfterSeconds),
        },
        body: { error: { code: "rate_limit_exceeded" } },
      };

    if (
      path === "/connect/sessions" ||
      path === "/connect/sessions/reconnect"
    ) {
      const reconnect = path.endsWith("/reconnect");
      if (request.method !== "POST")
        return fail(
          request,
          "nango.sessions.method",
          `expected POST, saw ${request.method}`,
          error(405, "method_not_allowed"),
        );
      if (
        !(request.headers["content-type"] ?? "").startsWith("application/json")
      )
        return fail(
          request,
          "nango.sessions.content-type",
          `Content-Type was ${request.headers["content-type"] ?? "(absent)"}`,
          error(400, "invalid_body"),
        );
      const body = jsonBody(request);
      if (typeof body !== "object" || body === null)
        return fail(
          request,
          "nango.sessions.body",
          "body is not a JSON object",
          error(400, "invalid_body"),
        );
      const input = body as Record<string, unknown>;
      if ("end_user" in input || "organization" in input)
        return fail(
          request,
          "nango.sessions.deprecated-inputs",
          "end_user/organization are deprecated in favour of tags",
          error(400, "invalid_body"),
        );
      if (!Array.isArray(input.allowed_integrations))
        return fail(
          request,
          "nango.sessions.allowed-integrations",
          "allowed_integrations must restrict the session",
          error(400, "invalid_body"),
        );
      const allowed = input.allowed_integrations as unknown[];
      if (allowed.length === 0)
        return fail(
          request,
          "nango.sessions.unrestricted",
          "an empty allowed_integrations list authorizes every integration",
          error(400, "invalid_body"),
        );
      for (const entry of allowed)
        if (typeof entry !== "string" || !integrations.includes(entry))
          return fail(
            request,
            "nango.sessions.unknown-integration",
            `unknown integration ${String(entry)}`,
            error(404, "not_found"),
          );
      if (input.tags !== undefined) {
        if (typeof input.tags !== "object" || input.tags === null)
          return fail(
            request,
            "nango.sessions.tags",
            "tags must be a string map",
            error(400, "invalid_body"),
          );
        for (const value of Object.values(
          input.tags as Record<string, unknown>,
        ))
          if (typeof value !== "string")
            return fail(
              request,
              "nango.sessions.tags",
              "tag values must be strings",
              error(400, "invalid_body"),
            );
      }
      if (
        input.webhook_url_override !== undefined &&
        options.allowWebhookUrlOverride !== true
      )
        return fail(
          request,
          "nango.sessions.webhook-override",
          "webhook_url_override is not authorized for this environment",
          error(400, "invalid_body"),
        );
      if (reconnect) {
        if (typeof input.connection_id !== "string")
          return fail(
            request,
            "nango.reconnect.connection-id",
            "reconnect requires connection_id",
            error(400, "invalid_body"),
          );
        if (typeof input.integration_id !== "string")
          return fail(
            request,
            "nango.reconnect.integration-id",
            "reconnect requires integration_id",
            error(400, "invalid_body"),
          );
      }
      issued += 1;
      const token = `nango-session-token-${issued}`;
      sessions.push({
        kind: reconnect ? "reconnect" : "connect",
        token,
        body: input,
      });
      return {
        status: 201,
        body: {
          data: {
            token,
            expires_at: new Date(request.at + 30 * 60_000).toISOString(),
            connect_link: `https://connect.nango.dev/?session_token=${token}`,
          },
        },
      };
    }

    if (path === "/integrations" && request.method === "GET")
      return {
        status: 200,
        body: {
          data: integrations.map((unique_key) => ({
            unique_key,
            display_name: unique_key,
            provider: "github",
            created_at: "2026-01-02T03:04:05.000Z",
            updated_at: "2026-02-03T04:05:06.000Z",
          })),
        },
      };

    if (path === "/connections" && request.method === "GET") {
      const query = request.url.searchParams;
      const page = Number(query.get("page") ?? "0");
      const limit = Number(query.get("limit") ?? "100");
      if (!Number.isInteger(page) || page < 0)
        return fail(
          request,
          "nango.connections.page",
          `page was ${query.get("page")}`,
          error(400, "invalid_query_params"),
        );
      if (!Number.isInteger(limit) || limit < 1)
        return fail(
          request,
          "nango.connections.limit",
          `limit was ${query.get("limit")}`,
          error(400, "invalid_query_params"),
        );
      const wanted = query.get("connectionId");
      const rows = Object.entries(connections).flatMap(([key, ids]) =>
        ids.map((id) => ({
          id: 11,
          connection_id: id,
          provider: "github",
          provider_config_key: key,
          created: "2026-03-01T00:00:00.000Z",
          metadata: null,
          errors: [],
        })),
      );
      const filtered = wanted
        ? rows.filter((row) => row.connection_id === wanted)
        : rows;
      const start = page * limit;
      return {
        status: 200,
        body: { connections: filtered.slice(start, start + limit) },
      };
    }

    const single = /^\/connections\/([^/]+)$/.exec(path);
    if (single) {
      const id = decodeURIComponent(single[1]!);
      const key = request.url.searchParams.get("provider_config_key");
      if (key === null)
        return fail(
          request,
          "nango.connection.provider-config-key",
          "provider_config_key is required to disambiguate a connection id",
          error(400, "invalid_query_params"),
        );
      if (!integrations.includes(key))
        return fail(
          request,
          "nango.connection.unknown-integration",
          `unknown integration ${key}`,
          error(404, "not_found"),
        );
      if (!(connections[key] ?? []).includes(id))
        return error(404, "not_found");
      if (request.method === "DELETE") return { status: 200, body: {} };
      if (request.method !== "GET")
        return fail(
          request,
          "nango.connection.method",
          `unexpected ${request.method}`,
          error(405, "method_not_allowed"),
        );
      const refreshed =
        request.url.searchParams.get("force_refresh") === "true" ||
        request.url.searchParams.get("refresh_token") === "true";
      return {
        status: 200,
        body: {
          id: 11,
          connection_id: id,
          provider_config_key: key,
          provider: "github",
          created_at: "2026-03-01T00:00:00.000Z",
          // Documented: this read returns credentials, and can refresh them.
          credentials: {
            type: "OAUTH2",
            access_token: "CONTRACT_ACCESS_TOKEN",
            refresh_token: "CONTRACT_REFRESH_TOKEN",
            expires_at: new Date(request.at + 3_600_000).toISOString(),
            raw: { scope: "repo" },
          },
          connection_config: {},
          metadata: null,
          errors: [],
          refreshed,
        },
      };
    }

    if (path === "/proxy" || path.startsWith("/proxy/")) {
      proxied.push({
        method: request.method,
        path: path.slice("/proxy".length) || "/",
        body: request.body.toString("utf8"),
      });
      const provider = request.headers["provider-config-key"];
      const connection = request.headers["connection-id"];
      if (provider === undefined || connection === undefined)
        return fail(
          request,
          "nango.proxy.routing-headers",
          "Provider-Config-Key and Connection-Id are required",
          error(400, "invalid_headers"),
        );
      return { status: 200, body: { login: "octocat", id: 583231 } };
    }

    return error(404, "not_found");
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    violations,
    sessions,
    proxied,
    signWebhook(rawBody: string) {
      const key = options.webhookSigningKey ?? "";
      return createHmac("sha256", key).update(rawBody, "utf8").digest("hex");
    },
    close: fixture.close,
  };
}

/* ------------------------------------------------- MCP registry `/v0.1` */

export const REGISTRY_OFFICIAL_META =
  "io.modelcontextprotocol.registry/official";

export type RegistryContractEntry = {
  server: Record<string, unknown> & { name: string; version: string };
  status?: "active" | "deprecated" | "deleted";
  updatedAt?: string;
};

export type RegistryContractOptions = {
  entries: RegistryContractEntry[];
  /** Entries served per page; the client must follow `metadata.next_cursor`. */
  pageSize?: number;
  /** Bearer token demanded on every read (a private registry). */
  readToken?: string;
  /** Requests that answer with the documented problem+json outage instead. */
  outageAt?: number;
  /**
   * Spelling of the continuation marker inside `metadata`. The checked-in
   * client and the registry swarm's double both read `nextCursor`; the
   * registry's own REST examples have also been published with
   * `next_cursor`. The spelling could not be confirmed from this offline
   * host, so the double can serve either and a test records what the client
   * does with the one it does not recognise.
   */
  cursorField?: "nextCursor" | "next_cursor";
};

/**
 * Official MCP registry REST API, `/v0.1`.
 *
 * - `GET /v0.1/servers?limit=&cursor=&version=&updated_since=` returns
 *   `{ servers: [{ server, _meta }], metadata: { next_cursor, count } }`.
 * - Registry-owned state lives under the reserved
 *   `_meta["io.modelcontextprotocol.registry/official"]` namespace, which
 *   carries `status`, `isLatest` and the published/updated timestamps. A
 *   tombstone is `status: "deleted"`, not a missing row.
 * - `GET /v0.1/servers/{name}/versions` lists a server's versions; the name is
 *   percent-encoded exactly once and contains a `/`.
 * - errors use `application/problem+json`.
 */
export async function startRegistryContract(
  options: RegistryContractOptions,
): Promise<DoubleHandle & { listRequests: number }> {
  const { violations, fail } = recorder();
  const pageSize = options.pageSize ?? 2;
  let listRequests = 0;

  const problem = (status: number, detail: string): FixtureReply => ({
    status,
    headers: { "content-type": "application/problem+json" },
    body: { type: "about:blank", title: "Error", status, detail },
  });

  const fixture = await startHttpFixture((request) => {
    const segments = request.url.pathname.split("/").slice(1);
    if (segments[0] !== "v0.1")
      return fail(
        request,
        "registry.api-version",
        `path did not start with /v0.1: ${request.url.pathname}`,
        problem(404, "unknown API version"),
      );
    if (request.method !== "GET")
      return fail(
        request,
        "registry.method",
        `expected GET, saw ${request.method}`,
        problem(405, "method not allowed"),
      );
    if (!(request.headers.accept ?? "").includes("application/json"))
      return fail(
        request,
        "registry.accept",
        `Accept was ${request.headers.accept ?? "(absent)"}`,
        problem(406, "accept application/json"),
      );
    if (options.readToken !== undefined && bearer(request) !== options.readToken)
      return fail(
        request,
        "registry.auth",
        "private registry read without the configured bearer token",
        problem(401, "registry token required"),
      );

    if (segments[1] === "servers" && segments.length === 2) {
      listRequests += 1;
      if (options.outageAt === listRequests)
        return problem(503, "registry temporarily unavailable");
      const limitRaw = request.url.searchParams.get("limit");
      if (limitRaw !== null && !/^\d+$/.test(limitRaw))
        return fail(
          request,
          "registry.limit",
          `limit was ${limitRaw}`,
          problem(400, "invalid limit"),
        );
      const includeDeleted =
        request.url.searchParams.get("include_deleted") === "true";
      const cursor = request.url.searchParams.get("cursor");
      const visible = options.entries.filter(
        (entry) => includeDeleted || (entry.status ?? "active") !== "deleted",
      );
      let start = 0;
      if (cursor !== null) {
        start = visible.findIndex(
          (entry) => `${entry.server.name}:${entry.server.version}` === cursor,
        );
        if (start < 0)
          return fail(
            request,
            "registry.cursor",
            `cursor ${cursor} is not a known page boundary`,
            problem(400, "invalid cursor"),
          );
      }
      const limit = Math.min(Number(limitRaw ?? pageSize), pageSize);
      const page = visible.slice(start, start + limit);
      const next = visible[start + page.length];
      return {
        status: 200,
        body: {
          servers: page.map((entry) => ({
            server: entry.server,
            _meta: {
              [REGISTRY_OFFICIAL_META]: {
                status: entry.status ?? "active",
                publishedAt: "2026-01-01T00:00:00Z",
                updatedAt: entry.updatedAt ?? "2026-01-01T00:00:00Z",
                isLatest: true,
              },
            },
          })),
          metadata: {
            count: page.length,
            ...(next
              ? {
                  [options.cursorField ?? "nextCursor"]:
                    `${next.server.name}:${next.server.version}`,
                }
              : {}),
          },
        },
      };
    }

    if (segments[1] === "servers" && segments[3] === "versions") {
      let name: string;
      try {
        name = decodeURIComponent(segments[2]!);
      } catch {
        return fail(
          request,
          "registry.name-encoding",
          "server name was not percent-encoded exactly once",
          problem(400, "invalid name"),
        );
      }
      if (name.includes("%"))
        return fail(
          request,
          "registry.name-encoding",
          `double-encoded server name ${segments[2]}`,
          problem(400, "invalid name"),
        );
      const versions = options.entries.filter(
        (entry) => entry.server.name === name,
      );
      if (versions.length === 0) return problem(404, "unknown server");
      return {
        status: 200,
        body: {
          servers: versions.map((entry) => ({
            server: entry.server,
            _meta: {
              [REGISTRY_OFFICIAL_META]: {
                status: entry.status ?? "active",
                publishedAt: "2026-01-01T00:00:00Z",
                updatedAt: entry.updatedAt ?? "2026-01-01T00:00:00Z",
                isLatest: entry === versions[versions.length - 1],
              },
            },
          })),
          metadata: { count: versions.length },
        },
      };
    }

    return problem(404, "not found");
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    violations,
    get listRequests() {
      return listRequests;
    },
    close: fixture.close,
  };
}

/* --------------------------------------- OAuth 2.0 authorization server */

export type OauthContractOptions = {
  clientId: string;
  clientSecret?: string;
  /** Exact redirect URIs the client registered. */
  redirectUris: string[];
  /** Emitted as `iss` on the callback and in metadata; compared exactly. */
  issuer?: string;
  scopesGranted?: string[];
  /** Model Supabase Management: the request `scope` parameter is deprecated. */
  refuseRequestScope?: boolean;
  /** Resource indicator the token is bound to (RFC 8707). */
  audience?: string;
};

export type OauthContractDouble = DoubleHandle & {
  issuer: string;
  /** Authorization requests the server accepted, newest last. */
  authorizations: Array<{
    code: string;
    challenge: string;
    redirectUri: string;
    state: string;
  }>;
  /** Codes redeemed, so a replay is observable as a second entry. */
  redemptions: string[];
};

/**
 * A documented authorization server: RFC 6749 code grant, RFC 7636 S256 PKCE,
 * RFC 9207 `iss` on the callback, RFC 8414 metadata and RFC 9728 protected
 * resource metadata. It is deliberately unforgiving: a plain verifier, a
 * missing `code_challenge_method`, a `GET /token`, a JSON token request body,
 * a reused code, a mismatched redirect or a wrong client secret are all
 * refused with the documented OAuth error variant.
 */
export async function startOauthContract(
  options: OauthContractOptions,
): Promise<OauthContractDouble> {
  const { violations, fail } = recorder();
  const authorizations: OauthContractDouble["authorizations"] = [];
  const redemptions: string[] = [];
  let issued = 0;
  let origin = "";

  const oauthError = (status: number, error: string): FixtureReply => ({
    status,
    headers: { "cache-control": "no-store" },
    body: { error, error_description: `documented ${error} variant` },
  });

  const fixture = await startHttpFixture((request) => {
    const path = request.url.pathname;

    if (path === "/.well-known/oauth-authorization-server")
      return {
        status: 200,
        body: {
          issuer: options.issuer ?? origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
            "none",
          ],
        },
      };

    if (path === "/.well-known/oauth-protected-resource")
      return {
        status: 200,
        body: {
          resource: options.audience ?? origin,
          authorization_servers: [options.issuer ?? origin],
        },
      };

    if (path === "/authorize") {
      if (request.method !== "GET")
        return fail(
          request,
          "oauth.authorize.method",
          `expected GET, saw ${request.method}`,
          oauthError(405, "invalid_request"),
        );
      const query = request.url.searchParams;
      if (query.get("response_type") !== "code")
        return fail(
          request,
          "oauth.authorize.response-type",
          `response_type was ${query.get("response_type")}`,
          oauthError(400, "unsupported_response_type"),
        );
      if (query.get("client_id") !== options.clientId)
        return fail(
          request,
          "oauth.authorize.client-id",
          "unknown client_id",
          oauthError(400, "unauthorized_client"),
        );
      const redirectUri = query.get("redirect_uri") ?? "";
      if (!options.redirectUris.includes(redirectUri))
        return fail(
          request,
          "oauth.authorize.redirect-uri",
          `unregistered redirect_uri ${redirectUri}`,
          oauthError(400, "invalid_request"),
        );
      if (query.get("code_challenge_method") !== "S256")
        return fail(
          request,
          "oauth.authorize.pkce-method",
          `code_challenge_method was ${query.get("code_challenge_method")}`,
          oauthError(400, "invalid_request"),
        );
      const challenge = query.get("code_challenge") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
        return fail(
          request,
          "oauth.authorize.pkce-challenge",
          "code_challenge is not a base64url SHA-256 digest",
          oauthError(400, "invalid_request"),
        );
      const state = query.get("state") ?? "";
      if (state.length < 16)
        return fail(
          request,
          "oauth.authorize.state",
          "state is missing or too short to be unguessable",
          oauthError(400, "invalid_request"),
        );
      if (options.refuseRequestScope && query.has("scope"))
        return fail(
          request,
          "oauth.authorize.deprecated-scope",
          "the request scope parameter is deprecated for this provider",
          oauthError(400, "invalid_scope"),
        );
      issued += 1;
      const code = `contract-code-${issued}`;
      authorizations.push({ code, challenge, redirectUri, state });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      location.searchParams.set("iss", options.issuer ?? origin);
      return { status: 302, headers: { location: location.href }, body: "" };
    }

    if (path === "/token") {
      if (request.method !== "POST")
        return fail(
          request,
          "oauth.token.method",
          `expected POST, saw ${request.method}`,
          oauthError(405, "invalid_request"),
        );
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.startsWith("application/x-www-form-urlencoded"))
        return fail(
          request,
          "oauth.token.encoding",
          `token requests are form-encoded, saw ${contentType || "(absent)"}`,
          oauthError(400, "invalid_request"),
        );
      const form = formBody(request);
      if (!form)
        return fail(
          request,
          "oauth.token.body",
          "unparsable form body",
          oauthError(400, "invalid_request"),
        );
      // Client authentication: basic header or form parameters.
      let clientId = form.get("client_id") ?? undefined;
      let clientSecret = form.get("client_secret") ?? undefined;
      const basic = /^Basic (\S+)$/.exec(request.headers.authorization ?? "");
      if (basic) {
        const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
        const split = decoded.indexOf(":");
        clientId = decodeURIComponent(decoded.slice(0, split));
        clientSecret = decodeURIComponent(decoded.slice(split + 1));
      }
      if (clientId !== options.clientId)
        return fail(
          request,
          "oauth.token.client-id",
          "token request did not identify the registered client",
          oauthError(401, "invalid_client"),
        );
      if (
        options.clientSecret !== undefined &&
        clientSecret !== options.clientSecret
      )
        return fail(
          request,
          "oauth.token.client-secret",
          "wrong client secret",
          oauthError(401, "invalid_client"),
        );
      const grant = form.get("grant_type");
      if (grant === "refresh_token") {
        if (form.get("refresh_token") !== "contract-refresh-token")
          return oauthError(400, "invalid_grant");
        return {
          status: 200,
          headers: { "cache-control": "no-store" },
          body: {
            access_token: `contract-access-token-rotated-${redemptions.length}`,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "contract-refresh-token",
            scope: (options.scopesGranted ?? []).join(" "),
          },
        };
      }
      if (grant !== "authorization_code")
        return fail(
          request,
          "oauth.token.grant-type",
          `unsupported grant_type ${grant}`,
          oauthError(400, "unsupported_grant_type"),
        );
      const code = form.get("code") ?? "";
      const record = authorizations.find((entry) => entry.code === code);
      if (!record) return oauthError(400, "invalid_grant");
      if (redemptions.includes(code)) {
        // One-use: the documented response to a replayed code.
        redemptions.push(code);
        return oauthError(400, "invalid_grant");
      }
      if (form.get("redirect_uri") !== record.redirectUri)
        return fail(
          request,
          "oauth.token.redirect-uri",
          "redirect_uri did not match the authorization request",
          oauthError(400, "invalid_grant"),
        );
      const verifier = form.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
        return fail(
          request,
          "oauth.token.verifier-shape",
          "code_verifier is not a valid RFC 7636 verifier",
          oauthError(400, "invalid_grant"),
        );
      const computed = createS256(verifier);
      if (computed !== record.challenge)
        return fail(
          request,
          "oauth.token.verifier-mismatch",
          "code_verifier does not hash to the code_challenge",
          oauthError(400, "invalid_grant"),
        );
      redemptions.push(code);
      return {
        status: 200,
        headers: { "cache-control": "no-store" },
        body: {
          access_token: "contract-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "contract-refresh-token",
          scope: (options.scopesGranted ?? []).join(" "),
          ...(options.audience ? { aud: options.audience } : {}),
        },
      };
    }

    return { status: 404, body: { error: "not_found" } };
  });

  origin = fixture.origin;
  return {
    origin: fixture.origin,
    issuer: options.issuer ?? fixture.origin,
    requests: fixture.requests,
    violations,
    authorizations,
    redemptions,
    close: fixture.close,
  };
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))), computed here independently. */
export function createS256(verifier: string): string {
  return createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
