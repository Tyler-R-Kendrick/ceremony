import type { ActorContext } from "../../../core/operation-contracts.js";
import type { ConnectionSummary } from "../../../core/connectors/index.js";
import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import type { Clock, ConnectionRecord } from "../ports.js";
import {
  checkActor,
  compact,
  isoAt,
  notifyCache,
  timeSource,
  transact,
  type CacheInvalidationHook,
} from "./common.js";
import {
  defaultOwnership,
  keyDigestOf,
  loadOwnedConnection,
  saveConnection,
  type ConnectionOwnership,
} from "./connections.js";
import { markEvidenceStale } from "./evidence.js";
import { settlePendingHandoffs } from "./handoffs.js";

/*
 * Revocation and drift invalidation. When the source bytes, the runtime
 * binding revision, the policy revision or the configuration revision behind
 * a connection change, the evidence gathered under the old tuple no longer
 * describes the connection: it is marked stale, the lifecycle leaves
 * `active`, caches are told, and — when the approved artifact set itself
 * changed — the generation moves so callbacks for the old binding cannot
 * land. A stale "connected" badge is never left implying authorization.
 */

export type DriftSignal = {
  sourceDigestChanged?: boolean;
  policyRevisionChanged?: boolean;
  configurationRevisionChanged?: boolean;
  bindingRevisionChanged?: boolean;
};

export type DriftOutcome = {
  lifecycle: ConnectionSummary["lifecycle"];
  generation: number;
  revision: number;
  evidenceInvalidated: number;
  handoffsSettled: number;
  reasons: string[];
};

export interface DriftInvalidator {
  invalidateForDrift(
    actor: ActorContext,
    connectionRef: string,
    drift: DriftSignal,
  ): Promise<DriftOutcome>;
  /** Moves a connection whose verification validity ended out of `active`. */
  expireVerification(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<{ expired: boolean } & Omit<DriftOutcome, "reasons">>;
}

export type DriftOptions = {
  now?: Clock;
  owns?: ConnectionOwnership;
  cacheInvalidation?: CacheInvalidationHook;
};

const terminal = new Set<ConnectionSummary["lifecycle"]>([
  "locally-disconnected",
  "upstream-revoked",
]);

/** Whether a record's verification may still be relied on at `at`; an active connection without evidence may not. */
export function isVerificationCurrent(
  record: ConnectionRecord,
  at: number,
): boolean {
  if (record.lifecycle !== "active" || !record.verification) return false;
  return (
    record.verification.validUntil === undefined ||
    Date.parse(record.verification.validUntil) > at
  );
}

export function createDriftInvalidator(
  store: AsyncCeremonyStore,
  options: DriftOptions = {},
): DriftInvalidator {
  const time = timeSource(options.now);
  const owns = options.owns ?? defaultOwnership;

  return {
    async invalidateForDrift(rawActor, connectionRef, drift) {
      const actor = checkActor(rawActor);
      const reasons: string[] = [];
      if (drift?.sourceDigestChanged) reasons.push("drift.source-digest");
      if (drift?.bindingRevisionChanged) reasons.push("drift.binding-revision");
      if (drift?.policyRevisionChanged) reasons.push("drift.policy-revision");
      if (drift?.configurationRevisionChanged)
        reasons.push("drift.configuration-revision");
      if (!reasons.length)
        throw new ConnectorError("invalid-request", { detail: "drift.empty" });
      const reconnect = Boolean(
        drift.sourceDigestChanged || drift.bindingRevisionChanged,
      );
      const result = await transact(store, async (tx) => {
        const current = await loadOwnedConnection(tx, actor, connectionRef, owns);
        if (!current)
          throw new ConnectorError("not-found", { detail: "connection.unknown" });
        const at = await time(tx);
        const before = current.value.record;
        const evidenceInvalidated = await markEvidenceStale(
          tx,
          actor.tenantId,
          connectionRef,
          reasons[0]!,
          at,
        );
        const keepLifecycle = terminal.has(before.lifecycle);
        const lifecycle: ConnectionSummary["lifecycle"] = keepLifecycle
          ? before.lifecycle
          : reconnect
            ? "reconnect-required"
            : "verifying";
        const advance = !keepLifecycle && reconnect;
        const { verification: _verification, ...rest } = before;
        void _verification;
        const record: ConnectionRecord = {
          ...rest,
          lifecycle,
          generation: advance ? before.generation + 1 : before.generation,
          lastOutcome: reasons[0]!,
          updatedAt: isoAt(at),
        };
        const revision = await saveConnection(
          tx,
          actor.tenantId,
          record,
          compact({ disconnect: current.value.disconnect }),
          current.revision,
        );
        const handoffsSettled = advance
          ? await settlePendingHandoffs(
              tx,
              actor.tenantId,
              connectionRef,
              "superseded",
              reasons[0]!,
              at,
            )
          : 0;
        return { record, revision, evidenceInvalidated, handoffsSettled };
      });
      await notifyCache(options.cacheInvalidation, {
        tenantId: actor.tenantId,
        connectionRef,
        keyDigest: keyDigestOf(result.record),
        authorityInstance: result.record.authorityInstance,
        reason: reasons[0]!,
      });
      return {
        lifecycle: result.record.lifecycle,
        generation: result.record.generation,
        revision: result.revision,
        evidenceInvalidated: result.evidenceInvalidated,
        handoffsSettled: result.handoffsSettled,
        reasons,
      };
    },

    async expireVerification(rawActor, connectionRef) {
      const actor = checkActor(rawActor);
      const result = await transact(store, async (tx) => {
        const current = await loadOwnedConnection(tx, actor, connectionRef, owns);
        if (!current)
          throw new ConnectorError("not-found", { detail: "connection.unknown" });
        const at = await time(tx);
        const before = current.value.record;
        const lapsed =
          before.verification?.validUntil !== undefined &&
          Date.parse(before.verification.validUntil) <= at;
        const evidenceInvalidated = await markEvidenceStale(
          tx,
          actor.tenantId,
          connectionRef,
          "verification.expired",
          at,
          (claim) =>
            claim.validUntil !== undefined && Date.parse(claim.validUntil) <= at,
        );
        if (!lapsed || terminal.has(before.lifecycle))
          return {
            expired: false,
            record: before,
            revision: current.revision,
            evidenceInvalidated,
          };
        const { verification: _verification, ...rest } = before;
        void _verification;
        const record: ConnectionRecord = {
          ...rest,
          lifecycle: "verifying",
          lastOutcome: "verification.expired",
          updatedAt: isoAt(at),
        };
        const revision = await saveConnection(
          tx,
          actor.tenantId,
          record,
          compact({ disconnect: current.value.disconnect }),
          current.revision,
        );
        return { expired: true, record, revision, evidenceInvalidated };
      });
      if (result.expired)
        await notifyCache(options.cacheInvalidation, {
          tenantId: actor.tenantId,
          connectionRef,
          keyDigest: keyDigestOf(result.record),
          authorityInstance: result.record.authorityInstance,
          reason: "verification.expired",
        });
      return {
        expired: result.expired,
        lifecycle: result.record.lifecycle,
        generation: result.record.generation,
        revision: result.revision,
        evidenceInvalidated: result.evidenceInvalidated,
        handoffsSettled: 0,
      };
    },
  };
}
