import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { ActorContext } from "../../../core/operation-contracts.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type Fence,
} from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import type {
  Clock,
  EffectIntent,
  EffectJournalPort,
  EffectOutcome,
} from "../ports.js";
import {
  SCHEMA_VERSION,
  boundedDuration,
  checkActor,
  compact,
  isReference,
  newRef,
  readRecord,
  registerRef,
  resolveRef,
  scanPrefix,
  timeSource,
  transact,
} from "./common.js";
import { effectKey, intentKey } from "./keys.js";
import {
  effectIntentInputSchema,
  effectOutcomeSchema,
  effectPointerSchema,
  storedEffectSchema,
  type StoredEffect,
} from "./schemas.js";

/*
 * The effect journal persists intent before any consequential call. `begin`
 * commits and returns before the caller contacts a provider, so no transaction
 * is open while the network is; a repeated (tenant, operation, digest) returns
 * the earlier outcome instead of a second effect. An effect that was begun but
 * never completed is ambiguous: while its worker's lease is alive it is
 * reported in flight, and once the lease lapsed it is marked orphaned and
 * reported `indeterminate` for reconciliation. A worker whose lease lapsed
 * cannot record a late outcome over that decision.
 */

export type EffectJournalOptions = {
  now?: Clock;
  worker?: string;
  /** Lease a begun effect holds; heartbeat it for longer calls. */
  leaseMs?: number;
};

export type UnresolvedEffect = {
  effectRef: string;
  operation: string;
  digest: string;
  status: "begun" | "orphaned";
  beganAt: number;
  connectionRef?: string;
  bindingRef?: string;
  commandId?: string;
  outcome?: EffectOutcome;
};

export interface ConnectorEffectJournal extends EffectJournalPort {
  /** Extends the lease of an effect this process began. */
  heartbeat(effectRef: string): Promise<void>;
  /** Records the reconciled outcome of an orphaned or expired effect; refused while its worker is alive. */
  reconcile(
    actor: ActorContext,
    effectRef: string,
    outcome: EffectOutcome,
  ): Promise<EffectOutcome>;
  /** Effects of the actor's tenant with no recorded outcome, for a reconciliation pass. */
  listUnresolved(actor: ActorContext): Promise<UnresolvedEffect[]>;
  /**
   * begin → call → complete, with the call outside every transaction. A prior
   * outcome short-circuits the call; a thrown call records `indeterminate`.
   */
  execute<T>(
    intent: EffectIntent,
    work: (effectRef: string) => Promise<{ outcome: EffectOutcome; value: T }>,
  ): Promise<{ effectRef: string; prior?: EffectOutcome; value?: T }>;
}

/** Same value, exact-optional type: zod spells an absent `code` as `code?: string | undefined`. */
const asOutcome = (
  outcome: z.infer<typeof effectOutcomeSchema>,
): EffectOutcome => compact(outcome) as EffectOutcome;

const checkOutcome = (outcome: unknown): EffectOutcome => {
  const parsed = effectOutcomeSchema.safeParse(outcome);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", { detail: "effect.outcome" });
  return asOutcome(parsed.data);
};

