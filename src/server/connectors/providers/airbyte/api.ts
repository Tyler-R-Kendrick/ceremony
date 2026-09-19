import { z } from "zod";
import type { ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { airbyteTargetKinds } from "./contracts.js";

/*
 * The Airbyte API (the public, supported one) as documented at
 * https://reference.airbyte.com and https://docs.airbyte.com/platform/api-documentation,
 * retrieved 2026-09-18. Base URLs: `https://api.airbyte.com/v1/` for Cloud and
 * `<deployment>/api/public/v1/` for self-managed deployments. Authentication is
 * `Authorization: Bearer <access token>`; access tokens come from
 * `POST /v1/applications/token` with `client_id` and `client_secret` and live
 * three minutes on Cloud (24 hours on Self-Managed Enterprise).
 *
 * The Configuration API (`/api/v1/sources/check_connection`, `discover_schema`)
 * is documented as deprecated and unsupported ("Airbyte engineers may modify
 * it without warning"), so it is not used: a source check is approximated by
 * the documented live schema discovery (`GET /streams?ignoreCache=true`), and
 * that limitation is reported rather than papered over.
 *
 * Verified operations (method, path, fields) are listed in the table below;
 * every binding that names one must agree with it exactly.
 */

export const AIRBYTE_API_PROFILE = "airbyte-api-v1-2026-09";
export const AIRBYTE_CLOUD_API_URL = "https://api.airbyte.com/v1";

export const airbyteApiSyncModes = [
  "full_refresh_overwrite",
  "full_refresh_append",
  "incremental_append",
  "incremental_deduped_history",
] as const;
export const airbyteJobStatuses = [
  "pending",
  "running",
  "incomplete",
  "failed",
  "succeeded",
  "cancelled",
] as const;
export const airbyteTerminalJobStatuses: ReadonlySet<string> = new Set([
  "failed",
  "succeeded",
  "cancelled",
]);
export const airbyteJobTypes = ["sync", "reset"] as const;
export const airbyteConnectionStatuses = [
  "active",
  "inactive",
  "deprecated",
] as const;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const uuid = z.uuid();
const paths = z.array(z.array(text(512)).max(64)).max(4096);

export const jobResponseSchema = z.looseObject({
  jobId: z.number().int().nonnegative(),
  status: z.enum(airbyteJobStatuses),
  jobType: z.enum(airbyteJobTypes),
  startTime: text(64),
  connectionId: uuid,
  lastUpdatedAt: text(64).optional(),
  duration: text(64).optional(),
  bytesSynced: z.number().int().nonnegative().optional(),
  rowsSynced: z.number().int().nonnegative().optional(),
});
export type AirbyteJobResponse = z.infer<typeof jobResponseSchema>;

export const jobsResponseSchema = z.looseObject({
  data: z.array(jobResponseSchema).max(100),
  next: text(2048).optional(),
  previous: text(2048).optional(),
});

export const sourceResponseSchema = z.looseObject({
  sourceId: uuid,
  name: text(512),
  sourceType: text(200),
  workspaceId: uuid,
  configuration: z.unknown().optional(),
});

export const connectionStreamConfigurationSchema = z.looseObject({
  name: text(512),
  syncMode: text(64).optional(),
  cursorField: z.array(text(512)).max(64).optional(),
  primaryKey: paths.optional(),
});

export const connectionResponseSchema = z.looseObject({
  connectionId: uuid,
  name: text(512),
  sourceId: uuid,
  destinationId: uuid,
  workspaceId: uuid,
  status: z.enum(airbyteConnectionStatuses),
  configurations: z
    .looseObject({
      streams: z.array(connectionStreamConfigurationSchema).max(4096),
    })
    .optional(),
  namespaceDefinition: text(64).optional(),
  namespaceFormat: text(512).nullable().optional(),
  prefix: text(512).nullable().optional(),
  createdAt: z.number().int().optional(),
});
export type AirbyteConnectionResponse = z.infer<
  typeof connectionResponseSchema
>;

export const streamPropertiesSchema = z.looseObject({
  streamName: text(512),
  syncModes: z.array(text(64)).max(8).optional(),
  defaultCursorField: z.array(text(512)).max(64).optional(),
  sourceDefinedCursorField: z.boolean().optional(),
  sourceDefinedPrimaryKey: paths.optional(),
  propertyFields: paths.optional(),
});
export const streamPropertiesListSchema = z
  .array(streamPropertiesSchema)
  .max(4096);
export type AirbyteStreamProperties = z.infer<typeof streamPropertiesSchema>;

/**
 * Token response of POST /applications/token. The request fields
 * (`client_id`, `client_secret`) and the `access_token` result are documented;
 * `expires_in` is read when present and otherwise the documented lifetime is
 * assumed conservatively.
 */
export const applicationTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1).max(16384),
  token_type: text(32).optional(),
  expires_in: z.number().nonnegative().optional(),
});

