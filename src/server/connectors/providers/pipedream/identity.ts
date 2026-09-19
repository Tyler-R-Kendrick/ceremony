import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { canonicalConnectorJson } from "../../../../core/connectors/index.js";
import type { OwnerKind } from "../../adapter-types.js";

/*
 * Identity for the Pipedream Connect broker. Pipedream stores connected
 * accounts per project, per environment and per `external_user_id`. The
 * external user id is the host's name for its own owner and is the only thing
 * that ties a broker account back to a Ceremony tenant, owner kind and owner
 * identity; it is therefore derived here, deterministically, from host facts,
 * and never read from a request. A caller who could choose the external user
 * id could read another user's accounts through our project credentials.
 */

export const pipedreamEnvironments = ["development", "production"] as const;
export const pipedreamEnvironmentSchema = z.enum(pipedreamEnvironments);
export type PipedreamEnvironment = z.infer<typeof pipedreamEnvironmentSchema>;

/** Documented identifier shapes (Connect API reference, retrieved 2026-09-18). */
export const pipedreamProjectIdSchema = z
  .string()
  .regex(/^proj_[a-zA-Z0-9]{1,64}$/);
export const pipedreamAccountIdSchema = z
  .string()
  .regex(/^apn_[a-zA-Z0-9]{1,64}$/);
export const pipedreamTriggerIdSchema = z
  .string()
  .regex(/^dc_[a-zA-Z0-9]{1,64}$/);
export const pipedreamConnectTokenSchema = z
  .string()
  .regex(/^ctok_[0-9a-f]{32}$/);
/** App name slugs are lowercase words joined by underscores ("google_sheets", "slack_bot"). */
export const pipedreamAppSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_]{0,99}$/);
/** Component keys are registry keys such as "slack-send-message-to-channel". */
export const pipedreamComponentKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,199}$/);
/** Pipedream limits external user ids to 250 characters. */
export const pipedreamExternalUserIdSchema = z
  .string()
  .min(1)
  .max(250)
  .regex(/^[^\p{Cc}]+$/u);

export type PipedreamOwner = {
  tenantId: string;
  ownerKind: OwnerKind;
  ownerId: string;
};

export const PIPEDREAM_EXTERNAL_USER_VERSION =
  "ceremony-pipedream-external-user/1";
const TENANT_ROUTE_VERSION = "ceremony-pipedream-tenant-route/1";

/**
 * The stable, host-derived external user id: a digest of tenant, owner kind
 * and owner identity under a version label. With a host key it is an HMAC, so
 * the mapping cannot be recomputed outside the deployment; without one it is a
 * plain SHA-256, still unguessable in effect because nothing can be done with
 * it without the project's client credentials. Two tenants sharing an owner id
 * get different external users; a user and an organization with the same id
 * get different external users.
 */
export function pipedreamExternalUserId(
  owner: PipedreamOwner,
  key?: Uint8Array,
): string {
  const message = `${PIPEDREAM_EXTERNAL_USER_VERSION}\n${canonicalConnectorJson(
    {
      tenantId: owner.tenantId,
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
    },
  )}`;
  const digest =
    key && key.byteLength > 0
      ? createHmac("sha256", key).update(message).digest("hex")
      : createHash("sha256").update(message).digest("hex");
  return `cer_${digest}`;
}

/** Display form of the authority instance: one project in one environment. */
export function pipedreamAuthorityInstance(
  projectId: string,
  environment: PipedreamEnvironment,
): string {
  return `${projectId}:${environment}`;
}

/**
 * Opaque routing segment for the connection webhook URL, so an unauthenticated
 * delivery can be routed to a tenant without naming the tenant. It is a
 * routing aid; the integrator resolves it against its tenant table and the
 * connect token correlation still decides which handoff, if any, it concerns.
 */
export function pipedreamTenantRoute(tenantId: string): string {
  return createHash("sha256")
    .update(`${TENANT_ROUTE_VERSION}\n${tenantId}`)
    .digest("hex")
    .slice(0, 32);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
