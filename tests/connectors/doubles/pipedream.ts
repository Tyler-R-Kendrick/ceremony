import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  startHttpFixture,
  type FixtureReply,
  type RecordedRequest,
} from "./http-fixture.js";

/*
 * An independent double of the Pipedream Connect REST API, written from the
 * published documentation (https://pipedream.com/docs/connect and its API
 * reference, managed-auth, api-proxy, components and webhooks pages, retrieved
 * 2026-09-18) and from nothing else. It never imports adapter code, so a test
 * that passes here has agreed with the documented contract rather than with
 * the implementation's opinion of it.
 *
 * Documented behaviour it enforces:
 *  - `POST /v1/oauth/token` with a JSON client-credentials body; the response
 *    is `{access_token, token_type, expires_in, created_at}` and access tokens
 *    expire after an hour.
 *  - Every `/v1/connect/...` request carries `Authorization: Bearer <token>`,
 *    and every project-scoped request carries `x-pd-environment`, which is
 *    `development` or `production`. Accounts, tokens and deployed triggers in
 *    one environment do not exist in the other.
 *  - `POST /v1/connect/{project_id}/tokens` takes `external_user_id` (max 250
 *    characters) and returns `{token: ctok_<32 hex>, expires_at,
 *    connect_link_url}`. A connect token is single-use and expires within four
 *    hours.
 *  - Accounts are `apn_...`, listed project-wide or per external user, read
 *    bare by id, and deleted with `204`.
 *  - The proxy is `{METHOD} /v1/connect/{project_id}/proxy/{url_64}` with
 *    `external_user_id` and `account_id` query parameters; only apps whose
 *    metadata says `proxy_enabled` and whose `allowed_domains` contain the
 *    host may be reached; `x-pd-proxy-` headers are forwarded and the
 *    documented blocked headers are rejected with 400.
 *  - `POST /v1/connect/{project_id}/actions/run` takes the component id, the
 *    external user and `configured_props` whose app prop is
 *    `{authProvisionId: apn_...}`; it answers `{exports, os, ret}`.
 *  - `POST /v1/connect/{project_id}/triggers/deploy` creates a NEW deployed
 *    trigger every time it is called — the documentation promises no
 *    deduplication — and returns `webhook_signing_key` when a `webhook_url`
 *    was given. Deliveries are signed `t=<unix>,v1=<hmac sha256 hex>` over
 *    `${t}.${raw body}` in `x-pd-signature`.
 *  - Errors are `{"error": "..."}`; throttling is 429 with `Retry-After` and
 *    `X-RateLimit-*` headers.
 */

type Json = Record<string, unknown>;

export type DoubleApp = {
  id: string | null;
  name_slug: string;
  name: string;
  auth_type: string | null;
  description: string | null;
  img_src: string;
  custom_fields_json: string | null;
  categories: string[];
  featured_weight: number;
  scope_profiles: unknown[];
  connect: {
    proxy_enabled: boolean;
    allowed_domains: string[];
    base_proxy_target_url: string | null;
  };
};

export type DoubleEnvironment = "development" | "production";

export type DoubleAccount = {
  id: string;
  name: string | null;
  external_id: string;
  healthy: boolean;
  dead: boolean;
  app: DoubleApp;
  created_at: string;
  updated_at: string;
  authorized_scopes: string[];
  environment: DoubleEnvironment;
  credentials: Json;
};

export type DoubleConnectToken = {
  token: string;
  external_user_id: string;
  environment: DoubleEnvironment;
  allowed_origins: string[];
  success_redirect_uri?: string;
  error_redirect_uri?: string;
  webhook_uri?: string;
  expires_at: number;
  used: boolean;
};

export type DoubleTrigger = {
  id: string;
  owner_id: string;
  component_id: string;
  component_key: string;
  configured_props: Json;
  configurable_props: unknown[];
  active: boolean;
  created_at: number;
  updated_at: number;
  name: string;
  name_slug: string;
  emit_on_deploy: boolean;
  webhook_signing_key: string | null;
  webhook_url: string | null;
  external_user_id: string;
  environment: DoubleEnvironment;
};

