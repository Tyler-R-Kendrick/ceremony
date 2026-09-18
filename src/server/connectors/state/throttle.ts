import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import type { Clock } from "../ports.js";
import { checkTenant, readRecord, timeSource, transact } from "./common.js";
import { budgetKey } from "./keys.js";
import { budgetSchema, stateCodeSchema } from "./schemas.js";

/*
 * A per-tenant, per-authority fixed-window budget with a circuit marker, in
 * the shape of `reserveRequest`. The record lives under the tenant, so one
 * tenant's exhausted or tripped authority says nothing about another's, and
 * there is no process-local authority: every worker reads the same window.
 */

export type AuthorityThrottleOptions = {
  now?: Clock;
  limit?: number;
  windowMs?: number;
};

export type AuthorityBudget = {
  count: number;
  remaining: number;
  resetsAt: number;
  openUntil?: number;
  openCode?: string;
};

export interface AuthorityThrottle {
  /** Consumes one unit or throws `rate-limited`; the reason distinguishes an open circuit from an exhausted window. */
  reserve(
    tenantId: string,
    authorityInstance: string,
    options?: { limit?: number; windowMs?: number },
  ): Promise<AuthorityBudget>;
  /** Opens the circuit for an authority after the provider signalled overload or outage. */
  trip(
    tenantId: string,
    authorityInstance: string,
    cooldownMs: number,
    code: string,
  ): Promise<void>;
  state(tenantId: string, authorityInstance: string): Promise<AuthorityBudget>;
}

const positive = (value: number, detail: string) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ConnectorError("invalid-request", { detail });
  return value;
};

export function createAuthorityThrottle(
  store: AsyncCeremonyStore,
  options: AuthorityThrottleOptions = {},
): AuthorityThrottle {
  const time = timeSource(options.now);
  const defaultLimit = positive(options.limit ?? 60, "throttle.limit");
  const defaultWindow = positive(options.windowMs ?? 60_000, "throttle.window");
  const checkAuthority = (value: unknown) => {
    if (typeof value !== "string" || value.length > 256 || /\p{Cc}/u.test(value))
      throw new ConnectorError("invalid-request", { detail: "throttle.authority" });
    return value;
  };
  const view = (
    value: { count: number; expires: number; openUntil?: number; openCode?: string },
    limit: number,
  ): AuthorityBudget => ({
    count: value.count,
    remaining: Math.max(0, limit - value.count),
    resetsAt: value.expires,
    ...(value.openUntil === undefined ? {} : { openUntil: value.openUntil }),
    ...(value.openCode === undefined ? {} : { openCode: value.openCode }),
  });

  return {
    async reserve(rawTenant, rawAuthority, opts = {}) {
      const tenantId = checkTenant(rawTenant);
      const authority = checkAuthority(rawAuthority);
      const limit = positive(opts.limit ?? defaultLimit, "throttle.limit");
      const windowMs = positive(opts.windowMs ?? defaultWindow, "throttle.window");
      return transact(store, async (tx) => {
        const key = budgetKey(tenantId, authority);
        const record = await readRecord(tx, key, budgetSchema);
        const now = await time(tx);
        if (record?.value.openUntil !== undefined && record.value.openUntil > now)
          throw new ConnectorError("rate-limited", { detail: "authority.circuit-open" });
        const current =
          record && record.value.expires > now
            ? { count: record.value.count, expires: record.value.expires }
            : { count: 0, expires: now + windowMs };
        if (current.count >= limit)
          throw new ConnectorError("rate-limited", { detail: "authority.budget" });
        const next = {
          schemaVersion: 1 as const,
          count: current.count + 1,
          expires: current.expires,
        };
        await tx.put(key, next, record?.revision ?? null);
        return view(next, limit);
      });
    },

    async trip(rawTenant, rawAuthority, cooldownMs, code) {
      const tenantId = checkTenant(rawTenant);
      const authority = checkAuthority(rawAuthority);
      const cooldown = positive(cooldownMs, "throttle.cooldown");
      const parsedCode = stateCodeSchema.safeParse(code);
      if (!parsedCode.success)
        throw new ConnectorError("invalid-request", { detail: "throttle.code" });
      await transact(store, async (tx) => {
        const key = budgetKey(tenantId, authority);
        const record = await readRecord(tx, key, budgetSchema);
        const now = await time(tx);
        const base =
          record && record.value.expires > now
            ? { count: record.value.count, expires: record.value.expires }
            : { count: 0, expires: now + defaultWindow };
        await tx.put(
          key,
          {
            schemaVersion: 1 as const,
            ...base,
            openUntil: now + cooldown,
            openCode: parsedCode.data,
          },
          record?.revision ?? null,
        );
      });
    },

    async state(rawTenant, rawAuthority) {
      const tenantId = checkTenant(rawTenant);
      const authority = checkAuthority(rawAuthority);
      return transact(store, async (tx) => {
        const record = await readRecord(
          tx,
          budgetKey(tenantId, authority),
          budgetSchema,
        );
        const now = await time(tx);
        if (!record) return view({ count: 0, expires: now }, defaultLimit);
        const value = record.value;
        const inWindow = value.expires > now;
        return view(
          {
            count: inWindow ? value.count : 0,
            expires: inWindow ? value.expires : now,
            ...(value.openUntil !== undefined && value.openUntil > now
              ? { openUntil: value.openUntil, ...(value.openCode ? { openCode: value.openCode } : {}) }
              : {}),
          },
          defaultLimit,
        );
      });
    },
  };
}
