import { createHash } from "node:crypto";
import { z } from "zod";
import type { CompatibilityIssue } from "../../../../core/connectors/index.js";
import type { ApprovedDestination } from "../../binding.js";
import { destinationUrl } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  OSB_API_VERSION,
  OSB_API_VERSION_HEADER,
  OSB_ORIGINATING_IDENTITY_HEADER,
  OSB_REQUEST_IDENTITY_HEADER,
  OSB_ROUTES,
  osbCatalogSchema,
  osbBindingSchema,
  osbErrorSchema,
  osbInstanceSchema,
  osbLastOperationSchema,
  type OsbBinding,
  type OsbCatalog,
  type OsbInstance,
  type OsbLastOperation,
} from "./schemas.js";

/*
 * A read-only Open Service Broker client.
 *
 * Every request it can construct is a GET, and the five routes below are the
 * complete set. `X-Broker-API-Version` is sent on every request, as the spec
 * requires; `X-Broker-API-Request-Identity` is a fresh host-generated value;
 * and `X-Broker-API-Originating-Identity` carries a host-derived pseudonymous
 * identifier rather than a real tenant, subject or account identifier, because
 * a broker is a third party and the header is base64, not encryption.
 *
 * Responses are size-bounded and parsed with the pinned shapes. A broker's
 * `description` field is provider prose that may quote a request; it is read
 * for structure and then dropped, never surfaced.
 */

export const OSB_CLIENT_LIMITS = Object.freeze({
  maxCatalogBytes: 4 * 1024 * 1024,
  maxResponseBytes: 512 * 1024,
  requestTimeoutMs: 20_000,
});
export type OsbClientLimits = typeof OSB_CLIENT_LIMITS;

export type OsbRequestOptions = {
  signal: AbortSignal;
  /** Fresh identifier for this request; the broker may echo it into its logs. */
  requestId: string;
  /** Pseudonymous originating identity, or absent for a non-user-initiated read. */
  originatingIdentity?: string;
};

export type OsbClientOptions = {
  destination: ApprovedDestination;
  fetch: typeof fetch;
  /** Produces the Authorization header value inside a credential-use callback. */
  authorization: () => Promise<string | undefined>;
  limits?: Partial<OsbClientLimits>;
  now?: () => number;
};

export type OsbResponse<T> = {
  value: T;
  status: number;
  fetchedAt: number;
  issues: CompatibilityIssue[];
};

/**
 * The value of `X-Broker-API-Originating-Identity`. The platform name is
 * `ceremony`; the payload is a stable pseudonym derived from the host tenant
 * and subject, so a broker can correlate its own audit trail without learning
 * a host identifier it has no business holding.
 */
export function originatingIdentity(actor: {
  tenantId: string;
  subjectId: string;
}): string {
  const pseudonym = createHash("sha256")
    .update(
      [actor.tenantId, actor.subjectId]
        .map((part) => `${part.length}:${part}`)
        .join("|"),
    )
    .digest("hex")
    .slice(0, 32);
  const json = JSON.stringify({ user_id: pseudonym });
  return `ceremony ${Buffer.from(json, "utf8").toString("base64")}`;
}

/** Basic authentication as the spec's default platform-to-broker mechanism. */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function statusError(status: number, route: string): ConnectorError {
  if (status === 401)
    return new ConnectorError("unauthenticated", {
      detail: "osb.unauthorized",
    });
  if (status === 403)
    return new ConnectorError("denied", { detail: "osb.forbidden" });
  if (status === 404)
    return new ConnectorError("not-found", { detail: "osb.not-found" });
  if (status === 410)
    return new ConnectorError("expired", { detail: "osb.gone" });
  if (status === 412)
    /*
     * The broker rejected this platform's declared API version. That is a
     * version-matrix fact, not a transient failure, and it is reported as
     * unsupported rather than retried against a different version.
     */
    return new ConnectorError("unsupported", {
      detail: "osb.api-version-rejected",
    });
  if (status === 422)
    return new ConnectorError("conflict", { detail: "osb.concurrency" });
  if (status === 429) return new ConnectorError("rate-limited");
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "osb.upstream",
    });
  return new ConnectorError("upstream-rejected", {
    detail:
      route === OSB_ROUTES.catalog
        ? "osb.catalog.rejected"
        : "osb.request.rejected",
  });
}

