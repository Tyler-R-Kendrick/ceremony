import { startHttpFixture, type FixtureReply } from "./http-fixture.js";

/*
 * A loopback double of Google Cloud Integration Connectors, written from the
 * service's own discovery documents at revision 20260907 (fetched 2026-09-18
 * from https://connectors.googleapis.com/$discovery/rest?version=v1 and
 * ?version=v2) rather than from the client under test:
 *
 *   GET  /v1/projects/{p}/locations/{l}/connections            -> ListConnectionsResponse
 *   GET  /v1/projects/{p}/locations/{l}/connections/{c}        -> Connection
 *   GET  /v1/.../connections/{c}/connectionSchemaMetadata:listEntityTypes
 *   GET  /v1/.../connections/{c}/connectionSchemaMetadata:listActions
 *   GET  /v2/.../connections/{c}/entityTypes                   -> ListEntityTypesResponse
 *   GET  /v2/.../connections/{c}/entityTypes/{e}/entities      -> ListEntitiesResponse
 *   GET  /v2/.../connections/{c}/entityTypes/{e}/entities/{id} -> Entity
 *   GET  /v2/.../connections/{c}/actions                       -> ListActionsResponse
 *   POST /v2/.../connections/{c}/actions/{a}:execute           -> ExecuteActionResponse
 *   GET  /v2/.../connections/{c}:checkStatus                   -> CheckStatusResponse
 *
 * Errors use the documented google.rpc status names. The double is strict
 * about the things that matter for authority: the bearer token, the exact
 * project/location/connection in the path, and the absence of any
 * `executionConfig` in a request — that field is the connector's
 * auth-override channel and no Ceremony call may carry it.
 */

export type DoubleGoogleResource = {
  project: string;
  location: string;
  connection: string;
};

export type DoubleGoogleConnection = {
  description?: string;
  state?:
    | "ACTIVE"
    | "INACTIVE"
    | "ERROR"
    | "CREATING"
    | "UPDATING"
    | "AUTHORIZATION_REQUIRED";
  connectorVersion?: string;
  serviceAccount?: string;
  suspended?: boolean;
  asyncOperationsEnabled?: boolean;
  authOverrideEnabled?: boolean;
  fallbackOnAdminCredentials?: boolean;
  eventingEnablementType?: string;
  serviceDirectory?: string;
  connectionRevision?: string;
};

export type DoubleEntityType = {
  entity: string;
  operations?: string[];
  fields?: Array<{
    name: string;
    dataType?: string;
    key?: boolean;
    nullable?: boolean;
  }>;
};

export type DoubleAction = {
  action: string;
  displayName?: string;
  description?: string;
  inputParameters?: Array<{ name: string; dataType?: string }>;
  resultMetadata?: Array<{ name: string; dataType?: string }>;
};

export type GoogleDoubleFaults = {
  /** Drop the connection on the Nth actions execute (1-based). */
  dropExecuteAt?: number;
  /** Answer the Nth actions execute with HTTP 500 and UNAVAILABLE. */
  failExecuteAt?: number;
  /** Answer every request with PERMISSION_DENIED. */
  permissionDenied?: boolean;
  /** `checkStatus` reports this state instead of ACTIVE. */
  connectorState?: "ACTIVE" | "ERROR" | "AUTH_ERROR";
};

export type GoogleDoubleOptions = {
  tokens: string[];
  resource: DoubleGoogleResource;
  connection?: DoubleGoogleConnection;
  /** Other connections the listing returns, by connection id. */
  otherConnections?: Record<string, DoubleGoogleConnection>;
  entityTypes?: DoubleEntityType[];
  actions?: DoubleAction[];
  entities?: Record<string, Array<Record<string, unknown>>>;
  unsupportedTypeNames?: string[];
  unsupportedActionNames?: string[];
  actionResults?: Record<string, unknown[]>;
  pageSize?: number;
  faults?: GoogleDoubleFaults;
};

const error = (
  status: number,
  googleStatus: string,
  message = "fixture rejection",
): FixtureReply => ({
  status,
  body: { error: { code: status, status: googleStatus, message } },
});

