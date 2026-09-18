import type { AdapterCallContext } from "../../adapter.js";
import type { CredentialCustody, OwnerKind } from "../../adapter-types.js";
import { ConnectorError } from "../../errors.js";
import type { ConnectionRecord, CredentialScope } from "../../ports.js";
import {
  ComposioClient,
  type ComposioShared,
  type ComposioTimeouts,
} from "./client.js";
import {
  composioAuthorityInstance,
  composioUserId,
  type ComposioOwner,
} from "./identity.js";
import {
  readComposioSettings,
  type ComposioBindingSettings,
} from "./settings.js";
import { COMPOSIO_API_BASE } from "./wire.js";

export const COMPOSIO_ADAPTER_ID = "composio";

export type ComposioResolvedOptions = {
  /** Path on the deployment origin that receives hosted authorization returns. */
  returnPath: string;
  /** Host key that makes the derived Composio user id unguessable outside the deployment. */
  userIdKey: Uint8Array | undefined;
  /** How long a hosted authorization handoff stays valid, in milliseconds. */
  handoffTtlMs: number;
  /** Exact origins a returned hosted authorization URL may have, beyond the api destination. */
  authorizationOrigins: readonly string[];
  timeouts: ComposioTimeouts;
};

/** Everything one adapter call has established about who is calling and where it may go. */
export type ComposioCall = {
  ctx: AdapterCallContext;
  settings: ComposioBindingSettings;
  owner: ComposioOwner;
  /** Host-derived; the only Composio user this call may name. */
  userId: string;
  authority: string;
  base: string;
  client: ComposioClient;
  options: ComposioResolvedOptions;
  adapterVersion: string;
};

const denied = (detail: string) => new ConnectorError("denied", { detail });

/**
 * The owner is the connection's recorded owner when a connection exists, and
 * the authenticated subject otherwise. An organization or workload owner can
 * only be named by a connection record the host created; a request cannot
 * promote itself to one, and no argument names a Composio user.
 */
export function resolveOwner(
  ctx: AdapterCallContext,
  ownerKind?: OwnerKind,
): ComposioOwner {
  if (ctx.connection) {
    if (ctx.connection.tenantId !== ctx.actor.tenantId)
      throw denied("composio.tenant.mismatch");
    return {
      tenantId: ctx.connection.tenantId,
      ownerKind: ctx.connection.ownerKind,
      ownerId: ctx.connection.ownerId,
    };
  }
  const kind = ownerKind ?? "user";
  if (kind !== "user")
    throw new ConnectorError("unsupported", {
      detail: "composio.owner.unresolved",
    });
  return {
    tenantId: ctx.actor.tenantId,
    ownerKind: "user",
    ownerId: ctx.actor.subjectId,
  };
}

export function prepareComposioCall(
  ctx: AdapterCallContext,
  deps: {
    shared: ComposioShared;
    options: ComposioResolvedOptions;
    adapterVersion: string;
  },
  ownerKind?: OwnerKind,
): ComposioCall {
  if (ctx.binding.adapterId !== COMPOSIO_ADAPTER_ID)
    throw denied("composio.binding.adapter");
  if (ctx.binding.tenantId !== ctx.actor.tenantId)
    throw denied("composio.tenant.mismatch");
  if (ctx.binding.status !== "approved")
    throw denied("composio.binding.status");
  const settings = readComposioSettings(ctx.binding);
  const owner = resolveOwner(ctx, ownerKind);
  const base = settings.apiBase ?? COMPOSIO_API_BASE;
  const destination = ctx.binding.destinations.find(
    (item) => item.id === "api",
  );
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "composio.destination.missing",
    });
  return {
    ctx,
    settings,
    owner,
    userId: composioUserId(owner, deps.options.userIdKey),
    authority: composioAuthorityInstance(destination.origin, base),
    base,
    client: new ComposioClient(ctx, base, deps.shared, deps.options.timeouts),
    options: deps.options,
    adapterVersion: deps.adapterVersion,
  };
}

/**
 * A connection record is only usable by the call that matches every fact the
 * adapter wrote on it: same tenant, same binding, same authority, same
 * host-derived Composio user, same toolkit and an auth config this binding
 * still approves. A record made against another toolkit version's auth config
 * is not this binding's connection, whatever a request says.
 */
export function guardConnection(call: ComposioCall): ConnectionRecord {
  const { ctx } = call;
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("not-found", {
      detail: "composio.connection.missing",
    });
  if (connection.tenantId !== ctx.actor.tenantId)
    throw denied("composio.tenant.mismatch");
  if (connection.bindingRef !== ctx.binding.bindingRef)
    throw denied("composio.binding.mismatch");
  if (
    connection.authorityInstance !== "" &&
    connection.authorityInstance !== call.authority
  )
    throw denied("composio.authority.mismatch");
  const ids = connection.externalIds;
  if (ids.userId !== undefined && ids.userId !== call.userId)
    throw denied("composio.user.mismatch");
  if (
    ids.toolkitSlug !== undefined &&
    ids.toolkitSlug !== call.settings.toolkit.slug
  )
    throw denied("composio.toolkit.mismatch");
  if (
    ids.authConfigId !== undefined &&
    !call.settings.authConfigs.includes(ids.authConfigId)
  )
    throw denied("composio.auth-config.unapproved");
  return connection;
}

export function connectionScope(
  ctx: AdapterCallContext,
  custody: CredentialCustody,
): CredentialScope {
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("not-found", {
      detail: "composio.connection.missing",
    });
  return {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody,
  };
}

/** The deployment origin, exactly as configured; return routes are built from it, never from input. */
export function deploymentOrigin(origin: string): string {
  if (!URL.canParse(origin))
    throw new ConnectorError("configuration-required", {
      detail: "composio.origin.invalid",
    });
  const url = new URL(origin);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.origin !== origin ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new ConnectorError("configuration-required", {
      detail: "composio.origin.invalid",
    });
  return url.origin;
}
