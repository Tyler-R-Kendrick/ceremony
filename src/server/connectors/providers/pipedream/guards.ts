import type { InvokeResult } from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import type { EffectOutcome } from "../../ports.js";
import type { PipedreamCall } from "./context.js";
import type { PipedreamOperationSettings } from "./settings.js";

/*
 * Input bounds and the effect journal, shared by proxy, action and trigger
 * execution. Caller input is bounded before it is used for anything, props
 * are an allowlist rather than a filter, and every consequential call records
 * its intent before it leaves so that a lost response becomes an uncertain
 * outcome instead of a silent repeat.
 */

const JSON_LIMITS = {
  depth: 16,
  nodes: 10_000,
  string: 64 * 1024,
  bytes: 256 * 1024,
};
const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);

export const invalidInput = (detail: string): ConnectorError =>
  new ConnectorError("invalid-request", { detail });

/** Bounds a caller-supplied JSON value; the same walk refuses reserved keys. */
export function checkJsonBounds(
  value: unknown,
  detail = "pipedream.input.bounds",
): void {
  let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > JSON_LIMITS.nodes || depth > JSON_LIMITS.depth)
      throw invalidInput(detail);
    if (typeof item === "string") {
      if (item.length > JSON_LIMITS.string) throw invalidInput(detail);
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw invalidInput(detail);
      return;
    }
    if (item === null || typeof item === "boolean" || item === undefined)
      return;
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry, depth + 1);
      return;
    }
    if (typeof item === "object") {
      for (const key of Object.keys(item as Record<string, unknown>)) {
        if (reservedKeys.has(key) || key.length > 120)
          throw invalidInput(detail);
        walk((item as Record<string, unknown>)[key], depth + 1);
      }
      return;
    }
    throw invalidInput(detail);
  };
  walk(value, 0);
  if ((JSON.stringify(value) ?? "").length > JSON_LIMITS.bytes)
    throw invalidInput(detail);
}

/** Props may never carry an account: `authProvisionId` is injected by the adapter alone. */
export function containsAuthProvision(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAuthProvision);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "authProvisionId")) return true;
    return Object.values(record).some(containsAuthProvision);
  }
  return false;
}

/**
 * Merges host-fixed props with the caller's, accepting only prop names the
 * binding declared. The app prop is not a caller prop: it is where the
 * account goes, and a caller that tries to set it or to smuggle an
 * `authProvisionId` anywhere is refused.
 */
export function validateProps(
  props: Record<string, unknown> | undefined,
  settings: PipedreamOperationSettings,
  appProp: string,
): Record<string, unknown> {
  const allowed = new Set(settings.props ?? []);
  const merged: Record<string, unknown> = { ...(settings.fixedProps ?? {}) };
  for (const [name, value] of Object.entries(props ?? {})) {
    if (!allowed.has(name)) throw invalidInput("pipedream.props.not-allowed");
    merged[name] = value;
  }
  if (Object.hasOwn(merged, appProp))
    throw invalidInput("pipedream.props.app-prop");
  if (containsAuthProvision(merged))
    throw invalidInput("pipedream.props.auth-provision");
  checkJsonBounds(merged, "pipedream.props.bounds");
  return merged;
}

/** Failures that are known to have happened before anything left this process. */
const notApplied = new Set([
  "denied",
  "invalid-request",
  "network-policy",
  "unsupported",
  "configuration-required",
  "rate-limited",
  "not-found",
  "unauthenticated",
]);

export type JournalIntent = {
  operation: string;
  digest: string;
  commandId: string;
  connectionRef: string;
};

/**
 * Persists intent before a consequential call and records its outcome. A
 * repeated digest returns the earlier outcome instead of repeating the call:
 * an applied effect is reported applied, an uncertain one stays uncertain
 * until it is reconciled, and only an attempt that provably did nothing may
 * run again.
 */
export async function journaled(
  call: PipedreamCall,
  intent: JournalIntent,
  meta: Pick<InvokeResult, "outputClassification" | "effect">,
  run: () => Promise<InvokeResult>,
): Promise<InvokeResult> {
  const { ctx } = call;
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: intent.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    operation: intent.operation,
    digest: intent.digest,
    commandId: intent.commandId,
  });
  if (begun.prior) {
    if (begun.prior.status === "applied" || begun.prior.status === "reconciled")
      return {
        ...meta,
        state: "complete",
        code: "pipedream.effect.already-applied",
        effectRef: begun.effectRef,
      };
    if (begun.prior.status === "indeterminate")
      return {
        ...meta,
        state: "indeterminate",
        code: "pipedream.effect.indeterminate",
        effectRef: begun.effectRef,
      };
  }
  const finish = async (outcome: EffectOutcome) =>
    ctx.environment.effects.complete(begun.effectRef, outcome);
  try {
    const result = await run();
    await finish({
      status:
        result.state === "complete"
          ? "applied"
          : result.state === "indeterminate"
            ? "indeterminate"
            : "failed",
      ...(result.code ? { code: result.code } : {}),
      at: ctx.environment.now(),
    });
    return { ...result, effectRef: begun.effectRef };
  } catch (error) {
    const connector = error instanceof ConnectorError ? error : undefined;
    await finish({
      status:
        connector?.code === "indeterminate"
          ? "indeterminate"
          : connector && notApplied.has(connector.code)
            ? "not-applied"
            : "failed",
      ...(connector ? { code: connector.code } : {}),
      at: ctx.environment.now(),
    });
    if (connector?.code === "indeterminate")
      return {
        ...meta,
        state: "indeterminate",
        code: connector.detail ?? "pipedream.transport.lost",
        effectRef: begun.effectRef,
      };
    throw error;
  }
}