export function createOpenServiceBrokerClient(options: OsbClientOptions) {
  const limits: OsbClientLimits = { ...OSB_CLIENT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;

  async function get<T>(
    route: string,
    schema: z.ZodType<T>,
    request: OsbRequestOptions,
    input: { query?: Record<string, string>; maxBytes?: number } = {},
  ): Promise<OsbResponse<T>> {
    const url = destinationUrl(options.destination, route);
    for (const [key, value] of Object.entries(input.query ?? {}))
      if (value) url.searchParams.set(key, value);
    const authorization = await options.authorization();
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, limits.requestTimeoutMs);
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          [OSB_API_VERSION_HEADER]: OSB_API_VERSION,
          [OSB_REQUEST_IDENTITY_HEADER]: request.requestId,
          ...(request.originatingIdentity
            ? { [OSB_ORIGINATING_IDENTITY_HEADER]: request.originatingIdentity }
            : {}),
          ...(authorization ? { authorization } : {}),
        },
      });
    } catch (error) {
      throw new ConnectorError(
        request.signal.aborted ? "cancelled" : "upstream-unavailable",
        { detail: "osb.unreachable", cause: error },
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    }

    const maxBytes = input.maxBytes ?? limits.maxResponseBytes;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectorError("upstream-rejected", {
        detail: "osb.response.oversized",
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes)
      throw new ConnectorError("upstream-rejected", {
        detail: "osb.response.oversized",
      });
    let body: unknown;
    if (buffer.byteLength > 0) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new ConnectorError("upstream-rejected", {
          detail: "osb.response.encoding",
        });
      }
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        if (response.ok)
          throw new ConnectorError("upstream-rejected", {
            detail: "osb.response.invalid",
          });
        body = undefined;
      }
    }

    if (!response.ok) {
      // Parsed only so a documented error code can steer the mapping; the
      // broker's own `description` text is never carried out of here.
      const parsedError = osbErrorSchema.safeParse(body);
      if (parsedError.success && parsedError.data.error === "ConcurrencyError")
        throw new ConnectorError("conflict", { detail: "osb.concurrency" });
      throw statusError(response.status, route);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "osb.response.invalid",
      });
    return {
      value: parsed.data,
      status: response.status,
      fetchedAt: now(),
      issues: [],
    };
  }

  return {
    limits,
    destination: options.destination,
    /** `GET /v2/catalog`. */
    async catalog(
      request: OsbRequestOptions,
    ): Promise<OsbResponse<OsbCatalog>> {
      return get(OSB_ROUTES.catalog, osbCatalogSchema, request, {
        maxBytes: limits.maxCatalogBytes,
      });
    },
    /** `GET /v2/service_instances/:instance_id`; only ever called when the offering declares it retrievable. */
    async fetchInstance(
      input: { instanceId: string; serviceId?: string; planId?: string },
      request: OsbRequestOptions,
    ): Promise<OsbResponse<OsbInstance>> {
      return get(
        OSB_ROUTES.instance(input.instanceId),
        osbInstanceSchema,
        request,
        {
          query: {
            ...(input.serviceId ? { service_id: input.serviceId } : {}),
            ...(input.planId ? { plan_id: input.planId } : {}),
          },
        },
      );
    },
    /** `GET /v2/service_instances/:instance_id/last_operation`. */
    async instanceLastOperation(
      input: {
        instanceId: string;
        serviceId?: string;
        planId?: string;
        operation?: string;
      },
      request: OsbRequestOptions,
    ): Promise<OsbResponse<OsbLastOperation>> {
      return get(
        OSB_ROUTES.instanceLastOperation(input.instanceId),
        osbLastOperationSchema,
        request,
        {
          query: {
            ...(input.serviceId ? { service_id: input.serviceId } : {}),
            ...(input.planId ? { plan_id: input.planId } : {}),
            ...(input.operation ? { operation: input.operation } : {}),
          },
        },
      );
    },
    /** `GET /v2/service_instances/:instance_id/service_bindings/:binding_id`. */
    async fetchBinding(
      input: {
        instanceId: string;
        bindingId: string;
        serviceId?: string;
        planId?: string;
      },
      request: OsbRequestOptions,
    ): Promise<OsbResponse<OsbBinding>> {
      return get(
        OSB_ROUTES.binding(input.instanceId, input.bindingId),
        osbBindingSchema,
        request,
        {
          query: {
            ...(input.serviceId ? { service_id: input.serviceId } : {}),
            ...(input.planId ? { plan_id: input.planId } : {}),
          },
        },
      );
    },
    /** `GET .../service_bindings/:binding_id/last_operation`. */
    async bindingLastOperation(
      input: {
        instanceId: string;
        bindingId: string;
        serviceId?: string;
        planId?: string;
        operation?: string;
      },
      request: OsbRequestOptions,
    ): Promise<OsbResponse<OsbLastOperation>> {
      return get(
        OSB_ROUTES.bindingLastOperation(input.instanceId, input.bindingId),
        osbLastOperationSchema,
        request,
        {
          query: {
            ...(input.serviceId ? { service_id: input.serviceId } : {}),
            ...(input.planId ? { plan_id: input.planId } : {}),
            ...(input.operation ? { operation: input.operation } : {}),
          },
        },
      );
    },
  };
}

export type OpenServiceBrokerClient = ReturnType<
  typeof createOpenServiceBrokerClient
>;
