import { canonicalConnectorJson } from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  DisconnectResult,
  DisconnectScope,
} from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import {
  brokerReference,
  credentialScope,
  requireConnection,
  resolveNango,
  sha256,
  type NangoRuntime,
} from "./context.js";

/*
 * Local unlink, broker deletion and upstream revocation are three different
 * effects. The default scope removes only what this deployment holds: the
 * pending handoffs and the protected broker reference. Broker deletion
 * (DELETE /connections/{id}) happens only under the explicit "broker" scope,
 * never when another local connection still references the same Nango
 * connection unless a shared-impact approval is given by an administrator.
 * Nango documents no provider-grant revocation endpoint, so "upstream" is
 * reported unsupported rather than approximated by deletion.
 */

async function unlinkLocally(runtime: NangoRuntime, ctx: AdapterCallContext) {
  const resolved = await resolveNango(runtime, ctx);
  const connection = requireConnection(resolved);
  await ctx.environment.handoffs.cancelAll(
    connection.connectionRef,
    "nango.disconnect",
  );
  if (connection.credentialRef)
    await ctx.environment.credentials.revoke(
      credentialScope(ctx, connection),
      connection.credentialRef,
    );
}

export async function disconnectNango(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  scope: DisconnectScope,
): Promise<DisconnectResult> {
  if (scope === "local") {
    await unlinkLocally(runtime, ctx);
    return {
      local: "applied",
      broker: "not-attempted",
      upstream: "not-attempted",
    };
  }
  if (scope === "broker")
    return deleteNangoBrokerConnection(runtime, ctx, {
      approveSharedImpact: false,
    });
  return {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "unsupported",
  };
}

/**
 * DELETE /connections/{connectionId}?provider_config_key=... for the bound
 * integration only. Shared references block the call unless an administrator
 * explicitly approves the shared impact; the blocked result names the other
 * local connections so the impact can be reviewed.
 */
export async function deleteNangoBrokerConnection(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  options: { approveSharedImpact: boolean },
): Promise<DisconnectResult> {
  const resolved = await resolveNango(runtime, ctx);
  const connection = requireConnection(resolved);
  if (!connection.externalIds.connectionId)
    return {
      local: "not-attempted",
      broker: "not-attempted",
      upstream: "not-attempted",
    };
  const reference = brokerReference(resolved);
  const shared =
    (await runtime.options.sharedReferences?.({
      tenantId: ctx.actor.tenantId,
      authorityInstance: resolved.authority,
      providerConfigKey: reference.providerConfigKey,
      connectionId: reference.connectionId,
      excludeConnectionRef: connection.connectionRef,
    })) ?? [];
  if (shared.length) {
    if (!options.approveSharedImpact)
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: "not-attempted",
        sharedWith: shared,
      };
    if (!ctx.actor.capabilities.includes("admin"))
      throw new ConnectorError("denied", {
        detail: "nango.disconnect.shared-impact-admin",
      });
  }
  const journal = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    operation: "nango.connection.delete",
    digest: sha256(
      canonicalConnectorJson({
        tenant: ctx.actor.tenantId,
        authority: resolved.authority,
        integration: reference.providerConfigKey,
        connectionId: reference.connectionId,
      }),
    ),
  });
  if (journal.prior?.status !== "applied") {
    try {
      await resolved.client.deleteConnection(
        reference.connectionId,
        reference.providerConfigKey,
      );
    } catch (error) {
      const lost =
        error instanceof ConnectorError &&
        (error.code === "upstream-unavailable" || error.code === "cancelled");
      await ctx.environment.effects.complete(journal.effectRef, {
        status: lost ? "indeterminate" : "failed",
        code:
          error instanceof ConnectorError
            ? (error.detail ?? error.code)
            : "nango.delete.error",
        at: ctx.environment.now(),
      });
      if (lost)
        return {
          local: "not-attempted",
          broker: "indeterminate",
          upstream: "not-attempted",
          ...(shared.length ? { sharedWith: shared } : {}),
        };
      throw error;
    }
    await ctx.environment.effects.complete(journal.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
  }
  await unlinkLocally(runtime, ctx);
  return {
    local: "applied",
    broker: "applied",
    upstream: "not-attempted",
    ...(shared.length ? { sharedWith: shared } : {}),
  };
}

/** Nango exposes no provider-grant revocation; say so instead of deleting and calling it revoked. */
export function revokeNango(): DisconnectResult {
  return {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "unsupported",
  };
}