export async function startGoogleConnectorsDouble(
  options: GoogleDoubleOptions,
) {
  const faults = options.faults ?? {};
  const defaultPageSize = options.pageSize ?? 50;
  const { project, location, connection } = options.resource;
  const prefix = `projects/${project}/locations/${location}/connections`;
  let executes = 0;
  const entityQueries: Array<{
    entityType: string;
    pageSize: string | null;
    pageToken: string | null;
    sortBy: string[];
    sortOrder: string | null;
    conditions: string | null;
  }> = [];
  const executed: Array<{ action: string; parameters: unknown }> = [];

  const connectionBody = (id: string, source?: DoubleGoogleConnection) => ({
    name: `${prefix}/${id}`,
    ...(source?.description ? { description: source.description } : {}),
    connectorVersion:
      source?.connectorVersion ??
      "projects/gcp-connectors/locations/global/providers/gcp/connectors/salesforce/versions/1",
    status: { state: source?.state ?? "ACTIVE" },
    ...(source?.serviceAccount
      ? { serviceAccount: source.serviceAccount }
      : {}),
    ...(source?.suspended === undefined ? {} : { suspended: source.suspended }),
    ...(source?.asyncOperationsEnabled === undefined
      ? {}
      : { asyncOperationsEnabled: source.asyncOperationsEnabled }),
    ...(source?.authOverrideEnabled === undefined
      ? {}
      : { authOverrideEnabled: source.authOverrideEnabled }),
    ...(source?.fallbackOnAdminCredentials === undefined
      ? {}
      : { fallbackOnAdminCredentials: source.fallbackOnAdminCredentials }),
    ...(source?.eventingEnablementType
      ? { eventingEnablementType: source.eventingEnablementType }
      : {}),
    ...(source?.serviceDirectory
      ? { serviceDirectory: source.serviceDirectory }
      : {}),
    connectionRevision: source?.connectionRevision ?? "7",
    createTime: "2026-09-01T00:00:00Z",
    updateTime: "2026-09-10T00:00:00Z",
  });

  const fixture = await startHttpFixture((request, raw) => {
    const token = /^Bearer (.+)$/.exec(
      request.headers["authorization"] ?? "",
    )?.[1];
    if (!token || !options.tokens.includes(token))
      return error(401, "UNAUTHENTICATED", "invalid authentication credentials");
    if (faults.permissionDenied) return error(403, "PERMISSION_DENIED");
    const path = decodeURIComponent(request.url.pathname);
    const body = request.body.length
      ? (JSON.parse(request.body.toString("utf8")) as Record<string, unknown>)
      : undefined;
    if (body && "executionConfig" in body)
      return error(
        400,
        "INVALID_ARGUMENT",
        "executionConfig must never be sent by this client",
      );

    if (request.method === "GET" && path === `/v1/${prefix}`) {
      const all = [
        [connection, options.connection] as const,
        ...Object.entries(options.otherConnections ?? {}),
      ];
      const size = Number(
        request.url.searchParams.get("pageSize") ?? defaultPageSize,
      );
      const start = Number(request.url.searchParams.get("pageToken") ?? "0");
      const slice = all.slice(start, start + size);
      return {
        body: {
          connections: slice.map(([id, source]) => connectionBody(id, source)),
          ...(start + slice.length < all.length
            ? { nextPageToken: String(start + slice.length) }
            : {}),
          unreachable: [],
        },
      };
    }
    const scoped = path.startsWith(`/v1/${prefix}/`)
      ? path.slice(`/v1/${prefix}/`.length)
      : path.startsWith(`/v2/${prefix}/`)
        ? path.slice(`/v2/${prefix}/`.length)
        : undefined;
    if (scoped === undefined)
      return error(404, "NOT_FOUND", "unknown resource path");
    const [head, ...rest] = scoped.split("/");
    if (head === undefined) return error(404, "NOT_FOUND");
    const [connectionId, verb] = head.split(":");
    if (connectionId !== connection)
      return error(403, "PERMISSION_DENIED", "connection outside this project");

    if (request.method === "GET" && rest.length === 0 && !verb)
      return { body: connectionBody(connection, options.connection) };
    if (request.method === "GET" && verb === "checkStatus")
      return {
        body: {
          state: faults.connectorState ?? "ACTIVE",
          ...(faults.connectorState && faults.connectorState !== "ACTIVE"
            ? { description: "fixture state" }
            : {}),
        },
      };
    const [collection, name, sub, entityId] = rest;
    if (collection === "connectionSchemaMetadata:listEntityTypes")
      return {
        body: {
          entityTypes: (options.entityTypes ?? []).map((entity) => ({
            entity: entity.entity,
            operations: entity.operations ?? ["LIST", "GET"],
            fields: (entity.fields ?? []).map((field) => ({
              name: field.name,
              dataType: field.dataType ?? "STRING",
              ...(field.key === undefined ? {} : { key: field.key }),
              ...(field.nullable === undefined
                ? {}
                : { nullable: field.nullable }),
            })),
          })),
        },
      };
    if (collection === "connectionSchemaMetadata:listActions")
      return {
        body: {
          actions: (options.actions ?? []).map((action) => ({
            action: action.action,
            ...(action.displayName ? { displayName: action.displayName } : {}),
            ...(action.description ? { description: action.description } : {}),
            inputParameters: action.inputParameters ?? [],
            resultMetadata: action.resultMetadata ?? [],
          })),
        },
      };
    if (request.method === "GET" && collection === "entityTypes" && !name)
      return {
        body: {
          types: (options.entityTypes ?? []).map((entity) => ({
            name: entity.entity,
            operations: entity.operations ?? ["LIST", "GET"],
          })),
          ...(options.unsupportedTypeNames
            ? { unsupportedTypeNames: options.unsupportedTypeNames }
            : {}),
        },
      };
    if (request.method === "GET" && collection === "actions" && !name)
      return {
        body: {
          actions: (options.actions ?? []).map((action) => ({
            name: action.action,
          })),
          ...(options.unsupportedActionNames
            ? { unsupportedActionNames: options.unsupportedActionNames }
            : {}),
        },
      };
    if (collection === "entityTypes" && name && sub === "entities") {
      const rows = options.entities?.[name] ?? [];
      if (request.method === "GET" && entityId === undefined) {
        entityQueries.push({
          entityType: name,
          pageSize: request.url.searchParams.get("pageSize"),
          pageToken: request.url.searchParams.get("pageToken"),
          sortBy: request.url.searchParams.getAll("sortBy"),
          sortOrder: request.url.searchParams.get("sortOrder"),
          conditions: request.url.searchParams.get("conditions"),
        });
        const size = Number(
          request.url.searchParams.get("pageSize") ?? defaultPageSize,
        );
        const start = Number(request.url.searchParams.get("pageToken") ?? "0");
        const slice = rows.slice(start, start + size);
        return {
          body: {
            entities: slice.map((fields, index) => ({
              name: `${prefix}/${connection}/entityTypes/${name}/entities/${String(fields["id"] ?? start + index)}`,
              fields,
            })),
            ...(start + slice.length < rows.length
              ? { nextPageToken: String(start + slice.length) }
              : {}),
          },
        };
      }
      if (request.method === "GET" && entityId !== undefined) {
        const found = rows.find(
          (fields) => String(fields["id"] ?? "") === entityId,
        );
        if (!found) return error(404, "NOT_FOUND");
        return {
          body: {
            name: `${prefix}/${connection}/entityTypes/${name}/entities/${entityId}`,
            fields: found,
          },
        };
      }
      return error(400, "INVALID_ARGUMENT", "unsupported entity operation");
    }
    if (collection?.startsWith("actions") && name?.endsWith(":execute")) {
      if (request.method !== "POST")
        return error(400, "INVALID_ARGUMENT", "execute is a POST");
      executes++;
      if (faults.dropExecuteAt === executes) {
        raw.req.socket.destroy();
        return undefined;
      }
      if (faults.failExecuteAt === executes)
        return error(503, "UNAVAILABLE", "connector unavailable");
      const action = name.slice(0, -":execute".length);
      executed.push({ action, parameters: body?.["parameters"] });
      return {
        body: {
          results: options.actionResults?.[action] ?? [{ status: "ok" }],
        },
      };
    }
    return error(404, "NOT_FOUND", "unknown resource path");
  });

  return {
    ...fixture,
    entityQueries,
    executed,
    executeCount: () => executes,
    resourceName: `${prefix}/${connection}`,
  };
}
