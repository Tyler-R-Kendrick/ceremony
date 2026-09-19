import { z } from "zod";
import { canonicalConnectorJson } from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  DelegateRequest,
  InvokeResult,
} from "../../adapter.js";
import { boundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { EffectOutcome } from "../../ports.js";
import { nangoFailure } from "./api.js";
import {
  brokerReference,
  credentialScope,
  requireConnection,
  resolveNango,
  sha256,
  type NangoRuntime,
} from "./context.js";
import { rejectOverrideAttempt } from "./invoke.js";
import { successSchema, type NangoSyncStatus } from "./schemas.js";

/*
 * NG-05: sync delegation. Nango owns the sync engine, its schedule and its
 * checkpoints; this module only asks it to run, schedule, pause or report a
 * sync for one connection, through the documented endpoints. Options that
 * would reset checkpoints or empty the record cache are refused, and no call
 * is ever made without a connection id, because an omitted connection id
 * means "every connection of the integration" in Nango's API.
 */

const forbiddenOptions = new Set([
  "reset",
  "emptycache",
  "empty_cache",
  "full_resync",
  "fullresync",
  "sync_mode",
  "syncmode",
  "opts",
]);

const startInputSchema = z.strictObject({
  mode: z.enum(["trigger", "schedule"]).default("trigger"),
});

export type SyncRoute = { name: string; variant?: string };

export function parseSyncRoute(route: string): SyncRoute | undefined {
  if (!route.startsWith("sync:")) return undefined;
  const [name, variant, extra] = route.slice("sync:".length).split("::");
  if (!name || extra !== undefined) return undefined;
  return variant ? { name, variant } : { name };
}

/** A bounded, verbatim view of one sync status row; the checkpoint is passed through untouched. */
export function projectSyncStatus(status: NangoSyncStatus) {
  return {
    ...(status.id !== undefined ? { id: String(status.id) } : {}),
    name: status.name,
    ...(status.variant ? { variant: status.variant } : {}),
    status: status.status,
    ...(status.type ? { type: status.type } : {}),
    ...(status.finishedAt !== undefined
      ? { finishedAt: status.finishedAt }
      : {}),
    ...(status.nextScheduledSyncAt !== undefined
      ? { nextScheduledSyncAt: status.nextScheduledSyncAt }
      : {}),
    ...(status.frequency !== undefined ? { frequency: status.frequency } : {}),
    ...(status.latestResult !== undefined
      ? { latestResult: status.latestResult }
      : {}),
    ...(status.recordCount !== undefined
      ? { recordCount: status.recordCount }
      : {}),
    ...(status.checkpoint !== undefined
      ? { checkpoint: status.checkpoint }
      : {}),
  };
}

export async function delegateNango(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  request: DelegateRequest,
): Promise<InvokeResult> {
  const resolved = await resolveNango(runtime, ctx);
  const connection = requireConnection(resolved);
  const operation = boundOperation(ctx.binding, request.skill);
  const route =
    operation?.transport.kind === "delegated"
      ? parseSyncRoute(operation.transport.route)
      : undefined;
  if (!operation || !route)
    throw new ConnectorError("denied", { detail: "nango.delegate.unapproved" });
  if (request.input && typeof request.input === "object")
    for (const key of Object.keys(request.input as Record<string, unknown>))
      if (forbiddenOptions.has(key.toLowerCase().replaceAll("-", "")))
        throw new ConnectorError("denied", {
          detail: "nango.sync.option-rejected",
        });
  rejectOverrideAttempt(request.input);
  const reference = brokerReference(resolved);
  if (!connection.credentialRef)
    throw new ConnectorError("invalid-request", {
      detail: "nango.connection.no-credential",
    });
  const base = {
    outputClassification: operation.outputClassification,
    effect: request.action === "status" ? ("read" as const) : operation.effect,
  };
  if (request.action === "input")
    return { ...base, state: "denied", code: "nango.sync.input-unsupported" };
  const syncs = [
    route.variant
      ? { name: route.name, variant: route.variant }
      : { name: route.name },
  ];
  const syncKey = route.variant
    ? `${route.name}::${route.variant}`
    : route.name;
  const scope = credentialScope(ctx, connection);
  const withReference = <T>(work: () => Promise<T>) =>
    ctx.environment.credentials.use(
      scope,
      connection.credentialRef!,
      async (material) => {
        if (
          material.connectionId !== reference.connectionId ||
          material.providerConfigKey !== reference.providerConfigKey
        )
          throw new ConnectorError("denied", {
            detail: "nango.credential.mismatch",
          });
        return work();
      },
    );
  if (request.action === "status") {
    const status = await withReference(() =>
      resolved.client.syncStatus({
        provider_config_key: reference.providerConfigKey,
        syncs: syncKey,
        connection_id: reference.connectionId,
      }),
    );
    const rows = status.syncs
      .filter(
        (row) =>
          row.name === route.name &&
          (row.connection_id === undefined ||
            row.connection_id === reference.connectionId) &&
          (route.variant === undefined ||
            row.variant === undefined ||
            row.variant === route.variant),
      )
      .map(projectSyncStatus);
    return {
      ...base,
      state: "complete",
      output: { sync: syncKey, syncs: rows },
    };
  }
  const parsedInput = startInputSchema.safeParse(request.input ?? {});
  if (!parsedInput.success)
    throw new ConnectorError("invalid-request", { detail: "nango.sync.input" });
  const command =
    request.action === "cancel"
      ? "pause"
      : parsedInput.data.mode === "schedule"
        ? "start"
        : "trigger";
  const digest = sha256(
    canonicalConnectorJson({
      tenant: ctx.actor.tenantId,
      connection: connection.connectionRef,
      generation: ctx.generation,
      operation: operation.operationRef,
      command,
      commandId: request.commandId,
    }),
  );
  const journal = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    operation: `nango.sync.${command}:${operation.operationRef}`,
    digest,
    commandId: request.commandId,
  });
  const finish = (status: EffectOutcome["status"], code?: string) =>
    ctx.environment.effects.complete(journal.effectRef, {
      status,
      ...(code ? { code } : {}),
      at: ctx.environment.now(),
    });
  if (journal.prior) {
    if (
      journal.prior.status === "applied" ||
      journal.prior.status === "reconciled"
    )
      return {
        ...base,
        state: "complete",
        code: "nango.effect.already-applied",
        effectRef: journal.effectRef,
      };
    if (journal.prior.status === "indeterminate")
      return {
        ...base,
        state: "indeterminate",
        code: "nango.effect.indeterminate",
        effectRef: journal.effectRef,
      };
  }
  let response;
  try {
    response = await withReference(() =>
      resolved.client.syncCommand(command, {
        provider_config_key: reference.providerConfigKey,
        connection_id: reference.connectionId,
        syncs,
      }),
    );
  } catch (error) {
    if (
      error instanceof ConnectorError &&
      (error.code === "denied" || error.code === "invalid-request")
    ) {
      await finish("not-applied", error.detail ?? error.code);
      throw error;
    }
    await finish("indeterminate", "nango.upstream.lost-response");
    return {
      ...base,
      state: "indeterminate",
      code: "nango.upstream.lost-response",
      effectRef: journal.effectRef,
    };
  }
  if (response.status === 200) {
    const parsed = successSchema.safeParse(response.json ?? {});
    if (parsed.success && parsed.data.success !== false) {
      await finish("applied");
      return {
        ...base,
        state: "complete",
        output: {
          sync: syncKey,
          command,
          ...(command === "pause"
            ? { note: "nango.sync.cancel-maps-to-pause" }
            : {}),
        },
        effectRef: journal.effectRef,
        ...(command === "pause"
          ? { code: "nango.sync.cancel-maps-to-pause" }
          : {}),
      };
    }
  }
  // A gateway-level failure means the request reached Nango but its fate is
  // unknown: Nango may already have accepted the command and started, resumed
  // or paused the sync before the reply was lost. Every command that gets this
  // far changes the sync engine's state — `status` is the only read here and it
  // returned long before — so that is indeterminate, not a failure a caller may
  // simply retry against a sync that may already be running. A 4xx is
  // different: Nango refused the command explicitly, and a 429 is an explicit
  // refusal too, so those definitely did not run.
  if (response.status >= 500) {
    await finish("indeterminate", "nango.upstream.uncertain");
    return {
      ...base,
      state: "indeterminate",
      code: "nango.upstream.uncertain",
      effectRef: journal.effectRef,
    };
  }
  const failure = nangoFailure(response.status, response.json);
  await finish("failed", failure.detail ?? failure.code);
  return {
    ...base,
    state: "failed",
    code: failure.detail ?? failure.code,
    effectRef: journal.effectRef,
  };
}
