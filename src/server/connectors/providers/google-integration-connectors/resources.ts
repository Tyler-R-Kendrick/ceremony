import { z } from "zod";
import { encodePathSegment } from "../../../../core/connectors/identity.js";
import type { ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";

/*
 * Resource names for Google Cloud Integration Connectors.
 *
 * Project, location and connection are *host* configuration, never caller
 * input: they decide which tenant's data a call reaches. This module builds
 * the documented resource paths from a binding's approved settings, refuses a
 * caller-supplied resource name outright, and percent-encodes each segment
 * exactly once so an entity id containing `/` cannot walk out of its
 * collection.
 *
 * Paths come from the service's own discovery documents, both at revision
 * 20260907, fetched from
 * https://connectors.googleapis.com/$discovery/rest?version=v1 and
 * https://connectors.googleapis.com/$discovery/rest?version=v2 on 2026-09-18:
 *
 *   GET  /v1/projects/{p}/locations/{l}/connections
 *   GET  /v1/projects/{p}/locations/{l}/connections/{c}
 *   GET  /v1/projects/{p}/locations/{l}/connections/{c}/connectionSchemaMetadata:listEntityTypes
 *   GET  /v1/projects/{p}/locations/{l}/connections/{c}/connectionSchemaMetadata:listActions
 *   GET  /v2/projects/{p}/locations/{l}/connections/{c}/entityTypes
 *   GET  /v2/projects/{p}/locations/{l}/connections/{c}/entityTypes/{e}/entities
 *   GET  /v2/projects/{p}/locations/{l}/connections/{c}/entityTypes/{e}/entities/{id}
 *   GET  /v2/projects/{p}/locations/{l}/connections/{c}/actions
 *   POST /v2/projects/{p}/locations/{l}/connections/{c}/actions/{a}:execute
 *   GET  /v2/projects/{p}/locations/{l}/connections/{c}:checkStatus
 */

/** A project id, or a project number. */
export const projectSchema = z
  .string()
  .regex(/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})$/);
/** A Google Cloud location, or `global` for resources that only exist there. */
export const locationSchema = z
  .string()
  .regex(/^(?:global|[a-z][a-z0-9-]{0,30}[a-z0-9])$/);
export const connectionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/);
/** Entity type and action names are the external system's spelling, preserved exactly. */
export const schemaNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,199}$/);
export const entityIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);

export const connectionResourceSchema = z.strictObject({
  project: projectSchema,
  location: locationSchema,
  connection: connectionSchema,
});
export type ConnectionResource = z.infer<typeof connectionResourceSchema>;

/** `projects/{project}/locations/{location}/connections/{connection}`. */
export function connectionResourceName(resource: ConnectionResource): string {
  return `projects/${resource.project}/locations/${resource.location}/connections/${resource.connection}`;
}

export function adminConnectionPath(resource: ConnectionResource): string {
  return `/v1/${connectionResourceName(resource)}`;
}

export function adminConnectionsPath(
  resource: Pick<ConnectionResource, "project" | "location">,
): string {
  return `/v1/projects/${resource.project}/locations/${resource.location}/connections`;
}

export function runtimeConnectionPath(
  resource: ConnectionResource,
  suffix = "",
): string {
  return `/v2/${connectionResourceName(resource)}${suffix}`;
}

/** One encoded segment for an entity type, an action or an entity id. */
export function segment(value: string): string {
  const encoded = encodePathSegment(value);
  if (encoded.length === 0 || encoded.length > 1024)
    throw new ConnectorError("invalid-request", {
      detail: "google-connectors.segment.invalid",
    });
  return encoded;
}

/**
 * Rejects a resource name that arrived from a caller. The only accepted use of
 * a full name is a check that it matches the one the binding already approved.
 */
export function assertResourceMatches(
  approved: ConnectionResource,
  candidate: string,
): void {
  if (candidate !== connectionResourceName(approved))
    throw new ConnectorError("denied", {
      detail: "google-connectors.resource.substituted",
    });
}

const regionalHost = /^connectors\.([a-z0-9-]+)\.rep\.googleapis\.com$/;

/**
 * A regional endpoint names its region in the hostname. Calling it for a
 * connection in another location is a location confusion, not a routing
 * preference, so it is refused before a request is signed or sent.
 */
export function assertEndpointLocation(
  destination: ApprovedDestination,
  location: string,
): void {
  const host = new URL(destination.origin).hostname;
  const match = regionalHost.exec(host);
  if (match && match[1] !== location)
    throw new ConnectorError("denied", {
      detail: "google-connectors.location.mismatch",
    });
}

export function baseUrlForDestination(
  destination: ApprovedDestination,
): string {
  const prefix = (destination.pathPrefix ?? "").replace(/\/+$/, "");
  if (prefix.includes("//") || prefix.split("/").includes(".."))
    throw new ConnectorError("network-policy", {
      detail: "google-connectors.base-url.invalid",
    });
  return `${destination.origin}${prefix}`;
}
