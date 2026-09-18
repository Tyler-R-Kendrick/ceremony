import { ConnectorError } from "../../errors.js";
import {
  DEFAULT_GOOGLE_CONNECTORS_JSON_BOUNDS,
  parseBoundedJsonBytes,
  type JsonBounds,
} from "./json.js";
import {
  adminConnectionPath,
  adminConnectionsPath,
  connectionResourceName,
  runtimeConnectionPath,
  schemaNameSchema,
  segment,
  type ConnectionResource,
} from "./resources.js";
import {
  checkStatusResponseSchema,
  connectionSchema,
  entitySchema,
  executeActionResponseSchema,
  googleErrorSchema,
  listActionsMetadataResponseSchema,
  listConnectionsResponseSchema,
  listEntitiesResponseSchema,
  listEntityTypesMetadataResponseSchema,
  runtimeActionSchema,
  runtimeEntitySchema,
  runtimeListActionsResponseSchema,
  runtimeListEntityTypesResponseSchema,
  type GoogleConnection,
  type RuntimeActionSchema,
  type RuntimeEntitySchema,
} from "./schemas.js";

/*
 * The Integration Connectors client: the documented administrative reads on
 * `v1` and the documented runtime operations on `v2`.
 *
 * Two things are deliberately absent. There is no way to pass a resource name
 * in from outside — every path is built from the `ConnectionResource` the
 * binding approved — and there is no way to set `executionConfig.headers`.
 * That header field is the connector's auth-override and managed-connection
 * channel; a caller that could set it could make a connection act as another
 * identity, which is precisely the confusion a connector binding exists to
 * prevent.
 */

export type GoogleConnectorsLimits = {
  pageSize: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  json: JsonBounds;
};

export const DEFAULT_GOOGLE_CONNECTORS_LIMITS: GoogleConnectorsLimits =
  Object.freeze({
    pageSize: 50,
    maxResponseBytes: 8 * 1024 * 1024,
    requestTimeoutMs: 30_000,
    json: DEFAULT_GOOGLE_CONNECTORS_JSON_BOUNDS,
  });

export type GoogleConnectorsClientOptions = {
  /** Exact origin (and optional prefix) of the approved administrative destination. */
  adminBaseUrl: string;
  /** Exact origin of the approved runtime destination; may be the same host or a regional one. */
  runtimeBaseUrl: string;
  fetch: typeof fetch;
  now: () => number;
  /** Resolves the OAuth access token privately at call time. */
  token: () => Promise<string | undefined>;
  limits?: Partial<GoogleConnectorsLimits>;
  userAgent?: string;
};

/** The call reached Google but its outcome is unknown; only a journal may decide what that means. */
export class GoogleTransportUncertain extends Error {
  constructor(readonly detail: string) {
    super("Connector call outcome is uncertain");
    this.name = "GoogleTransportUncertain";
  }
}

export function googleError(
  status: number,
  googleStatus: string | undefined,
): ConnectorError {
  switch (googleStatus) {
    case "PERMISSION_DENIED":
      return new ConnectorError("denied", {
        detail: "google-connectors.permission-denied",
      });
    case "UNAUTHENTICATED":
      return new ConnectorError("expired", {
        detail: "google-connectors.credentials.rejected",
      });
    case "NOT_FOUND":
      return new ConnectorError("not-found", {
        detail: "google-connectors.not-found",
      });
    case "RESOURCE_EXHAUSTED":
      return new ConnectorError("rate-limited", {
        detail: "google-connectors.quota",
      });
    case "FAILED_PRECONDITION":
      return new ConnectorError("conflict", {
        detail: "google-connectors.precondition",
      });
    case "INVALID_ARGUMENT":
      return new ConnectorError("upstream-rejected", {
        detail: "google-connectors.invalid-argument",
      });
    default:
      break;
  }
  if (status === 401)
    return new ConnectorError("expired", {
      detail: "google-connectors.credentials.rejected",
    });
  if (status === 403)
    return new ConnectorError("denied", {
      detail: "google-connectors.permission-denied",
    });
  if (status === 404)
    return new ConnectorError("not-found", {
      detail: "google-connectors.not-found",
    });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "google-connectors.quota",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "google-connectors.upstream-status",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "google-connectors.rejected",
  });
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
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
        detail: "google-connectors.response.oversized",
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

