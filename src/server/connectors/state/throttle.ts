import type { z } from "zod";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
  type RecordKey,
} from "../../persistence/index.js";
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

type Budget = z.output<typeof budgetSchema>;
type StoredBudget = { revision: number; value: Budget };

/**
 * Writes an authority's budget from what is stored, or from nothing on its
 * first write. Reading the row locks it, and that lock orders every write
 * after the first; the first write has no row to lock, so two workers can both
 * read nothing and both insert. The insert is what orders those two: it waits
 * for the other worker's insert of the same key and inserts nothing once that
 * commits. The worker that inserted nothing then reads the row, now there and
 * locked, and writes from it like any later write, rather than failing its
 * caller with a conflict nobody could have avoided.
 */
async function writeBudget(
  tx: AsyncTransaction,
  key: RecordKey,
  next: (record: StoredBudget | undefined) => Promise<Budget>,
): Promise<Budget> {
  let record = await readRecord(tx, key, budgetSchema);
  if (!record) {
    const value = await next(undefined);
    try {
      await tx.put(key, value, null);
      return value;
    } catch (error) {
      if (!(error instanceof PersistenceConflict)) throw error;
    }
    record = await readRecord(tx, key, budgetSchema);
    if (!record) throw new PersistenceConflict();
  }
  const value = await next(record);
  await tx.put(key, value, record.revision);
  return value;
}

export function createAuthorityThrottle(
  store: AsyncCeremonyStore,
  options: AuthorityThrottleOptions = {},
): AuthorityThrottle {
  const time = timeSource(options.now);
  const defaultLimit = positive(options.limit ?? 60, "throttle.limit");
  const defaultWindow = positive(options.windowMs ?? 60_000, "throttle.window");
  const checkAuthority = (value: unknown) => {
    if (
      typeof value !== "string" ||
      value.length > 256 ||
      /\p{Cc}/u.test(value)
    )
      throw new ConnectorError("invalid-request", {
        detail: "throttle.authority",
      });
    return value;
  };
  const view = (
    value: {
      count: number;
      expires: number;
      openUntil?: number;
      openCode?: string;
    },
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
      const windowMs = positive(
        opts.windowMs ?? defaultWindow,
        "throttle.window",
      );
      return transact(store, async (tx) => {
        const next = await writeBudget(
          tx,
          budgetKey(tenantId, authority),
          async (record) => {
            const now = await time(tx);
            if (
              record?.value.openUntil !== undefined &&
              record.value.openUntil > now
            )
              throw new ConnectorError("rate-limited", {
                detail: "authority.circuit-open",
              });
            const current =
              record && record.value.expires > now
                ? { count: record.value.count, expires: record.value.expires }
                : { count: 0, expires: now + windowMs };
            if (current.count >= limit)
              throw new ConnectorError("rate-limited", {
                detail: "authority.budget",
              });
            return {
              schemaVersion: 1 as const,
              count: current.count + 1,
              expires: current.expires,
            };
          },
        );
        return view({ count: next.count, expires: next.expires }, limit);
      });
    },

    async trip(rawTenant, rawAuthority, cooldownMs, code) {
      const tenantId = checkTenant(rawTenant);
      const authority = checkAuthority(rawAuthority);
      const cooldown = positive(cooldownMs, "throttle.cooldown");
      const parsedCode = stateCodeSchema.safeParse(code);
      if (!parsedCode.success)
        throw new ConnectorError("invalid-request", {
          detail: "throttle.code",
        });
      await transact(store, (tx) =>
        writeBudget(tx, budgetKey(tenantId, authority), async (record) => {
          const now = await time(tx);
          const base =
            record && record.value.expires > now
              ? { count: record.value.count, expires: record.value.expires }
              : { count: 0, expires: now + defaultWindow };
          return {
            schemaVersion: 1 as const,
            ...base,
            openUntil: now + cooldown,
            openCode: parsedCode.data,
          };
        }),
      );
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
              ? {
                  openUntil: value.openUntil,
                  ...(value.openCode ? { openCode: value.openCode } : {}),
                }
              : {}),
          },
          defaultLimit,
        );
      });
    },
  };
}
