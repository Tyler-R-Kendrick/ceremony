import {
  encodePathSegment,
  type NativeCapability,
} from "../../../../core/connectors/index.js";
import type { DisconnectResult, DisconnectScope } from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import { guardConnection, type ComposioCall } from "./context.js";
import { permittedAccounts } from "./settings.js";
import type { ComposioTool } from "./wire.js";

/*
 * Lifecycle effects, kept apart.
 *
 * A local unlink is a host decision and asks Composio for nothing. A broker
 * disconnect deletes the connected account at Composio, which the
 * documentation says is permanent, so it happens only when the deployment
 * explicitly enabled it. An upstream revocation — the end user's grant at the
 * provider — has no documented Composio operation at all, and saying so is the
 * result; deleting Composio's copy instead would claim more than happened.
 */

export type DisconnectOptions = {
  /** Deleting a connected account is permanent; a deployment opts in to it. */
  allowBrokerDeletion: boolean;
};

export async function composioDisconnect(
  call: ComposioCall,
  scope: DisconnectScope,
  options: DisconnectOptions,
): Promise<DisconnectResult> {
  const connection = guardConnection(call);
  if (scope === "local")
    return {
      local: "applied",
      broker: "not-attempted",
      upstream: "not-attempted",
    };
  if (scope === "upstream")
    return {
      local: "not-attempted",
      broker: "not-attempted",
      upstream: "unsupported",
    };
  if (!options.allowBrokerDeletion)
    return {
      local: "not-attempted",
      broker: "unsupported",
      upstream: "not-attempted",
    };
  const accountId = connection.externalIds.connectedAccountId;
  if (!accountId)
    return {
      local: "not-attempted",
      broker: "not-attempted",
      upstream: "not-attempted",
    };
  const allowed = permittedAccounts(call.ctx.binding);
  if (allowed.length && !allowed.includes(accountId))
    throw new ConnectorError("denied", {
      detail: "composio.account.not-permitted",
    });
  const effect = await call.ctx.environment.effects.begin({
    actor: call.ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: call.ctx.binding.bindingRef,
    operation: "composio.connected-account.delete",
    digest: accountId,
  });
  try {
    const response = await call.client.send({
      method: "DELETE",
      path: call.client.path(
        `/connected_accounts/${encodePathSegment(accountId)}`,
      ),
      timeoutMs: call.options.timeouts.write,
      consequential: true,
    });
    if (
      response.status !== 200 &&
      response.status !== 204 &&
      response.status !== 404
    ) {
      await call.ctx.environment.effects.complete(effect.effectRef, {
        status: "failed",
        at: call.ctx.environment.now(),
      });
      return {
        local: "not-attempted",
        broker: "failed",
        upstream: "not-attempted",
      };
    }
    await call.ctx.environment.effects.complete(effect.effectRef, {
      status: "applied",
      at: call.ctx.environment.now(),
    });
    return {
      local: "not-attempted",
      broker: "applied",
      // Composio no longer holds the credential; the provider grant it held is
      // not thereby revoked, and nothing observed says it was.
      upstream: "not-attempted",
    };
  } catch (error) {
    const indeterminate =
      error instanceof ConnectorError && error.code === "indeterminate";
    await call.ctx.environment.effects.complete(effect.effectRef, {
      status: indeterminate ? "indeterminate" : "failed",
      at: call.ctx.environment.now(),
    });
    return {
      local: "not-attempted",
      broker: indeterminate ? "indeterminate" : "failed",
      upstream: "not-attempted",
    };
  }
}

/**
 * Versioned capability metadata for one toolkit: every tool with its own slug,
 * its own version and the versions the toolkit still serves, so a reviewer
 * binds an exact tool at an exact version rather than a service name.
 */
export function toolkitCapabilities(
  toolkitSlug: string,
  tools: readonly ComposioTool[],
): NativeCapability[] {
  return tools.map((tool) => ({
    kind: "action" as const,
    nativeId: `${toolkitSlug}/${tool.slug}`,
    ...(tool.name ? { label: tool.name.slice(0, 200) } : {}),
    ...(tool.description
      ? { summary: tool.description.replace(/[\p{Cc}]/gu, " ").slice(0, 500) }
      : {}),
    // Composio publishes no machine-readable effect classification for a tool,
    // and a name is not one. The host's operation policy decides.
    effect: "unknown" as const,
    dataClassification: "unknown" as const,
    cost: "unknown" as const,
    nativeExtensions: {
      toolSlug: tool.slug,
      ...(tool.version ? { version: tool.version } : {}),
      ...(tool.available_versions?.length
        ? { availableVersions: tool.available_versions }
        : {}),
      ...(tool.scopes?.length ? { scopes: tool.scopes } : {}),
      ...(tool.no_auth === undefined ? {} : { noAuth: tool.no_auth }),
      ...(tool.deprecated?.is_deprecated === true ? { deprecated: true } : {}),
    },
  }));
}
