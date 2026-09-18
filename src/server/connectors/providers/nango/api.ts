import { z } from "zod";
import { encodePathSegment } from "../../../../core/connectors/index.js";
import { destinationUrl, type ApprovedDestination } from "../../binding.js";
import { ConnectorError, type ConnectorErrorCode } from "../../errors.js";
import {
  actionAsyncSchema,
  connectSessionSchema,
  connectionFullAllowlistSchema,
  connectionListSchema,
  functionListSchema,
  integrationFullSchema,
  integrationListSchema,
  NANGO_LIMITS,
  recordsPageSchema,
  stdErrorSchema,
  successSchema,
  syncStatusSchema,
  type NangoTags,
} from "./schemas.js";

/*
 * The Nango HTTP client. Every request goes through the approved `api`
 * destination, carries the Environment API key as a Bearer token and nothing
 * else the caller chose, follows no redirects, and is bounded by a deadline,
 * the caller's abort signal and a response-size ceiling. Failures become
 * ConnectorError codes; upstream bodies are read only to classify them and
 * are never attached to an error, because a Nango error body can echo a
 * connection id or a provider message.
 */

export type NangoApiOptions = {
  fetch: typeof fetch;
  destination: ApprovedDestination;
  secret: () => Promise<string>;
  signal: AbortSignal;
  now: () => number;
  /** Per tenant+authority cool-down shared across calls; never crosses tenants. */
  cooldown: CooldownRegistry;
  cooldownKey: string;
};

export type RawResponse = {
  status: number;
  headers: Headers;
  body: Uint8Array;
  json: unknown | undefined;
};

/** Remembers a 429 `Retry-After` per tenant/authority so later calls fail fast instead of piling on. */
export class CooldownRegistry {
  private readonly until = new Map<string, number>();
  check(key: string, now: number): void {
    const until = this.until.get(key);
    if (until !== undefined && until > now)
      throw new ConnectorError("rate-limited", {
        detail: "nango.api.cooldown",
      });
    if (until !== undefined) this.until.delete(key);
  }
  record(key: string, headers: Headers, now: number): void {
    const retryAfter = Number(headers.get("retry-after") ?? "");
    const seconds =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 3600)
        : 1;
    this.until.set(key, now + seconds * 1000);
    if (this.until.size > 4096) {
      const first = this.until.keys().next().value;
      if (first !== undefined) this.until.delete(first);
    }
  }
}

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,40}$/;

