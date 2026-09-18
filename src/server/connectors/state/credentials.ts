import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
  type Fence,
} from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import type {
  Clock,
  CredentialCustodyPort,
  CredentialMaterial,
  CredentialScope,
} from "../ports.js";
import {
  SCHEMA_VERSION,
  boundedDuration,
  compact,
  newRef,
  readRecord,
  timeSource,
  transact,
} from "./common.js";
import { credentialKey } from "./keys.js";
import {
  credentialMaterialSchema,
  credentialScopeSchema,
  storedCredentialSchema,
  type StoredCredential,
} from "./schemas.js";

/*
 * Host-owned credential custody over the encrypted store.
 *
 * Material is written once and read only inside `use`, whose callback runs
 * after the reading transaction committed and whose result is checked so the
 * material cannot ride out of it. Refresh is single flight across processes:
 * the worker that holds the credential's lease calls upstream, followers wait
 * for the rotated generation, and a result computed against an older
 * generation — or committed by a worker whose lease lapsed — is refused, so a
 * rotating refresh token is never presented twice and a stale token never
 * overwrites a newer one. External brokers keep their own tokens; what this
 * port stores for them, under their custody kind, is the protected reference.
 */

export type CredentialCustodyOptions = {
  now?: Clock;
  /** Worker identity prefix for refresh leases; a per-attempt suffix is appended. */
  worker?: string;
  /** How long one upstream refresh may take before another worker may take over. */
  leaseMs?: number;
  /** A credential expiring within this margin is treated as expired by `use`. */
  expirySafetyMarginMs?: number;
  /** Follower poll interval while another worker refreshes. */
  waitMs?: number;
};

export interface ConnectorCredentialCustody extends CredentialCustodyPort {
  /** True when the credential is past, or within the safety margin of, its expiry. */
  needsRefresh(scope: CredentialScope, ref: string): Promise<boolean>;
}

const refPattern = /^cred:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const expiresAtSchema = z.number().int().positive().optional();

function checkScope(scope: unknown): CredentialScope {
  const parsed = credentialScopeSchema.safeParse(scope);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", { detail: "credential.scope" });
  return parsed.data;
}

function checkMaterial(
  scope: CredentialScope,
  material: unknown,
): CredentialMaterial {
  const parsed = credentialMaterialSchema.safeParse(material);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "credential.material",
    });
  if (scope.custody === "host-owned" && !Object.keys(parsed.data).length)
    throw new ConnectorError("invalid-request", {
      detail: "credential.material-empty",
    });
  if (scope.custody === "no-credential" && Object.keys(parsed.data).length)
    throw new ConnectorError("invalid-request", {
      detail: "credential.material-forbidden",
    });
  return Object.freeze({ ...parsed.data });
}

function sameScope(a: CredentialScope, b: CredentialScope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.ownerKind === b.ownerKind &&
    a.ownerId === b.ownerId &&
    a.connectionRef === b.connectionRef &&
    a.bindingRef === b.bindingRef &&
    a.custody === b.custody
  );
}

/**
 * The callback's result must not carry the material. Any string equal to a
 * material value, or containing one at least eight characters long, is
 * refused before the result reaches the caller.
 */
export function assertNoMaterial(
  result: unknown,
  material: CredentialMaterial,
): void {
  const values = Object.values(material).filter((value) => value.length > 0);
  if (!values.length) return;
  const leaks = (text: string) =>
    values.some((value) =>
      value.length >= 8 ? text.includes(value) : text === value,
    );
  const seen = new Set<object>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 32) return;
    if (typeof value === "string") {
      if (leaks(value))
        throw new ConnectorError("denied", {
          detail: "credential.material-in-result",
        });
      return;
    }
    if (value instanceof Uint8Array) {
      if (leaks(Buffer.from(value).toString("utf8")))
        throw new ConnectorError("denied", {
          detail: "credential.material-in-result",
        });
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      for (const [k, v] of value) {
        walk(k, depth + 1);
        walk(v, depth + 1);
      }
      return;
    }
    if (value instanceof Set) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    for (const item of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>))
      walk(item, depth + 1);
  };
  walk(result, 0);
}

