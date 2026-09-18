import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  type ConnectionLifecycle,
  type OwnerKind,
} from "../../../../core/connectors/index.js";
import type { ComposioAccountStatus } from "./wire.js";

/*
 * Identity for Composio.
 *
 * Four things are distinct and stay distinct: a toolkit (a versioned family of
 * tools for one service), an auth config (the reusable blueprint that decides
 * how every user of that toolkit authenticates), a connected account (one
 * user's credential under one auth config) and an execution session (a runtime
 * context that may hold several toolkits and accounts). One user may hold
 * several connected accounts for the same toolkit, so an account is never
 * implied by a toolkit and a toolkit is never implied by a service name.
 *
 * The Composio `user_id` is the host's own name for its owner. It is derived
 * here from authenticated host facts and never read from a request: a caller
 * who could choose it could read another host user's connected accounts
 * through this project's API key.
 */

/** Toolkit slugs are lowercase service keys ("github", "google_sheets"). */
export const composioToolkitSlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

/** Tool slugs are upper-snake ("GITHUB_CREATE_AN_ISSUE"). */
export const composioToolSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Z0-9][A-Z0-9_]*$/);

/**
 * Toolkit and tool versions are `YYYYMMDD_NN` release stamps, or the moving
 * alias `latest`. The stamp is opaque: it is compared exactly, never parsed
 * into a SemVer ordering.
 */
export const composioVersionSchema = z
  .string()
  .regex(/^(?:\d{8}_\d{2}|latest)$/);

/** Auth configs and connected accounts are addressed by prefixed nanoids. */
export const composioAuthConfigIdSchema = z
  .string()
  .regex(/^ac_[A-Za-z0-9_-]{1,64}$/);
export const composioConnectedAccountIdSchema = z
  .string()
  .regex(/^ca_[A-Za-z0-9_-]{1,64}$/);

/**
 * Session ids are documented only as opaque strings (`toolRouterSessionId`),
 * so nothing is assumed about their spelling beyond safe bounds.
 */
export const composioSessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

export type ComposioOwner = {
  tenantId: string;
  ownerKind: OwnerKind;
  ownerId: string;
};

export const COMPOSIO_USER_ID_VERSION = "ceremony-composio-user/1";

/**
 * The stable, host-derived Composio user id: a digest of tenant, owner kind
 * and owner identity under a version label. With a host key it is an HMAC, so
 * the mapping cannot be recomputed outside the deployment. Two tenants sharing
 * an owner id get different Composio users, and a user and an organization
 * with the same id get different Composio users. The documentation warns
 * against email addresses and against `default`; this is neither.
 */
export function composioUserId(owner: ComposioOwner, key?: Uint8Array): string {
  const message = `${COMPOSIO_USER_ID_VERSION}\n${canonicalConnectorJson({
    tenantId: owner.tenantId,
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
  })}`;
  const digest =
    key && key.byteLength > 0
      ? createHmac("sha256", key).update(message).digest("hex")
      : createHash("sha256").update(message).digest("hex");
  return `cer_${digest}`;
}

/**
 * Display form of the authority instance. The API key identifies the Composio
 * project, so the origin plus the configured API base is what a connection can
 * honestly name; the auth config and account ids are recorded separately on the
 * connection and are what actually pin it.
 */
export function composioAuthorityInstance(origin: string, base: string): string {
  return `composio:${origin}${base}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Native lifecycle mapping. Composio's statuses are the broker's view of one
 * connected account; they are translated, never renamed. An unknown status is
 * `indeterminate`: something changed upstream that this adapter has not
 * reviewed, and guessing "active" would be the one unsafe answer.
 *
 * `INACTIVE` is a host-side pause at Composio, not an expiry and not a
 * revocation, so it maps to `degraded` and blocks execution. `DELETED` means
 * the broker no longer holds the account at all; the provider grant may well
 * survive it, so it maps to `reconnect-required` rather than claiming an
 * upstream revocation that was never observed.
 */
export function composioLifecycle(status: string): ConnectionLifecycle {
  switch (status as ComposioAccountStatus) {
    case "ACTIVE":
      return "active";
    case "INITIALIZING":
      return "authorization-required";
    case "INITIATED":
      return "human-required";
    case "INACTIVE":
      return "degraded";
    case "EXPIRED":
      return "expired";
    case "FAILED":
      return "reconnect-required";
    case "REVOKED":
      return "upstream-revoked";
    case "DELETED":
      return "reconnect-required";
    default:
      return "indeterminate";
  }
}

/** Only an ACTIVE account may execute a tool; the documentation is explicit. */
export function isExecutableStatus(status: string): boolean {
  return status === "ACTIVE";
}

/** Statuses that will not change without a new authorization. */
export function isTerminalStatus(status: string): boolean {
  return (
    status === "ACTIVE" ||
    status === "FAILED" ||
    status === "EXPIRED" ||
    status === "REVOKED" ||
    status === "DELETED"
  );
}