export type AirbyteOperationSpec = {
  readonly method: "GET" | "POST" | "DELETE";
  readonly pathTemplate: string;
  readonly effect: "read" | "write";
  readonly replay: "read-only" | "reconciliation" | "none";
  /** The documented job type this operation submits; input can never choose it. */
  readonly jobType?: (typeof airbyteJobTypes)[number];
  /** The permitted-target kind and the input parameter that names it. */
  readonly target?: { kind: string; parameter: string };
  readonly summary: string;
};

export const airbyteOperationTable = {
  "airbyte.source.get": {
    method: "GET",
    pathTemplate: "/sources/{sourceId}",
    effect: "read",
    replay: "read-only",
    target: { kind: airbyteTargetKinds.source, parameter: "sourceId" },
    summary: "Get source",
  },
  "airbyte.connection.get": {
    method: "GET",
    pathTemplate: "/connections/{connectionId}",
    effect: "read",
    replay: "read-only",
    target: { kind: airbyteTargetKinds.connection, parameter: "connectionId" },
    summary: "Get connection details",
  },
  "airbyte.streams.discover": {
    method: "GET",
    pathTemplate: "/streams",
    effect: "read",
    replay: "read-only",
    target: { kind: airbyteTargetKinds.source, parameter: "sourceId" },
    summary: "Get stream properties (schema discovery)",
  },
  "airbyte.job.sync": {
    method: "POST",
    pathTemplate: "/jobs",
    effect: "write",
    replay: "none",
    jobType: "sync",
    target: { kind: airbyteTargetKinds.connection, parameter: "connectionId" },
    summary: "Trigger a sync job",
  },
  "airbyte.job.reset": {
    method: "POST",
    pathTemplate: "/jobs",
    effect: "write",
    replay: "none",
    jobType: "reset",
    target: { kind: airbyteTargetKinds.connection, parameter: "connectionId" },
    summary: "Trigger a reset job (clears connection state)",
  },
  "airbyte.job.get": {
    method: "GET",
    pathTemplate: "/jobs/{jobId}",
    effect: "read",
    replay: "read-only",
    summary: "Get job status",
  },
  "airbyte.job.list": {
    method: "GET",
    pathTemplate: "/jobs",
    effect: "read",
    replay: "read-only",
    target: { kind: airbyteTargetKinds.connection, parameter: "connectionId" },
    summary: "List jobs of a connection",
  },
  "airbyte.job.cancel": {
    method: "DELETE",
    pathTemplate: "/jobs/{jobId}",
    effect: "write",
    replay: "reconciliation",
    summary: "Cancel a job",
  },
} as const satisfies Record<string, AirbyteOperationSpec>;
export type AirbyteOperationId = keyof typeof airbyteOperationTable;

export function airbyteOperation(
  nativeId: string,
): (AirbyteOperationSpec & { id: AirbyteOperationId }) | undefined {
  if (!Object.hasOwn(airbyteOperationTable, nativeId)) return undefined;
  const id = nativeId as AirbyteOperationId;
  return { id, ...airbyteOperationTable[id] };
}

/**
 * Resolves the configured API base against the approved destination. The
 * configured URL must be exactly the destination's origin (no suffix match),
 * carry no userinfo, query or fragment, and end in the API version segment.
 * The returned base path is what operation paths are appended to.
 */
export function resolveAirbyteApiBase(
  configured: string | undefined,
  destination: ApprovedDestination,
): { basePath: string } {
  if (!configured)
    throw new ConnectorError("configuration-required", {
      detail: "airbyte.api-url.missing",
    });
  if (!URL.canParse(configured))
    throw new ConnectorError("invalid-request", {
      detail: "airbyte.api-url.invalid",
    });
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash)
    throw new ConnectorError("invalid-request", {
      detail: "airbyte.api-url.invalid",
    });
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && destination.network === "loopback-fixture")
  )
    throw new ConnectorError("network-policy", {
      detail: "airbyte.api-url.scheme",
    });
  if (url.origin !== destination.origin)
    throw new ConnectorError("network-policy", {
      detail: "airbyte.api-url.origin-mismatch",
    });
  const basePath = url.pathname.replace(/\/+$/, "");
  if (!/\/v1$/.test(basePath))
    throw new ConnectorError("invalid-request", {
      detail: "airbyte.api-url.version",
    });
  if (
    destination.pathPrefix &&
    destination.pathPrefix !== "/" &&
    basePath !== destination.pathPrefix.replace(/\/+$/, "") &&
    !basePath.startsWith(`${destination.pathPrefix.replace(/\/+$/, "")}/`)
  )
    throw new ConnectorError("network-policy", {
      detail: "airbyte.api-url.prefix-mismatch",
    });
  return { basePath };
}