export type ProxyCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  accountId: string;
  externalUserId: string;
  environment: DoubleEnvironment;
};

export type ActionCall = {
  id: string;
  externalUserId: string;
  environment: DoubleEnvironment;
  accountId: string | undefined;
  configuredProps: Json;
};

export type DoubleFaults = {
  /** Every /v1/connect request answers 429 with the documented body. */
  throttle: boolean;
  /** Milliseconds the run-action endpoint waits after executing, before replying. */
  actionDelayMs: number;
  /** Milliseconds the deploy endpoint waits after creating the trigger. */
  deployDelayMs: number;
  /** Status the deploy endpoint returns INSTEAD of creating a trigger. */
  deployStatus: number | undefined;
  /** Status the proxy returns instead of calling the upstream handler. */
  proxyStatus: number | undefined;
  /** Status the account listings return instead of a result. */
  accountsStatus: number | undefined;
  /** The oauth token endpoint rejects the configured secret. */
  rejectClientCredentials: boolean;
};

export type PipedreamDoubleOptions = {
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
  accessTokenLifetimeSeconds?: number;
  connectTokenLifetimeSeconds?: number;
  now?: () => number;
};

const fixture = (name: string): Json =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/pipedream/${name}`, import.meta.url),
      "utf8",
    ),
  ) as Json;

/** Documented request headers the proxy rejects with a 400. */
const blockedProxyHeaders = [
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "permissions-policy",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
];

const hexId = (bytes: number) => randomBytes(bytes).toString("hex");
const suffix = () => randomBytes(6).toString("hex");
const cursorOf = (index: number) =>
  Buffer.from(String(index), "utf8").toString("base64url");
const indexOfCursor = (cursor: string | null) => {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const error = (status: number, message: string): FixtureReply => ({
  status,
  body: { error: message },
});

export async function startPipedreamDouble(
  options: PipedreamDoubleOptions = {},
) {
  const projectId = options.projectId ?? "proj_fixture01";
  const clientId = options.clientId ?? "fixture-client-id";
  const clientSecret = options.clientSecret ?? "fixture-client-secret";
  const accessTokenLifetime =
    (options.accessTokenLifetimeSeconds ?? 3600) * 1000;
  const connectTokenLifetime =
    (options.connectTokenLifetimeSeconds ?? 4 * 60 * 60) * 1000;
  const now = options.now ?? Date.now;

  const apps = (fixture("apps.json").data as DoubleApp[]).map((app) => ({
    ...app,
  }));
  const components = fixture("components.json").data as Array<
    Json & { key: string; component_type?: string }
  >;

  const accessTokens = new Map<
    string,
    { expiresAt: number; issuedAt: number }
  >();
  const connectTokens = new Map<string, DoubleConnectToken>();
  const accounts = new Map<string, DoubleAccount>();
  const triggers = new Map<string, DoubleTrigger>();
  const proxyCalls: ProxyCall[] = [];
  const actionCalls: ActionCall[] = [];
  const deployCalls: Array<{
    id: string;
    externalUserId: string;
    environment: DoubleEnvironment;
    webhookUrl: string | null;
    configuredProps: Json;
  }> = [];
  const faults: DoubleFaults = {
    throttle: false,
    actionDelayMs: 0,
    deployDelayMs: 0,
    deployStatus: undefined,
    proxyStatus: undefined,
    accountsStatus: undefined,
    rejectClientCredentials: false,
  };
  let upstream: (call: ProxyCall) => FixtureReply = () => ({
    status: 200,
    body: { ok: true },
  });
  let actionResult: (call: ActionCall) => Json = () => ({
    exports: { $summary: "Executed" },
    os: [],
    ret: { ok: true },
  });

  const appBySlug = (slug: string) =>
    apps.find((app) => app.name_slug === slug || app.id === slug);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === "function") timer.unref();
    });

  const bearer = (request: RecordedRequest): string | undefined => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    return header.slice("Bearer ".length);
  };

  const authenticated = (request: RecordedRequest): boolean => {
    const token = bearer(request);
    if (!token) return false;
    const entry = accessTokens.get(token);
    return entry !== undefined && entry.expiresAt > now();
  };

  const environmentOf = (
    request: RecordedRequest,
  ): DoubleEnvironment | undefined => {
    const value = request.headers["x-pd-environment"];
    return value === "development" || value === "production"
      ? value
      : undefined;
  };

  const jsonBody = (request: RecordedRequest): Json | undefined => {
    if (!request.body.length) return undefined;
    try {
      const parsed: unknown = JSON.parse(request.body.toString("utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Json)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const paginate = <T>(items: T[], url: URL) => {
    const start = indexOfCursor(url.searchParams.get("after"));
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const limit =
      Number.isSafeInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100
        ? limitRaw
        : 25;
    const page = items.slice(start, start + limit);
    const end = start + page.length;
    return {
      page,
      page_info: {
        count: page.length,
        total_count: items.length,
        start_cursor: page.length ? cursorOf(start) : null,
        end_cursor: end < items.length ? cursorOf(end) : null,
      },
    };
  };

  const publicAccount = (
    account: DoubleAccount,
    includeCredentials: boolean,
  ) => {
    const { environment: _environment, credentials, ...rest } = account;
    void _environment;
    return includeCredentials ? { ...rest, credentials } : rest;
  };

  const ownedAccount = (
    id: string,
    environment: DoubleEnvironment,
  ): DoubleAccount | undefined => {
    const account = accounts.get(id);
    return account && account.environment === environment ? account : undefined;
  };

  const handler = async (request: RecordedRequest): Promise<FixtureReply> => {
    const url = request.url;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1") return error(404, "Not found");

    // POST /v1/oauth/token — the documented client-credentials grant.
    if (segments[1] === "oauth" && segments[2] === "token") {
      if (request.method !== "POST") return error(405, "Method not allowed");
      const body = jsonBody(request);
      if (!body) return error(400, "invalid_request");
      if (body.grant_type !== "client_credentials")
        return error(400, "unsupported_grant_type");
      if (
        faults.rejectClientCredentials ||
        body.client_id !== clientId ||
        body.client_secret !== clientSecret
      )
        return error(401, "invalid_client");
      const token = `pdat_${hexId(24)}`;
      const issuedAt = now();
      accessTokens.set(token, {
        issuedAt,
        expiresAt: issuedAt + accessTokenLifetime,
      });
      return {
        status: 200,
        body: {
          access_token: token,
          token_type: "Bearer",
          expires_in: Math.floor(accessTokenLifetime / 1000),
          created_at: Math.floor(issuedAt / 1000),
        },
      };
    }

    if (segments[1] !== "connect") return error(404, "Not found");
    if (!authenticated(request)) return error(401, "Unauthorized");
    if (faults.throttle)
      return {
        status: 429,
        headers: {
          "retry-after": "2",
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(now() / 1000) + 2),
        },
        body: { error: "Throttled" },
      };

    // GET /v1/connect/apps and /v1/connect/apps/{app_id} — not project scoped.
    if (segments[2] === "apps") {
      if (request.method !== "GET") return error(405, "Method not allowed");
      if (segments.length === 3) {
        const query = url.searchParams.get("q");
        const filtered = query
          ? apps.filter(
              (app) =>
                app.name.toLowerCase().includes(query.toLowerCase()) ||
                app.name_slug.includes(query.toLowerCase()),
            )
          : apps;
        const { page, page_info } = paginate(filtered, url);
        return { status: 200, body: { data: page, page_info } };
      }
      const app = appBySlug(decodeURIComponent(segments[3]!));
      return app
        ? { status: 200, body: { data: app } }
        : error(404, "App not found");
    }

    if (segments[2] !== projectId) return error(404, "Project not found");
    const environment = environmentOf(request);
    if (!environment)
      return error(400, "x-pd-environment must be development or production");
    const resource = segments[3];

    // POST /v1/connect/{project_id}/tokens
    if (resource === "tokens" && segments.length === 4) {
      if (request.method !== "POST") return error(405, "Method not allowed");
      const body = jsonBody(request);
      const externalUserId = body?.external_user_id;
      if (typeof externalUserId !== "string" || !externalUserId)
        return error(400, "external_user_id is required");
      if (externalUserId.length > 250)
        return error(400, "external_user_id is limited to 250 characters");
      const requestedTtl = Number(body?.expires_in ?? 0);
      const ttl =
        Number.isSafeInteger(requestedTtl) && requestedTtl > 0
          ? Math.min(requestedTtl * 1000, connectTokenLifetime)
          : connectTokenLifetime;
      const token = `ctok_${hexId(16)}`;
      const record: DoubleConnectToken = {
        token,
        external_user_id: externalUserId,
        environment,
        allowed_origins: Array.isArray(body?.allowed_origins)
          ? (body.allowed_origins as string[])
          : [],
        ...(typeof body?.success_redirect_uri === "string"
          ? { success_redirect_uri: body.success_redirect_uri }
          : {}),
        ...(typeof body?.error_redirect_uri === "string"
          ? { error_redirect_uri: body.error_redirect_uri }
          : {}),
        ...(typeof body?.webhook_uri === "string"
          ? { webhook_uri: body.webhook_uri }
          : {}),
        expires_at: now() + ttl,
        used: false,
      };
      connectTokens.set(token, record);
      return {
        status: 200,
        body: {
          token,
          expires_at: new Date(record.expires_at).toISOString(),
          connect_link_url: `https://pipedream.com/_static/connect.html?token=${token}&connectLink=true`,
        },
      };
    }

    // GET /v1/connect/{project_id}/accounts
    if (resource === "accounts" && segments.length === 4) {
      if (request.method !== "GET") return error(405, "Method not allowed");
      if (faults.accountsStatus !== undefined)
        return error(faults.accountsStatus, "Forbidden");
      const app = url.searchParams.get("app");
      const externalUserId = url.searchParams.get("external_user_id");
      const includeCredentials =
        url.searchParams.get("include_credentials") === "true";
      const matching = [...accounts.values()].filter(
        (account) =>
          account.environment === environment &&
          (!app || account.app.name_slug === app || account.app.id === app) &&
          (!externalUserId || account.external_id === externalUserId),
      );
      const { page, page_info } = paginate(matching, url);
      return {
        status: 200,
        body: {
          data: page.map((account) =>
            publicAccount(account, includeCredentials),
          ),
          page_info,
        },
      };
    }

    // GET | DELETE /v1/connect/{project_id}/accounts/{account_id}
    if (resource === "accounts" && segments.length === 5) {
      const account = ownedAccount(
        decodeURIComponent(segments[4]!),
        environment,
      );
      if (request.method === "GET") {
        if (!account) return error(404, "Account not found");
        // Documented as the bare Account schema, not wrapped in `data`.
        return {
          status: 200,
          body: publicAccount(
            account,
            url.searchParams.get("include_credentials") === "true",
          ) as unknown as Json,
        };
      }
      if (request.method === "DELETE") {
        if (!account) return error(404, "Account not found");
        accounts.delete(account.id);
        return { status: 204 };
      }
      return error(405, "Method not allowed");
    }

    // GET /v1/connect/{project_id}/users/{external_user_id}/accounts
    if (resource === "users" && segments[5] === "accounts") {
      if (request.method !== "GET") return error(405, "Method not allowed");
      if (faults.accountsStatus !== undefined)
        return error(faults.accountsStatus, "Forbidden");
      const externalUserId = decodeURIComponent(segments[4]!);
      const app = url.searchParams.get("app");
      const includeCredentials =
        url.searchParams.get("include_credentials") === "true";
      const matching = [...accounts.values()].filter(
        (account) =>
          account.environment === environment &&
          account.external_id === externalUserId &&
          (!app || account.app.name_slug === app || account.app.id === app),
      );
      // Documented as a bare array of accounts.
      return {
        status: 200,
        body: matching.map((account) =>
          publicAccount(account, includeCredentials),
        ) as unknown as unknown[],
      };
    }

    // {METHOD} /v1/connect/{project_id}/proxy/{url_64}
    if (resource === "proxy" && segments.length === 5) {
      const externalUserId = url.searchParams.get("external_user_id");
      const accountId = url.searchParams.get("account_id");
      if (!externalUserId || !accountId)
        return error(400, "external_user_id and account_id are required");
      const offending = Object.keys(request.headers).find(
        (name) =>
          blockedProxyHeaders.includes(name.toLowerCase()) ||
          name.toLowerCase().startsWith("proxy-") ||
          name.toLowerCase().startsWith("sec-"),
      );
      if (
        offending &&
        !["host", "connection", "content-length"].includes(offending)
      )
        return error(400, `Header not allowed: ${offending}`);
      const account = ownedAccount(accountId, environment);
      if (!account || account.external_id !== externalUserId)
        return error(404, "Account not found for this external user");
      let target: URL;
      try {
        target = new URL(
          Buffer.from(segments[4]!, "base64url").toString("utf8"),
        );
      } catch {
        return error(400, "Invalid target URL");
      }
      if (!account.app.connect.proxy_enabled)
        return error(400, "Proxy is not enabled for this app");
      if (!account.app.connect.allowed_domains.includes(target.hostname))
        return error(400, "Target domain is not allowed for this app");
      const call: ProxyCall = {
        method: request.method,
        url: target.href,
        headers: request.headers,
        body: request.body.toString("utf8"),
        accountId,
        externalUserId,
        environment,
      };
      proxyCalls.push(call);
      if (faults.proxyStatus !== undefined)
        return faults.proxyStatus === 504
          ? error(504, "Gateway timeout")
          : error(faults.proxyStatus, "Upstream error");
      return upstream(call);
    }

    // POST /v1/connect/{project_id}/actions/run
    if (resource === "actions" && segments[4] === "run") {
      if (request.method !== "POST") return error(405, "Method not allowed");
      const body = jsonBody(request);
      const id = body?.id;
      const externalUserId = body?.external_user_id;
      if (typeof id !== "string" || typeof externalUserId !== "string")
        return error(400, "id and external_user_id are required");
      const component = components.find((item) => item.key === id);
      if (!component) return error(404, "Component not found");
      const configured = (body?.configured_props ?? {}) as Json;
      const appProp = Object.values(configured).find(
        (value): value is { authProvisionId?: unknown } =>
          typeof value === "object" &&
          value !== null &&
          "authProvisionId" in (value as Json),
      );
      const accountId =
        typeof appProp?.authProvisionId === "string"
          ? appProp.authProvisionId
          : undefined;
      if (accountId) {
        const account = ownedAccount(accountId, environment);
        if (!account || account.external_id !== externalUserId)
          return error(400, "authProvisionId is not an account of this user");
      }
      const call: ActionCall = {
        id,
        externalUserId,
        environment,
        accountId,
        configuredProps: configured,
      };
      // The run happens before the reply: a client that gives up on the
      // response has still caused whatever the component did.
      actionCalls.push(call);
      const result = actionResult(call);
      if (faults.actionDelayMs) await sleep(faults.actionDelayMs);
      return { status: 200, body: result };
    }

    // GET /v1/connect/{project_id}/components[/{component_id}]
    if (resource === "components") {
      if (request.method !== "GET") return error(405, "Method not allowed");
      if (segments.length === 5) {
        const component = components.find(
          (item) => item.key === decodeURIComponent(segments[4]!),
        );
        return component
          ? { status: 200, body: { data: component } }
          : error(404, "Component not found");
      }
      const type = url.searchParams.get("component_type");
      const matching = components.filter(
        (item) => !type || item.component_type === type,
      );
      const { page, page_info } = paginate(matching, url);
      return { status: 200, body: { data: page, page_info } };
    }

    // POST /v1/connect/{project_id}/triggers/deploy
    if (resource === "triggers" && segments[4] === "deploy") {
      if (request.method !== "POST") return error(405, "Method not allowed");
      const body = jsonBody(request);
      const id = body?.id;
      const externalUserId = body?.external_user_id;
      if (typeof id !== "string" || typeof externalUserId !== "string")
        return error(400, "id and external_user_id are required");
      const component = components.find((item) => item.key === id);
      if (!component) return error(404, "Component not found");
      if (faults.deployStatus !== undefined)
        return error(faults.deployStatus, "Deploy failed");
      const configured = (body?.configured_props ?? {}) as Json;
      const webhookUrl =
        typeof body?.webhook_url === "string" ? body.webhook_url : null;
      const triggerId = `dc_${suffix()}`;
      const at = now();
      // Nothing in the documentation deduplicates a deploy: calling it twice
      // creates two triggers.
      const record: DoubleTrigger = {
        id: triggerId,
        owner_id: `exu_${suffix()}`,
        component_id: `sc_${suffix()}`,
        component_key: id,
        configured_props: configured,
        configurable_props: (component.configurable_props as unknown[]) ?? [],
        active: true,
        created_at: at,
        updated_at: at,
        name: `${component.name as string} - ${externalUserId.slice(0, 12)}`,
        name_slug: `${id}-${suffix()}`,
        emit_on_deploy: body?.emit_on_deploy === true,
        webhook_signing_key: webhookUrl ? `whsk_${hexId(16)}` : null,
        webhook_url: webhookUrl,
        external_user_id: externalUserId,
        environment,
      };
      triggers.set(triggerId, record);
      deployCalls.push({
        id,
        externalUserId,
        environment,
        webhookUrl,
        configuredProps: configured,
      });
      if (faults.deployDelayMs) await sleep(faults.deployDelayMs);
      const {
        webhook_url: _url,
        external_user_id: _user,
        environment: _environment,
        ...data
      } = record;
      void _url;
      void _user;
      void _environment;
      return { status: 200, body: { data } };
    }

    // GET /v1/connect/{project_id}/deployed-triggers[/{trigger_id}]
    if (resource === "deployed-triggers") {
      const externalUserId = url.searchParams.get("external_user_id");
      if (!externalUserId) return error(400, "external_user_id is required");
      const visible = [...triggers.values()].filter(
        (trigger) =>
          trigger.environment === environment &&
          trigger.external_user_id === externalUserId,
      );
      if (segments.length === 4) {
        if (request.method !== "GET") return error(405, "Method not allowed");
        const { page, page_info } = paginate(visible, url);
        return {
          status: 200,
          body: {
            data: page.map(
              ({
                webhook_url: _u,
                external_user_id: _e,
                environment: _v,
                ...rest
              }) => {
                void _u;
                void _e;
                void _v;
                return rest;
              },
            ),
            page_info,
          },
        };
      }
      const trigger = visible.find(
        (item) => item.id === decodeURIComponent(segments[4]!),
      );
      if (request.method === "DELETE") {
        if (!trigger) return error(404, "Deployed trigger not found");
        triggers.delete(trigger.id);
        return { status: 204 };
      }
      if (request.method === "GET") {
        if (!trigger) return error(404, "Deployed trigger not found");
        const {
          webhook_url: _u,
          external_user_id: _e,
          environment: _v,
          ...rest
        } = trigger;
        void _u;
        void _e;
        void _v;
        return { status: 200, body: { data: rest } };
      }
      return error(405, "Method not allowed");
    }

    return error(404, "Not found");
  };

  const server = await startHttpFixture(handler);

  return {
    origin: server.origin,
    requests: server.requests,
    received: server.received,
    close: server.close,
    projectId,
    clientId,
    clientSecret,
    apps,
    components,
    faults,
    counts: {
      get accessTokens() {
        return accessTokens.size;
      },
      get proxyCalls() {
        return proxyCalls.length;
      },
      get actionCalls() {
        return actionCalls.length;
      },
      get deployCalls() {
        return deployCalls.length;
      },
    },
    proxyCalls,
    actionCalls,
    deployCalls,
    accounts,
    triggers,
    connectTokens,
    accessTokens,

    /** Replaces the upstream the proxy reaches, as the provider would answer. */
    setUpstream(next: (call: ProxyCall) => FixtureReply) {
      upstream = next;
    },
    /** Replaces what a component run returns. */
    setActionResult(next: (call: ActionCall) => Json) {
      actionResult = next;
    },

    /** Seeds an already connected account, as an earlier connect flow would have. */
    seedAccount(input: {
      externalUserId: string;
      app: string;
      environment: DoubleEnvironment;
      id?: string;
      name?: string;
      healthy?: boolean;
      dead?: boolean;
      createdAt?: number;
      scopes?: string[];
    }): DoubleAccount {
      const app = appBySlug(input.app);
      if (!app) throw new Error(`Unknown fixture app: ${input.app}`);
      const at = new Date(input.createdAt ?? now()).toISOString();
      const account: DoubleAccount = {
        id: input.id ?? `apn_${suffix()}`,
        name: input.name ?? null,
        external_id: input.externalUserId,
        healthy: input.healthy ?? true,
        dead: input.dead ?? false,
        app,
        created_at: at,
        updated_at: at,
        authorized_scopes: input.scopes ?? [],
        environment: input.environment,
        credentials: {
          oauth_client_id: "fixture-oauth-client",
          oauth_access_token: `fixture-provider-token-${suffix()}`,
          oauth_refresh_token: `fixture-provider-refresh-${suffix()}`,
          oauth_uid: "provider-uid",
        },
      };
      accounts.set(account.id, account);
      return account;
    },

    /**
     * Completes a connect token the way the hosted Connect flow would: the
     * token is consumed, and the account is saved for that token's external
     * user in that token's environment.
     */
    completeConnect(
      token: string,
      input: { app: string; id?: string; name?: string },
    ): DoubleAccount {
      const record = connectTokens.get(token);
      if (!record) throw new Error("Unknown connect token");
      if (record.used) throw new Error("Connect token has already been used");
      if (record.expires_at <= now()) throw new Error("Connect token expired");
      record.used = true;
      return this.seedAccount({
        externalUserId: record.external_user_id,
        environment: record.environment,
        app: input.app,
        ...(input.id ? { id: input.id } : {}),
        ...(input.name ? { name: input.name } : {}),
      });
    },

    /** The documented CONNECTION_SUCCESS payload for a completed token. */
    connectionWebhookPayload(token: string, account: DoubleAccount): Json {
      const record = connectTokens.get(token);
      if (!record) throw new Error("Unknown connect token");
      const {
        environment: _environment,
        credentials: _credentials,
        ...rest
      } = account;
      void _environment;
      void _credentials;
      return {
        event: "CONNECTION_SUCCESS",
        connect_token: token,
        environment: record.environment,
        connect_session_id: 140587280838728540000000000000000000000,
        account: rest,
      };
    },

    /** The documented CONNECTION_ERROR payload. */
    connectionErrorPayload(token: string, message: string): Json {
      const record = connectTokens.get(token);
      if (!record) throw new Error("Unknown connect token");
      return {
        event: "CONNECTION_ERROR",
        connect_token: token,
        environment: record.environment,
        connect_session_id: 140587273153596770000000000000000000000,
        error: message,
      };
    },

    /**
     * Signs a delivery the way Pipedream documents it:
     * `x-pd-signature: t=<unix seconds>,v1=<hex hmac sha256 of `${t}.${body}`>`.
     */
    signDelivery(
      signingKey: string,
      body: string,
      timestampSeconds = Math.floor(now() / 1000),
    ): { header: string; body: string } {
      const digest = createHmac("sha256", signingKey)
        .update(`${timestampSeconds}.${body}`)
        .digest("hex");
      return { header: `t=${timestampSeconds},v1=${digest}`, body };
    },

    /** A correlation id for a fresh fixture run. */
    uuid: () => randomUUID(),
  };
}

export type PipedreamDouble = Awaited<ReturnType<typeof startPipedreamDouble>>;