export function createEffectJournalPort(
  store: AsyncCeremonyStore,
  options: EffectJournalOptions = {},
): ConnectorEffectJournal {
  const time = timeSource(options.now);
  const worker = options.worker ?? `effect-${randomUUID().slice(0, 8)}`;
  const leaseMs = boundedDuration(options.leaseMs ?? 60_000, "effect.lease");
  const fences = new Map<string, Fence>();

  const journal: ConnectorEffectJournal = {
    async begin(intent) {
      const actor = checkActor(intent.actor);
      const { actor: _actor, ...rest } = intent;
      void _actor;
      const parsed = effectIntentInputSchema.safeParse(rest);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "effect.intent",
        });
      const input = parsed.data;
      const attemptWorker = `${worker}-${randomUUID()}`;
      const pointerKey = intentKey(
        actor.tenantId,
        input.operation,
        input.digest,
      );
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await transact(store, async (tx) => {
            const at = await time(tx);
            const pointer = await readRecord(
              tx,
              pointerKey,
              effectPointerSchema,
            );
            if (pointer) {
              const key = effectKey(actor.tenantId, pointer.value.effectRef);
              const existing = await readRecord(tx, key, storedEffectSchema);
              if (!existing)
                throw new Error("Connector record is not readable");
              if (existing.value.outcome)
                return {
                  effectRef: pointer.value.effectRef,
                  prior: existing.value.outcome,
                };
              try {
                // Succeeds only when the beginning worker's lease lapsed: an orphan.
                await tx.claim(key, attemptWorker, leaseMs);
              } catch (error) {
                if (!(error instanceof PersistenceConflict)) throw error;
                return {
                  effectRef: pointer.value.effectRef,
                  prior: {
                    status: "indeterminate" as const,
                    code: "effect.in-flight",
                    at,
                  },
                };
              }
              const outcome: EffectOutcome = {
                status: "indeterminate",
                code: "effect.orphaned",
                at,
              };
              await tx.put(
                key,
                {
                  ...existing.value,
                  status: "orphaned",
                  outcome,
                } satisfies StoredEffect,
                existing.revision,
              );
              await tx.cancel(key);
              return { effectRef: pointer.value.effectRef, prior: outcome };
            }
            const effectRef = newRef("effect");
            const key = effectKey(actor.tenantId, effectRef);
            const record: StoredEffect = {
              schemaVersion: SCHEMA_VERSION,
              ...input,
              effectRef,
              tenantId: actor.tenantId,
              subjectId: actor.subjectId,
              sessionId: actor.sessionId,
              actorKind: actor.actorKind,
              beganAt: at,
              worker: attemptWorker,
              status: "begun",
            };
            await tx.put(key, compact(record), null);
            const fence = await tx.claim(key, attemptWorker, leaseMs);
            // Insert-if-absent: a concurrent begin for the same intent loses here and re-reads.
            await tx.put(
              pointerKey,
              { schemaVersion: SCHEMA_VERSION, effectRef },
              null,
            );
            await registerRef(
              tx,
              "connector-effect",
              effectRef,
              actor.tenantId,
              "effect.ref-conflict",
            );
            return { effectRef, fence };
          });
          if (result.fence) fences.set(result.effectRef, result.fence);
          return {
            effectRef: result.effectRef,
            ...(result.prior ? { prior: asOutcome(result.prior) } : {}),
          };
        } catch (error) {
          if (
            attempt === 0 &&
            error instanceof ConnectorError &&
            error.code === "conflict"
          )
            continue;
          throw error;
        }
      }
    },

    async complete(effectRef, rawOutcome) {
      const outcome = checkOutcome(rawOutcome);
      if (!isReference(effectRef))
        throw new ConnectorError("not-found", { detail: "effect.unknown" });
      const fence = fences.get(effectRef);
      await transact(store, async (tx) => {
        const tenantId = await resolveRef(tx, "connector-effect", effectRef);
        if (!tenantId)
          throw new ConnectorError("not-found", { detail: "effect.unknown" });
        const key = effectKey(tenantId, effectRef);
        const record = await readRecord(tx, key, storedEffectSchema);
        if (!record)
          throw new ConnectorError("not-found", { detail: "effect.unknown" });
        if (record.value.status === "completed") {
          if (record.value.outcome?.status === outcome.status) return;
          throw new ConnectorError("conflict", {
            detail: "effect.already-completed",
          });
        }
        // Only the worker that began this effect may record its outcome, and
        // only while its lease is alive. An orphaned effect is reconciled
        // through `reconcile`, which takes the lease first; nothing else may
        // write over an indeterminate outcome.
        if (!fence)
          throw new ConnectorError("conflict", { detail: "effect.not-owner" });
        try {
          await tx.assertFence(fence);
        } catch (error) {
          if (error instanceof PersistenceConflict)
            throw new ConnectorError("conflict", {
              detail: "effect.lease-lost",
            });
          throw error;
        }
        await tx.put(
          key,
          {
            ...record.value,
            status: "completed",
            outcome,
            completedAt: await time(tx),
          } satisfies StoredEffect,
          record.revision,
        );
        await tx.cancel(key);
      });
      fences.delete(effectRef);
    },

    async get(rawActor, effectRef) {
      const actor = checkActor(rawActor);
      if (!isReference(effectRef)) return undefined;
      return transact(store, async (tx) => {
        const record = await readRecord(
          tx,
          effectKey(actor.tenantId, effectRef),
          storedEffectSchema,
        );
        if (!record || record.value.tenantId !== actor.tenantId)
          return undefined;
        return record.value.outcome && asOutcome(record.value.outcome);
      });
    },

    async heartbeat(effectRef) {
      const fence = fences.get(effectRef);
      if (!fence)
        throw new ConnectorError("conflict", { detail: "effect.not-owner" });
      await transact(store, async (tx) => {
        try {
          await tx.heartbeat(fence, leaseMs);
        } catch (error) {
          if (error instanceof PersistenceConflict)
            throw new ConnectorError("conflict", {
              detail: "effect.lease-lost",
            });
          throw error;
        }
      });
    },

    async reconcile(rawActor, effectRef, rawOutcome) {
      const actor = checkActor(rawActor);
      const outcome = checkOutcome(rawOutcome);
      if (!isReference(effectRef))
        throw new ConnectorError("not-found", { detail: "effect.unknown" });
      const attemptWorker = `${worker}-${randomUUID()}`;
      const result = await transact(store, async (tx) => {
        const key = effectKey(actor.tenantId, effectRef);
        const record = await readRecord(tx, key, storedEffectSchema);
        if (!record || record.value.tenantId !== actor.tenantId)
          throw new ConnectorError("not-found", { detail: "effect.unknown" });
        if (
          record.value.status === "completed" &&
          record.value.outcome?.status !== "indeterminate"
        )
          throw new ConnectorError("conflict", {
            detail: "effect.already-completed",
          });
        try {
          await tx.claim(key, attemptWorker, leaseMs);
        } catch (error) {
          if (error instanceof PersistenceConflict)
            throw new ConnectorError("conflict", {
              detail: "effect.in-flight",
            });
          throw error;
        }
        await tx.put(
          key,
          {
            ...record.value,
            status: "completed",
            outcome,
            completedAt: await time(tx),
          } satisfies StoredEffect,
          record.revision,
        );
        await tx.cancel(key);
        return outcome;
      });
      fences.delete(effectRef);
      return result;
    },

    async listUnresolved(rawActor) {
      const actor = checkActor(rawActor);
      return transact(store, async (tx) => {
        const items: UnresolvedEffect[] = [];
        await scanPrefix(
          tx,
          actor.tenantId,
          "connector-effect",
          "effect:",
          storedEffectSchema,
          ({ value }) => {
            if (value.status === "completed") return;
            items.push(
              compact({
                effectRef: value.effectRef,
                operation: value.operation,
                digest: value.digest,
                status: value.status,
                beganAt: value.beganAt,
                connectionRef: value.connectionRef,
                bindingRef: value.bindingRef,
                commandId: value.commandId,
                outcome: value.outcome && asOutcome(value.outcome),
              }),
            );
          },
        );
        return items;
      });
    },

    async execute(intent, work) {
      const begun = await journal.begin(intent);
      if (begun.prior)
        return { effectRef: begun.effectRef, prior: begun.prior };
      let result: { outcome: EffectOutcome; value: unknown };
      try {
        result = await work(begun.effectRef);
      } catch (error) {
        // A transport exception is not evidence that the effect did not happen.
        await journal
          .complete(begun.effectRef, {
            status: "indeterminate",
            code: "effect.threw",
            at: options.now?.() ?? Date.now(),
          })
          .catch(() => {});
        throw error;
      }
      await journal.complete(begun.effectRef, result.outcome);
      return {
        effectRef: begun.effectRef,
        value: result.value as Awaited<ReturnType<typeof work>>["value"],
      };
    },
  };
  return journal;
}