export type EntityPage = {
  entities: Array<{ name?: string; fields?: Record<string, unknown> }>;
  nextPageToken?: string;
};

export type GoogleConnectorsClient = ReturnType<
  typeof createGoogleConnectorsClient
>;

export function createGoogleConnectorsClient(
  options: GoogleConnectorsClientOptions,
) {
  const limits: GoogleConnectorsLimits = {
    ...DEFAULT_GOOGLE_CONNECTORS_LIMITS,
    ...options.limits,
  };
  const admin = options.adminBaseUrl.replace(/\/+$/, "");
  const runtime = options.runtimeBaseUrl.replace(/\/+$/, "");

  async function request(
    base: string,
    path: string,
    init: {
      method: "GET" | "POST";
      query?: Record<string, string | string[] | undefined>;
      body?: unknown;
      signal?: AbortSignal;
      /** A write whose outcome must be treated as uncertain when the transport fails. */
      consequential?: boolean;
    },
  ): Promise<unknown> {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const item of value) url.searchParams.append(name, item);
      else url.searchParams.set(name, value);
    }
    const token = await options.token();
    if (!token)
      throw new ConnectorError("configuration-required", {
        detail: "google-connectors.credentials.missing",
      });
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent":
        options.userAgent ?? "ceremony-connectors-google-integration/1.0.0",
    };
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    if (body !== undefined) headers["content-type"] = "application/json";
    const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: init.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw new ConnectorError("cancelled");
      if (init.consequential)
        throw new GoogleTransportUncertain(
          timeout.aborted
            ? "google-connectors.timeout"
            : "google-connectors.network",
        );
      if (timeout.aborted)
        throw new ConnectorError("upstream-unavailable", {
          detail: "google-connectors.timeout",
          cause: error,
        });
      throw new ConnectorError("upstream-unavailable", {
        detail: "google-connectors.network",
        cause: error,
      });
    }
    const bytes = await readBounded(response, limits.maxResponseBytes);
    if (!response.ok) {
      let status: string | undefined;
      if (bytes.byteLength)
        try {
          status = googleErrorSchema.safeParse(
            parseBoundedJsonBytes(bytes, limits.json),
          ).data?.error?.status;
        } catch {
          status = undefined;
        }
      if (init.consequential && response.status >= 500)
        throw new GoogleTransportUncertain(
          "google-connectors.upstream-status",
        );
      throw googleError(response.status, status);
    }
    if (bytes.byteLength === 0) return {};
    return parseBoundedJsonBytes(bytes, limits.json);
  }

  const paging = (input: {
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  }) => ({
    pageSize: String(input.pageSize ?? limits.pageSize),
    ...(input.pageToken ? { pageToken: input.pageToken } : {}),
  });

  return {
    limits,
    /** `GET /v1/projects/{p}/locations/{l}/connections` */
    async listConnections(
      scope: Pick<ConnectionResource, "project" | "location">,
      input: {
        pageSize?: number | undefined;
        pageToken?: string | undefined;
        filter?: string | undefined;
      } = {},
      call: { signal?: AbortSignal } = {},
    ): Promise<{
      connections: GoogleConnection[];
      nextPageToken?: string;
      unreachable: string[];
      skipped: number;
    }> {
      const value = await request(admin, adminConnectionsPath(scope), {
        method: "GET",
        query: {
          ...paging(input),
          ...(input.filter ? { filter: input.filter } : {}),
        },
        ...(call.signal ? { signal: call.signal } : {}),
      });
      const parsed = listConnectionsResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.list-connections.shape",
        });
      const connections: GoogleConnection[] = [];
      let skipped = 0;
      for (const raw of parsed.data.connections) {
        const connection = connectionSchema.safeParse(raw);
        if (connection.success) connections.push(connection.data);
        else skipped++;
      }
      return {
        connections,
        ...(parsed.data.nextPageToken
          ? { nextPageToken: parsed.data.nextPageToken }
          : {}),
        unreachable: parsed.data.unreachable ?? [],
        skipped,
      };
    },
    /** `GET /v1/projects/{p}/locations/{l}/connections/{c}` */
    async getConnection(
      resource: ConnectionResource,
      call: { signal?: AbortSignal } = {},
    ): Promise<GoogleConnection> {
      const value = await request(admin, adminConnectionPath(resource), {
        method: "GET",
        ...(call.signal ? { signal: call.signal } : {}),
      });
      const parsed = connectionSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.get-connection.shape",
        });
      return parsed.data;
    },
    /** `GET .../connectionSchemaMetadata:listEntityTypes` */
    async listEntityTypeMetadata(
      resource: ConnectionResource,
      input: {
        pageSize?: number | undefined;
        pageToken?: string | undefined;
        filter?: string | undefined;
      } = {},
      call: { signal?: AbortSignal } = {},
    ): Promise<{ entityTypes: RuntimeEntitySchema[]; nextPageToken?: string }> {
      const value = await request(
        admin,
        `${adminConnectionPath(resource)}/connectionSchemaMetadata:listEntityTypes`,
        {
          method: "GET",
          query: {
            ...paging(input),
            ...(input.filter ? { filter: input.filter } : {}),
          },
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      const parsed = listEntityTypesMetadataResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.list-entity-types.shape",
        });
      const entityTypes: RuntimeEntitySchema[] = [];
      for (const raw of parsed.data.entityTypes) {
        const entity = runtimeEntitySchema.safeParse(raw);
        if (entity.success) entityTypes.push(entity.data);
      }
      return {
        entityTypes,
        ...(parsed.data.nextPageToken
          ? { nextPageToken: parsed.data.nextPageToken }
          : {}),
      };
    },
    /** `GET .../connectionSchemaMetadata:listActions` */
    async listActionMetadata(
      resource: ConnectionResource,
      input: {
        pageSize?: number | undefined;
        pageToken?: string | undefined;
        filter?: string | undefined;
      } = {},
      call: { signal?: AbortSignal } = {},
    ): Promise<{ actions: RuntimeActionSchema[]; nextPageToken?: string }> {
      const value = await request(
        admin,
        `${adminConnectionPath(resource)}/connectionSchemaMetadata:listActions`,
        {
          method: "GET",
          query: {
            ...paging(input),
            ...(input.filter ? { filter: input.filter } : {}),
          },
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      const parsed = listActionsMetadataResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.list-actions.shape",
        });
      const actions: RuntimeActionSchema[] = [];
      for (const raw of parsed.data.actions) {
        const action = runtimeActionSchema.safeParse(raw);
        if (action.success) actions.push(action.data);
      }
      return {
        actions,
        ...(parsed.data.nextPageToken
          ? { nextPageToken: parsed.data.nextPageToken }
          : {}),
      };
    },
    /** `GET /v2/.../entityTypes`; reports the entity types the connector cannot represent. */
    async listRuntimeEntityTypes(
      resource: ConnectionResource,
      input: {
        pageSize?: number | undefined;
        pageToken?: string | undefined;
      } = {},
      call: { signal?: AbortSignal } = {},
    ): Promise<{
      types: Array<{ name?: string; operations?: string[] }>;
      unsupportedTypeNames: string[];
      nextPageToken?: string;
    }> {
      const value = await request(
        runtime,
        runtimeConnectionPath(resource, "/entityTypes"),
        {
          method: "GET",
          query: paging(input),
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      const parsed = runtimeListEntityTypesResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.runtime-entity-types.shape",
        });
      return {
        types: parsed.data.types.map((raw) => {
          const record = (raw ?? {}) as Record<string, unknown>;
          return {
            ...(typeof record["name"] === "string"
              ? { name: record["name"] }
              : {}),
            ...(Array.isArray(record["operations"])
              ? {
                  operations: record["operations"].filter(
                    (item): item is string => typeof item === "string",
                  ),
                }
              : {}),
          };
        }),
        unsupportedTypeNames: parsed.data.unsupportedTypeNames ?? [],
        ...(parsed.data.nextPageToken
          ? { nextPageToken: parsed.data.nextPageToken }
          : {}),
      };
    },
    /** `GET /v2/.../actions`; reports the actions the connector cannot represent. */
    async listRuntimeActions(
      resource: ConnectionResource,
      input: {
        pageSize?: number | undefined;
        pageToken?: string | undefined;
      } = {},
      call: { signal?: AbortSignal } = {},
    ): Promise<{
      actions: Array<{ name?: string }>;
      unsupportedActionNames: string[];
      nextPageToken?: string;
    }> {
      const value = await request(
        runtime,
        runtimeConnectionPath(resource, "/actions"),
        {
          method: "GET",
          query: paging(input),
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      const parsed = runtimeListActionsResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.runtime-actions.shape",
        });
      return {
        actions: parsed.data.actions.map((raw) => {
          const record = (raw ?? {}) as Record<string, unknown>;
          return typeof record["name"] === "string"
            ? { name: record["name"] }
            : {};
        }),
        unsupportedActionNames: parsed.data.unsupportedActionNames ?? [],
        ...(parsed.data.nextPageToken
          ? { nextPageToken: parsed.data.nextPageToken }
          : {}),
      };
    },
    /** `GET /v2/.../entityTypes/{entityType}/entities` with the documented paging and ordering. */
    async listEntities(
      resource: ConnectionResource,
      entityType: string,
      input: {
        pageSize?: number | undefined;
        pageToken?: string | undefined;
        sortBy?: string[] | undefined;
        sortOrder?: string | undefined;
        conditions?: string | undefined;
      } = {},
      call: { signal?: AbortSignal } = {},
    ): Promise<EntityPage> {
      const name = schemaNameSchema.safeParse(entityType);
      if (!name.success)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.entity-type.invalid",
        });
      const value = await request(
        runtime,
        runtimeConnectionPath(
          resource,
          `/entityTypes/${segment(name.data)}/entities`,
        ),
        {
          method: "GET",
          query: {
            ...paging(input),
            ...(input.conditions ? { conditions: input.conditions } : {}),
            ...(input.sortOrder ? { sortOrder: input.sortOrder } : {}),
            ...(input.sortBy && input.sortBy.length > 0
              ? { sortBy: input.sortBy }
              : {}),
          },
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      const parsed = listEntitiesResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.list-entities.shape",
        });
      return {
        entities: parsed.data.entities.map((entity) => ({
          ...(entity.name ? { name: entity.name } : {}),
          ...(entity.fields ? { fields: entity.fields } : {}),
        })),
        ...(parsed.data.nextPageToken
          ? { nextPageToken: parsed.data.nextPageToken }
          : {}),
      };
    },
    /** `GET /v2/.../entityTypes/{entityType}/entities/{id}` */
    async getEntity(
      resource: ConnectionResource,
      entityType: string,
      entityId: string,
      call: { signal?: AbortSignal } = {},
    ): Promise<{ name?: string; fields?: Record<string, unknown> }> {
      const name = schemaNameSchema.safeParse(entityType);
      if (!name.success)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.entity-type.invalid",
        });
      const value = await request(
        runtime,
        runtimeConnectionPath(
          resource,
          `/entityTypes/${segment(name.data)}/entities/${segment(entityId)}`,
        ),
        { method: "GET", ...(call.signal ? { signal: call.signal } : {}) },
      );
      const parsed = entitySchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.get-entity.shape",
        });
      return {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.fields ? { fields: parsed.data.fields } : {}),
      };
    },
    /** `POST /v2/.../actions/{action}:execute` with the caller's validated parameters only. */
    async executeAction(
      resource: ConnectionResource,
      action: string,
      parameters: Record<string, unknown>,
      call: { signal?: AbortSignal } = {},
    ): Promise<{ results: unknown[] }> {
      const name = schemaNameSchema.safeParse(action);
      if (!name.success)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.action.invalid",
        });
      const value = await request(
        runtime,
        runtimeConnectionPath(
          resource,
          `/actions/${segment(name.data)}:execute`,
        ),
        {
          method: "POST",
          body: { parameters },
          consequential: true,
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      const parsed = executeActionResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.execute-action.shape",
        });
      return { results: parsed.data.results ?? [] };
    },
    /** `GET /v2/.../connections/{c}:checkStatus` */
    async checkStatus(
      resource: ConnectionResource,
      call: { signal?: AbortSignal } = {},
    ): Promise<{ state: string; description?: string }> {
      const value = await request(
        runtime,
        runtimeConnectionPath(resource, ":checkStatus"),
        { method: "GET", ...(call.signal ? { signal: call.signal } : {}) },
      );
      const parsed = checkStatusResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "google-connectors.check-status.shape",
        });
      return {
        state: parsed.data.state,
        ...(parsed.data.description
          ? { description: parsed.data.description }
          : {}),
      };
    },
    /** The resource name a call would use; for assertions and audit, never for routing. */
    resourceName: connectionResourceName,
  };
}
