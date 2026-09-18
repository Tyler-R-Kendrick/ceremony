import type { AdapterCallContext } from "../../adapter.js";
import type { CredentialCustody, OwnerKind } from "../../adapter-types.js";
import { ConnectorError } from "../../errors.js";
import type { ConnectionRecord, CredentialScope } from "../../ports.js";
import {
  PipedreamClient,
  type PipedreamConfig,
  type PipedreamShared,
  type PipedreamTimeouts,
} from "./client.js";
import {
  pipedreamAuthorityInstance,
  pipedreamExternalUserId,
  type PipedreamOwner,
} from "./identity.js";
import {
  readPipedreamSettings,
  type PipedreamBindingSettings,
} from "./settings.js";

export const PIPEDREAM_ADAPTER_ID = "pipedream-connect";

export type PipedreamResolvedOptions = {
  connectLinkOrigins: readonly string[];
  returnPath: string;
  connectionWebhookPath: string | undefined;
  externalUserKey: Uint8Array | undefined;
  maxSignatureAgeSeconds: number;
  timeouts: PipedreamTimeouts;
};

/** Everything one adapter call has established about who is calling and where it may go. */
export type PipedreamCall = {
  ctx: AdapterCallContext;
  config: PipedreamConfig;
  settings: PipedreamBindingSettings;
  owner: PipedreamOwner;
  /** Host-derived; the only external user this call may name. */
  externalUserId: string;
  authority: string;
  client: PipedreamClient;
  options: PipedreamResolvedOptions;
  adapterVersion: string;
};

const denied = (detail: string) => new ConnectorError("denied", { detail });

/**
 * The owner is the connection's recorded owner when a connection exists, and
 * the authenticated subject otherwise. An organization or workload owner can
 * only be named by a connection record the host created; a request cannot
 * promote itself to one.
 */
export function resolveOwner(
  ctx: AdapterCallContext,
  ownerKind?: OwnerKind,
): PipedreamOwner {
  if (ctx.connection) {
    if (ctx.connection.tenantId !== ctx.actor.tenantId)
      throw denied("pipedream.tenant.mismatch");
    return {
      tenantId: ctx.connection.tenantId,
      ownerKind: ctx.connection.ownerKind,
      ownerId: ctx.connection.ownerId,
    };
  }
  const kind = ownerKind ?? "user";
  if (kind !== "user")
    throw new ConnectorError("unsupported", {
      detail: "pipedream.owner.unresolved",
    });
  return {
    tenantId: ctx.actor.tenantId,
    ownerKind: "user",
    ownerId: ctx.actor.subjectId,
  };
}

export function preparePipedreamCall(
  ctx: AdapterCallContext,
  config: PipedreamConfig,
  deps: {
    shared: PipedreamShared;
    options: PipedreamResolvedOptions;
    adapterVersion: string;
  },
  ownerKind?: OwnerKind,
): PipedreamCall {
  if (ctx.binding.adapterId !== PIPEDREAM_ADAPTER_ID)
    throw denied("pipedream.binding.adapter");
  if (ctx.binding.tenantId !== ctx.actor.tenantId)
    throw denied("pipedream.tenant.mismatch");
  if (ctx.binding.status !== "approved")
    throw denied("pipedream.binding.status");
  const settings = readPipedreamSettings(ctx.binding);
  const owner = resolveOwner(ctx, ownerKind);
  return {
    ctx,
    config,
    settings,
    owner,
    externalUserId: pipedreamExternalUserId(owner, deps.options.externalUserKey),
    authority: pipedreamAuthorityInstance(config.projectId, config.environment),
    client: new PipedreamClient(ctx, config, deps.shared, deps.options.timeouts),
    options: deps.options,
    adapterVersion: deps.adapterVersion,
  };
}

/**
 * A connection record is only usable by the call that matches every fact the
 * adapter wrote on it: same tenant, same binding, same project and
 * environment, same host-derived external user and same app. A record made
 * under the development environment is not a production connection, and a
 * record whose external user differs from the caller's derived one belongs to
 * someone else, whatever the request says.
 */
export function guardConnection(call: PipedreamCall): ConnectionRecord {
  const { ctx } = call;
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("not-found", {
      detail: "pipedream.connection.missing",
    });
  if (connection.tenantId !== ctx.actor.tenantId)
    throw denied("pipedream.tenant.mismatch");
  if (connection.bindingRef !== ctx.binding.bindingRef)
    throw denied("pipedream.binding.mismatch");
  const ids = connection.externalIds;
  if (
    (ids.environment !== undefined &&
      ids.environment !== call.config.environment) ||
    (ids.projectId !== undefined && ids.projectId !== call.config.projectId)
  )
    throw denied("pipedream.environment.mismatch");
  if (
    ids.externalUserId !== undefined &&
    ids.externalUserId !== call.externalUserId
  )
    throw denied("pipedream.external-user.mismatch");
  if (ids.app !== undefined && ids.app !== call.settings.app)
    throw denied("pipedream.app.mismatch");
  return connection;
}

export function connectionScope(
  ctx: AdapterCallContext,
  custody: CredentialCustody,
): CredentialScope {
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("not-found", {
      detail: "pipedream.connection.missing",
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
      detail: "pipedream.origin.invalid",
    });
  const url = new URL(origin);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.origin !== origin ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new ConnectorError("configuration-required", {
      detail: "pipedream.origin.invalid",
    });
  return url.origin;
}