export function createCredentialCustodyPort(
  store: AsyncCeremonyStore,
  options: CredentialCustodyOptions = {},
): ConnectorCredentialCustody {
  const time = timeSource(options.now);
  const worker = options.worker ?? `credential-${randomUUID().slice(0, 8)}`;
  const leaseMs = boundedDuration(
    options.leaseMs ?? 30_000,
    "credential.lease",
  );
  const margin = options.expirySafetyMarginMs ?? 30_000;
  if (!Number.isSafeInteger(margin) || margin < 0)
    throw new ConnectorError("invalid-request", { detail: "credential.margin" });
  const waitMs = boundedDuration(options.waitMs ?? 25, "credential.wait", 5000);
  const refreshing = new Map<string, Promise<{ ref: string; expiresAt?: number }>>();

  const load = async (
    tx: AsyncTransaction,
    scope: CredentialScope,
    ref: string,
  ): Promise<{ revision: number; value: StoredCredential } | undefined> => {
    if (!refPattern.test(ref)) return undefined;
    const record = await readRecord(
      tx,
      credentialKey(scope.tenantId, ref),
      storedCredentialSchema,
    );
    if (!record || !sameScope(record.value.scope, scope)) return undefined;
    return record;
  };
  const require = async (
    tx: AsyncTransaction,
    scope: CredentialScope,
    ref: string,
  ) => {
    const record = await load(tx, scope, ref);
    if (!record)
      throw new ConnectorError("not-found", { detail: "credential.unknown" });
    return record;
  };
  const expiring = (value: StoredCredential, at: number) =>
    value.expiresAt !== undefined && value.expiresAt <= at + margin;

  const releaseLease = async (
    tenantId: string,
    ref: string,
    fence: Fence,
  ): Promise<void> => {
    await transact(store, async (tx) => {
      try {
        await tx.assertFence(fence);
      } catch (error) {
        if (error instanceof PersistenceConflict) return;
        throw error;
      }
      await tx.cancel(credentialKey(tenantId, ref));
    }).catch(() => {});
  };

  const custody: ConnectorCredentialCustody = {
    async store(rawScope, rawMaterial, opts = {}) {
      const scope = checkScope(rawScope);
      const material = checkMaterial(scope, rawMaterial);
      const expiresAt = expiresAtSchema.safeParse(opts.expiresAt);
      if (!expiresAt.success)
        throw new ConnectorError("invalid-request", {
          detail: "credential.expires-at",
        });
      if (opts.replaces !== undefined && !refPattern.test(opts.replaces))
        throw new ConnectorError("not-found", { detail: "credential.unknown" });
      const ref = opts.replaces ?? newRef("cred");
      await transact(store, async (tx) => {
        const at = await time(tx);
        const key = credentialKey(scope.tenantId, ref);
        if (opts.replaces !== undefined) {
          const prior = await require(tx, scope, ref);
          await tx.put(
            key,
            compact({
              ...prior.value,
              material,
              expiresAt: expiresAt.data,
              generation: prior.value.generation + 1,
              rotatedAt: at,
            } satisfies StoredCredential),
            prior.revision,
          );
          // A replacement supersedes any refresh still in flight.
          await tx.cancel(key);
          return;
        }
        await tx.put(
          key,
          compact({
            schemaVersion: SCHEMA_VERSION,
            ref,
            scope,
            material,
            expiresAt: expiresAt.data,
            generation: 1,
            createdAt: at,
            rotatedAt: at,
          } satisfies StoredCredential),
          null,
        );
      });
      return ref;
    },

    async use(rawScope, ref, work) {
      const scope = checkScope(rawScope);
      const material = await transact(store, async (tx) => {
        const record = await require(tx, scope, ref);
        const at = await time(tx);
        if (expiring(record.value, at))
          throw new ConnectorError("expired", {
            detail:
              record.value.expiresAt !== undefined &&
              record.value.expiresAt <= at
                ? "credential.expired"
                : "credential.expiring",
          });
        return Object.freeze({ ...record.value.material });
      });
      // The transaction is closed; the callback may take as long as the provider needs.
      const result = await work(material);
      assertNoMaterial(result, material);
      return result;
    },

    async refresh(rawScope, ref, work) {
      const scope = checkScope(rawScope);
      const inflight = refreshing.get(ref);
      if (inflight) return inflight;
      const run = (async () => {
        const attemptWorker = `${worker}-${randomUUID()}`;
        const key = credentialKey(scope.tenantId, ref);
        let baseline: number | undefined;
        const started = Date.now();
        for (;;) {
          const admitted = await transact(store, async (tx) => {
            const record = await require(tx, scope, ref);
            try {
              const fence = await tx.claim(key, attemptWorker, leaseMs);
              return {
                kind: "lead" as const,
                generation: record.value.generation,
                material: Object.freeze({ ...record.value.material }),
                fence,
              };
            } catch (error) {
              if (!(error instanceof PersistenceConflict)) throw error;
              return {
                kind: "follow" as const,
                generation: record.value.generation,
                expiresAt: record.value.expiresAt,
              };
            }
          });
          baseline ??= admitted.generation;
          if (admitted.kind === "follow") {
            if (admitted.generation > baseline)
              return compact({ ref, expiresAt: admitted.expiresAt });
            if (Date.now() - started > leaseMs + 2000)
              throw new ConnectorError("conflict", {
                detail: "credential.refresh-busy",
              });
            await delay(waitMs);
            continue;
          }
          if (admitted.generation > baseline) {
            // Another worker rotated it while we waited; do not rotate again.
            await releaseLease(scope.tenantId, ref, admitted.fence);
            const current = await transact(store, (tx) => require(tx, scope, ref));
            return compact({ ref, expiresAt: current.value.expiresAt });
          }
          let next: { material: CredentialMaterial; expiresAt?: number };
          try {
            next = await work(admitted.material);
          } catch (error) {
            await releaseLease(scope.tenantId, ref, admitted.fence);
            throw error;
          }
          const material = checkMaterial(scope, next?.material);
          const expiresAt = expiresAtSchema.safeParse(next.expiresAt);
          if (!expiresAt.success) {
            await releaseLease(scope.tenantId, ref, admitted.fence);
            throw new ConnectorError("invalid-request", {
              detail: "credential.expires-at",
            });
          }
          return transact(store, async (tx) => {
            try {
              await tx.assertFence(admitted.fence);
            } catch (error) {
              if (error instanceof PersistenceConflict)
                throw new ConnectorError("conflict", {
                  detail: "credential.stale-refresh",
                });
              throw error;
            }
            const record = await require(tx, scope, ref);
            if (record.value.generation !== admitted.generation)
              throw new ConnectorError("conflict", {
                detail: "credential.stale-refresh",
              });
            const at = await time(tx);
            await tx.put(
              key,
              compact({
                ...record.value,
                material,
                expiresAt: expiresAt.data,
                generation: record.value.generation + 1,
                rotatedAt: at,
              } satisfies StoredCredential),
              record.revision,
            );
            await tx.cancel(key);
            return compact({ ref, expiresAt: expiresAt.data });
          });
        }
      })();
      refreshing.set(ref, run);
      try {
        return await run;
      } finally {
        refreshing.delete(ref);
      }
    },

    async revoke(rawScope, ref) {
      const scope = checkScope(rawScope);
      await transact(store, async (tx) => {
        const record = await load(tx, scope, ref);
        if (!record) return;
        const key = credentialKey(scope.tenantId, ref);
        await tx.delete(key, record.revision);
        await tx.cancel(key);
      });
    },

    async describe(rawScope, ref) {
      const scope = checkScope(rawScope);
      return transact(store, async (tx) => {
        const record = await load(tx, scope, ref);
        if (!record) return undefined;
        return compact({
          custody: record.value.scope.custody,
          expiresAt: record.value.expiresAt,
        });
      });
    },

    async needsRefresh(rawScope, ref) {
      const scope = checkScope(rawScope);
      return transact(store, async (tx) => {
        const record = await require(tx, scope, ref);
        return expiring(record.value, await time(tx));
      });
    },
  };
  return custody;
}
