import type { ConnectionLifecycle } from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  AuthorizationStart,
  DisconnectResult,
  DisconnectScope,
} from "../../adapter.js";
import { explainConnectorError } from "../../errors.js";
import { requireConnection } from "./common.js";

/*
 * Lifecycle mapping shared by the Supabase profiles. Changing the target
 * project or organization invalidates every claim that was made about the
 * old target and cancels handoffs that were issued for it; the command layer
 * then advances the connection generation so a delayed callback for the old
 * target cannot complete. Expiry maps to reconnect-required, an applied
 * upstream revocation to upstream-revoked, and a local unlink alone never
 * claims an upstream effect.
 */

export type SupersedeReport = {
  reason: string;
  invalidatedClaims: number;
  cancelledHandoffs: number;
};

/**
 * `AuthorizationStart` with a supersede report. When present, the command
 * layer must advance the connection generation before issuing the proposed
 * handoff; the adapter has already invalidated evidence and cancelled the
 * previous handoffs. Structurally a plain `AuthorizationStart`, so a command
 * layer that has not learned the field still works and merely leaves the
 * generation unchanged (the invalidation itself has already happened).
 */
export type SupabaseAuthorizationStart = AuthorizationStart & {
  supersedes?: SupersedeReport;
};

export async function supersedeTarget(
  ctx: AdapterCallContext,
  reason: string,
): Promise<SupersedeReport> {
  const connection = requireConnection(ctx);
  const invalidatedClaims = ctx.environment.evidence
    ? await ctx.environment.evidence.invalidate(
        ctx.actor,
        connection.connectionRef,
        reason,
      )
    : 0;
  const cancelledHandoffs = await ctx.environment.handoffs.cancelAll(
    connection.connectionRef,
    reason,
  );
  return { reason, invalidatedClaims, cancelledHandoffs };
}

/** The lifecycle a connection enters after an adapter failure; codes only, never provider text. */
export function supabaseLifecycleFor(error: unknown): ConnectionLifecycle {
  const explained = explainConnectorError(error);
  switch (explained.code) {
    case "expired":
      return "reconnect-required";
    case "configuration-required":
      return "configuration-required";
    case "human-required":
      return "human-required";
    case "indeterminate":
      return "indeterminate";
    case "unauthenticated":
    case "denied":
    case "invalid-request":
    case "not-found":
    case "conflict":
    case "unsupported":
    case "network-policy":
    case "upstream-unavailable":
    case "upstream-rejected":
    case "rate-limited":
    case "cancelled":
      return "degraded";
  }
}

/** The lifecycle after a disconnect: only an applied upstream revocation may claim upstream-revoked. */
export function supabaseLifecycleAfterDisconnect(
  result: DisconnectResult,
  scope: DisconnectScope,
): ConnectionLifecycle {
  if (result.upstream === "indeterminate" || result.local === "indeterminate")
    return "indeterminate";
  if (scope === "upstream" && result.upstream === "applied")
    return "upstream-revoked";
  if (result.local === "applied") return "locally-disconnected";
  return "degraded";
}
