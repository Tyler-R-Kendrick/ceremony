import type { ActorContext } from "../../../core/operation-contracts.js";
import {
  verificationClaimSchema,
  type VerificationClaim,
} from "../../../core/connectors/index.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
} from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import type { Clock, EvidenceStorePort } from "../ports.js";
import {
  SCHEMA_VERSION,
  checkActor,
  readRecord,
  sameJson,
  scanPrefix,
  timeSource,
  transact,
} from "./common.js";
import {
  defaultOwnership,
  loadOwnedConnection,
  type ConnectionOwnership,
} from "./connections.js";
import { evidenceKey, evidencePrefix } from "./keys.js";
import { stateCodeSchema, storedEvidenceSchema } from "./schemas.js";

/*
 * Verification claims per connection. A claim is an observation that cannot
 * be repeated, so it is never edited: drift marks it stale with a reason and
 * `list` stops returning it. Appending is owner-scoped through the connection
 * record, and a claim reference is one-use: the same claim again is a no-op,
 * a different claim under the same reference is a conflict.
 */

export type EvidenceStoreOptions = { now?: Clock; owns?: ConnectionOwnership };

export type EvidenceEntry = {
  claim: VerificationClaim;
  appendedAt: number;
  stale?: { reason: string; at: number };
};

export interface ConnectorEvidenceStore extends EvidenceStorePort {
  /** Current and stale claims with their invalidation reasons. */
  listAll(actor: ActorContext, connectionRef: string): Promise<EvidenceEntry[]>;
  /** Marks claims whose validity ended; returns the count. */
  invalidateExpired(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<number>;
}

/** Marks matching current claims stale inside the caller's transaction. */
export async function markEvidenceStale(
  tx: AsyncTransaction,
  tenantId: string,
  connectionRef: string,
  reason: string,
  at: number,
  only: (claim: VerificationClaim) => boolean = () => true,
): Promise<number> {
  const targets: Array<{ id: string; revision: number; value: unknown }> = [];
  await scanPrefix(
    tx,
    tenantId,
    "connector-evidence",
    evidencePrefix(connectionRef),
    storedEvidenceSchema,
    ({ id, revision, value }) => {
      if (!value.stale && only(value.claim))
        targets.push({
          id,
          revision,
          value: { ...value, stale: { reason, at } },
        });
    },
  );
  for (const target of targets)
    await tx.put(
      { tenant: tenantId, kind: "connector-evidence", id: target.id },
      target.value,
      target.revision,
    );
  return targets.length;
}

export function createEvidenceStore(
  store: AsyncCeremonyStore,
  options: EvidenceStoreOptions = {},
): ConnectorEvidenceStore {
  const time = timeSource(options.now);
  const owns = options.owns ?? defaultOwnership;
  const collect = async (
    tx: AsyncTransaction,
    tenantId: string,
    connectionRef: string,
  ): Promise<EvidenceEntry[]> => {
    const entries: EvidenceEntry[] = [];
    await scanPrefix(
      tx,
      tenantId,
      "connector-evidence",
      evidencePrefix(connectionRef),
      storedEvidenceSchema,
      ({ value }) => {
        entries.push({
          claim: structuredClone(value.claim),
          appendedAt: value.appendedAt,
          ...(value.stale ? { stale: { ...value.stale } } : {}),
        });
      },
    );
    return entries.sort((a, b) =>
      a.claim.observedAt < b.claim.observedAt
        ? -1
        : a.claim.observedAt > b.claim.observedAt
          ? 1
          : a.claim.evidenceRef.localeCompare(b.claim.evidenceRef),
    );
  };

  return {
    async append(rawActor, connectionRef, rawClaim) {
      const actor = checkActor(rawActor);
      const parsed = verificationClaimSchema.safeParse(rawClaim);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "evidence.claim",
        });
      const claim = parsed.data;
      await transact(store, async (tx) => {
        const connection = await loadOwnedConnection(
          tx,
          actor,
          connectionRef,
          owns,
        );
        if (!connection)
          throw new ConnectorError("not-found", {
            detail: "connection.unknown",
          });
        const key = evidenceKey(
          actor.tenantId,
          connectionRef,
          claim.evidenceRef,
        );
        const existing = await readRecord(tx, key, storedEvidenceSchema);
        if (existing) {
          if (sameJson(existing.value.claim, claim)) return;
          throw new ConnectorError("conflict", {
            detail: "evidence.ref-in-use",
          });
        }
        try {
          await tx.put(
            key,
            {
              schemaVersion: SCHEMA_VERSION,
              connectionRef,
              claim,
              appendedAt: await time(tx),
            },
            null,
          );
        } catch (error) {
          if (error instanceof PersistenceConflict)
            throw new ConnectorError("conflict", {
              detail: "evidence.ref-in-use",
            });
          throw error;
        }
      });
      return claim.evidenceRef;
    },

    async list(rawActor, connectionRef) {
      const actor = checkActor(rawActor);
      return transact(store, async (tx) => {
        if (!(await loadOwnedConnection(tx, actor, connectionRef, owns)))
          return [];
        return (await collect(tx, actor.tenantId, connectionRef))
          .filter((entry) => !entry.stale)
          .map((entry) => entry.claim);
      });
    },

    async listAll(rawActor, connectionRef) {
      const actor = checkActor(rawActor);
      return transact(store, async (tx) => {
        if (!(await loadOwnedConnection(tx, actor, connectionRef, owns)))
          return [];
        return collect(tx, actor.tenantId, connectionRef);
      });
    },

    async invalidate(rawActor, connectionRef, reason) {
      const actor = checkActor(rawActor);
      const code = stateCodeSchema.safeParse(reason);
      if (!code.success)
        throw new ConnectorError("invalid-request", {
          detail: "evidence.reason",
        });
      return transact(store, async (tx) => {
        if (!(await loadOwnedConnection(tx, actor, connectionRef, owns)))
          return 0;
        return markEvidenceStale(
          tx,
          actor.tenantId,
          connectionRef,
          code.data,
          await time(tx),
        );
      });
    },

    async invalidateExpired(rawActor, connectionRef) {
      const actor = checkActor(rawActor);
      return transact(store, async (tx) => {
        if (!(await loadOwnedConnection(tx, actor, connectionRef, owns)))
          return 0;
        const at = await time(tx);
        return markEvidenceStale(
          tx,
          actor.tenantId,
          connectionRef,
          "verification.expired",
          at,
          (claim) =>
            claim.validUntil !== undefined &&
            Date.parse(claim.validUntil) <= at,
        );
      });
    },
  };
}