/** Maps a Nango status (and its StdError code when safely shaped) to a bounded connector failure. */
export function nangoFailure(
  status: number,
  json: unknown,
  fallback: ConnectorErrorCode = "upstream-rejected",
): ConnectorError {
  const parsed = stdErrorSchema.safeParse(json);
  const code = parsed.success ? parsed.data.error.code : undefined;
  const suffix =
    code && SAFE_ERROR_CODE.test(code) ? code.replaceAll("_", "-") : undefined;
  const detail = (base: string) =>
    suffix ? `${base}.${suffix}`.slice(0, 120) : base;
  if (status === 401)
    return new ConnectorError("configuration-required", {
      detail: detail("nango.api.unauthorized"),
    });
  if (status === 403)
    return new ConnectorError("denied", {
      detail: detail("nango.api.forbidden"),
    });
  if (status === 404)
    return new ConnectorError("not-found", {
      detail: detail("nango.api.not-found"),
    });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "nango.api.rate-limited",
    });
  if (status === 424)
    return new ConnectorError("upstream-rejected", {
      detail: detail("nango.api.dependency-failed"),
    });
  if (status === 400 || status === 422)
    return new ConnectorError("invalid-request", {
      detail: detail("nango.api.bad-request"),
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "nango.api.server-error",
    });
  return new ConnectorError(fallback, { detail: detail("nango.api.rejected") });
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ConnectorError("upstream-rejected", {
        detail: "nango.response.too-large",
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseJson(bytes: Uint8Array, contentType: string | null): unknown {
  if (!contentType || !/json/i.test(contentType) || bytes.byteLength === 0)
    return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export class NangoApi {
  constructor(private readonly options: NangoApiOptions) {}

  private url(path: string, query?: URLSearchParams): URL {
    const url = destinationUrl(this.options.destination, path);
    if (query) url.search = query.toString();
    return url;
  }

  /**
   * One bounded request. `sensitive` marks responses that must be discarded
   * as soon as their allowlisted fields are read; the caller's schema does
   * that, and this method never logs or retains the body.
   */
  async request(input: {
    method: string;
    path: string;
    query?: URLSearchParams;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: Uint8Array;
    deadlineMs?: number;
    maxBytes?: number;
  }): Promise<RawResponse> {
    const now = this.options.now();
    this.options.cooldown.check(this.options.cooldownKey, now);
    const secret = await this.options.secret();
    const headers = new Headers(input.headers);
    headers.set("authorization", `Bearer ${secret}`);
    headers.set("accept", headers.get("accept") ?? "application/json");
    let body: BodyInit | undefined;
    if (input.rawBody !== undefined) body = input.rawBody as BufferSource;
    else if (input.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(input.body);
    }
    const signal = AbortSignal.any([
      this.options.signal,
      AbortSignal.timeout(input.deadlineMs ?? NANGO_LIMITS.deadlineMs),
    ]);
    let response: Response;
    try {
      response = await this.options.fetch(this.url(input.path, input.query), {
        method: input.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal,
      });
    } catch (cause) {
      if (this.options.signal.aborted)
        throw new ConnectorError("cancelled", { cause });
      throw new ConnectorError("upstream-unavailable", {
        detail: "nango.api.unreachable",
        cause,
      });
    }
    const bytes = await readBounded(
      response,
      input.maxBytes ?? NANGO_LIMITS.responseBytes,
    );
    if (response.status === 429)
      this.options.cooldown.record(
        this.options.cooldownKey,
        response.headers,
        this.options.now(),
      );
    return {
      status: response.status,
      headers: response.headers,
      body: bytes,
      json: parseJson(bytes, response.headers.get("content-type")),
    };
  }

  private async json<T>(
    input: Parameters<NangoApi["request"]>[0],
    schema: z.ZodType<T>,
    okStatuses: number[] = [200],
  ): Promise<T> {
    const response = await this.request(input);
    if (!okStatuses.includes(response.status))
      throw nangoFailure(response.status, response.json);
    const parsed = schema.safeParse(response.json);
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "nango.response.malformed",
      });
    return parsed.data;
  }

  /* --------------------------------------------------------- integrations */

  listIntegrations() {
    return this.json(
      { method: "GET", path: "/integrations" },
      integrationListSchema,
    );
  }

  /** Never passes `include=credentials`; the integration's client secret is not this adapter's business. */
  getIntegration(uniqueKey: string) {
    return this.json(
      { method: "GET", path: `/integrations/${encodePathSegment(uniqueKey)}` },
      z.object({ data: integrationFullSchema }),
    );
  }

  listFunctions(
    uniqueKey: string,
    options: {
      type?: "sync" | "action" | "on-event";
      page: number;
      limit: number;
    },
  ) {
    const query = new URLSearchParams({
      page: String(options.page),
      limit: String(options.limit),
    });
    if (options.type) query.set("type", options.type);
    return this.json(
      {
        method: "GET",
        path: `/integrations/${encodePathSegment(uniqueKey)}/functions`,
        query,
      },
      functionListSchema,
    );
  }

  /* ------------------------------------------------------ connect sessions */

  createConnectSession(body: {
    tags: NangoTags;
    allowed_integrations: [string];
    webhook_url_override?: string;
  }) {
    return this.json(
      { method: "POST", path: "/connect/sessions", body },
      connectSessionSchema,
      [200, 201],
    );
  }

  createReconnectSession(body: {
    connection_id: string;
    integration_id: string;
    tags: NangoTags;
    webhook_url_override?: string;
  }) {
    return this.json(
      { method: "POST", path: "/connect/sessions/reconnect", body },
      connectSessionSchema,
      [200, 201],
    );
  }

  /* ---------------------------------------------------------- connections */

  /** GET /connections: metadata, tags and error flags without credentials. */
  listConnections(filter: {
    connectionId?: string;
    tags?: Record<string, string>;
    limit?: number;
    page?: number;
  }) {
    const query = new URLSearchParams();
    if (filter.connectionId) query.set("connectionId", filter.connectionId);
    for (const [key, value] of Object.entries(filter.tags ?? {}))
      query.set(`tags[${key}]`, value);
    if (filter.limit !== undefined) query.set("limit", String(filter.limit));
    if (filter.page !== undefined) query.set("page", String(filter.page));
    return this.json(
      { method: "GET", path: "/connections", query },
      connectionListSchema,
    );
  }

  /**
   * Privileged: GET /connections/{connectionId} returns credentials and may
   * refresh them. The refresh switches are sent explicitly as `false`; the
   * allowlist schema drops every credential field before returning.
   */
  async getConnectionPrivileged(
    connectionId: string,
    providerConfigKey: string,
  ) {
    const query = new URLSearchParams({
      provider_config_key: providerConfigKey,
      force_refresh: "false",
      refresh_token: "false",
    });
    const response = await this.request({
      method: "GET",
      path: `/connections/${encodePathSegment(connectionId)}`,
      query,
    });
    if (response.status !== 200)
      throw nangoFailure(response.status, response.json);
    const parsed = connectionFullAllowlistSchema.safeParse(response.json);
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "nango.response.malformed",
      });
    return parsed.data;
  }

  async deleteConnection(connectionId: string, providerConfigKey: string) {
    const response = await this.request({
      method: "DELETE",
      path: `/connections/${encodePathSegment(connectionId)}`,
      query: new URLSearchParams({ provider_config_key: providerConfigKey }),
    });
    if (response.status === 404) return { success: true, alreadyGone: true };
    if (response.status !== 200 && response.status !== 204)
      throw nangoFailure(response.status, response.json);
    const parsed = successSchema.safeParse(response.json ?? {});
    return {
      success: parsed.success ? parsed.data.success !== false : true,
      alreadyGone: false,
    };
  }

  /* --------------------------------------------------------- proxy/actions */

  /** Raw proxy call; the caller decides what a non-2xx means for its effect. */
  proxy(input: {
    method: string;
    path: string;
    query?: URLSearchParams;
    headers: Record<string, string>;
    body?: unknown;
    deadlineMs: number;
    maxBytes: number;
  }) {
    return this.request({
      method: input.method,
      path: input.path,
      ...(input.query ? { query: input.query } : {}),
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      deadlineMs: input.deadlineMs,
      maxBytes: input.maxBytes,
    });
  }

  triggerAction(input: {
    connectionId: string;
    providerConfigKey: string;
    actionName: string;
    input: unknown;
    deadlineMs: number;
    maxBytes: number;
  }) {
    return this.request({
      method: "POST",
      path: "/action/trigger",
      headers: {
        "connection-id": input.connectionId,
        "provider-config-key": input.providerConfigKey,
      },
      body: {
        action_name: input.actionName,
        ...(input.input === undefined ? {} : { input: input.input }),
      },
      deadlineMs: input.deadlineMs,
      maxBytes: input.maxBytes,
    });
  }

  /* ---------------------------------------------------------------- syncs */

  syncCommand(
    command: "trigger" | "start" | "pause",
    body: {
      provider_config_key: string;
      connection_id: string;
      syncs: Array<{ name: string; variant?: string }>;
    },
  ) {
    return this.request({ method: "POST", path: `/sync/${command}`, body });
  }

  syncStatus(query: {
    provider_config_key: string;
    syncs: string;
    connection_id: string;
  }) {
    return this.json(
      {
        method: "GET",
        path: "/sync/status",
        query: new URLSearchParams(query),
      },
      syncStatusSchema,
    );
  }

  records(input: {
    connectionId: string;
    providerConfigKey: string;
    model: string;
    cursor?: string;
    modifiedAfter?: string;
    limit?: number;
    filter?: "added" | "updated" | "deleted";
    variant?: string;
    maxBytes: number;
    deadlineMs: number;
  }) {
    const query = new URLSearchParams({ model: input.model });
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.modifiedAfter) query.set("modified_after", input.modifiedAfter);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.filter) query.set("filter", input.filter);
    if (input.variant) query.set("variant", input.variant);
    return this.json(
      {
        method: "GET",
        path: "/records",
        query,
        headers: {
          "connection-id": input.connectionId,
          "provider-config-key": input.providerConfigKey,
        },
        maxBytes: input.maxBytes,
        deadlineMs: input.deadlineMs,
      },
      recordsPageSchema,
    );
  }
}

export const actionAsyncResponseSchema = actionAsyncSchema;
