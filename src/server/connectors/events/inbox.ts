import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { connectorReferenceSchema } from "../../../core/connectors/index.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
  type Fence,
  type RecordKey,
} from "../../persistence/index.js";
import { ConnectorError, explainConnectorError } from "../errors.js";
import {
  authoritySchema,
  verifiedEventEnvelopeSchema,
  type VerifiedEventEnvelopeV1,
} from "./envelope.js";
import {
  dispatchOutcomeSchema,
  lifecycleSignalSchema,
  type DispatchOutcome,
  type EventDelivery,
  type EventHandler,
  type LifecycleSignal,
  type Ordering,
  type ReconcileHook,
} from "./lifecycle.js";
import type { SubscriptionRegistry } from "./subscriptions.js";

/*
 * The inbox is where a verified event becomes durable. Admission writes two
 * records in one transaction: the inbox entry, keyed by a digest of
 * (authority, eventId) inside the tenant, whose first writer wins, and an
 * outbox continuation in the shape the existing continuation dispatcher
 * understands. Delivery later claims the outbox entry with the same
 * lease-and-fence discipline as `deliverContinuations`, hands the envelope to
 * a handler, and records the outcome. Nothing here claims exactly-once: a
 * handler can run twice around a lost fence, so consumers deduplicate by
 * deliveryId. Order is not trusted either: each delivery is labelled by its
 * sender timestamp against a per-connection watermark, and a consumer that
 * sees an out-of-order status change asks the authority instead of applying it.
 */

export const INBOX_KIND = "connector-event-inbox" as const;
export const EVENT_TASK = "connector-event";
const OUTBOX_PREFIX = "connector-event:";
/** Tries at recording a successful handler before leaving it to the next pass. */
const COMMIT_ROUNDS = 2;
const idAlphabet = /^[a-zA-Z0-9_.:@/-]{1,200}$/;
const noControl = /^[^\p{Cc}]+$/u;
export const taskSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const time = z.number().int().nonnegative();
const subjectSchema = z.string().min(1).max(200).regex(noControl);

export const inboxRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deliveryId: z.string().regex(idAlphabet),
  tenantId: z.string().regex(idAlphabet),
  subjectId: subjectSchema,
  task: taskSchema,
  connectionRef: connectorReferenceSchema.optional(),
  subscriptionId: connectorReferenceSchema.optional(),
  /** Connection generation at admission; a later generation makes this delivery stale. */
  generation: time.optional(),
  envelope: verifiedEventEnvelopeSchema,
  lifecycle: lifecycleSignalSchema.optional(),
  admittedAt: time,
  status: z.enum(["admitted", "delivered", "stale", "failed"]),
  outcome: dispatchOutcomeSchema.optional(),
  deliveredAt: time.optional(),
  attempts: time,
});
export type InboxRecord = z.infer<typeof inboxRecordSchema>;

/** The outbox continuation: the existing dispatcher's fields plus the event routing it needs. */
export const eventOutboxSchema = z.strictObject({
  kind: z.literal("connector-event"),
  task: taskSchema,
  subjectId: subjectSchema,
  connectionRef: connectorReferenceSchema.optional(),
  status: z.enum(["pending", "delivered", "failed"]),
  deliveryId: z.string().regex(idAlphabet),
  authority: authoritySchema,
  admittedAt: time,
  attempts: time,
  outcome: dispatchOutcomeSchema.optional(),
});
export type EventOutboxRecord = z.infer<typeof eventOutboxSchema>;

const watermarkSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceTime: time,
  eventId: z.string().min(1).max(512),
  updatedAt: time,
});

const digest = (...parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** The stable delivery id of an event: authority-scoped, so two providers may reuse an id without colliding. */
export function eventDeliveryId(authority: string, eventId: string): string {
  return `${OUTBOX_PREFIX}${digest(authority, eventId)}`;
}

function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value))
    if (item !== undefined) out[name] = item;
  return out as T;
}

function checkTenant(value: string): string {
  if (!idAlphabet.test(value))
    throw new ConnectorError("denied", { detail: "tenant.invalid" });
  return value;
}

export type AdmitInput = {
  tenantId: string;
  /** Owner the continuation is routed to; from the resolved subscription, never from the request. */
  subjectId: string;
  envelope: VerifiedEventEnvelopeV1;
  task?: string;
  connectionRef?: string;
  subscriptionId?: string;
  generation?: number;
  lifecycle?: LifecycleSignal;
};
export type AdmitResult = {
  outcome: "admitted" | "duplicate";
  deliveryId: string;
  admittedAt: number;
};

export type DrainInput = {
  tenantId: string;
  handlers: Readonly<Record<string, EventHandler>>;
  worker?: string;
  /** Deliveries attempted in this call. */
  limit?: number;
  /**
   * After this many handler failures an entry is marked failed and left for
   * an operator. A delivery commit lost to contention is not a handler
   * failure and does not count.
   */
  maxAttempts?: number;
};
export type DrainReport = {
  delivered: number;
  stale: number;
  /** Handler failures (and outbox entries missing their inbox record). */
  failed: number;
  /** Entries not attempted: unparseable, no handler, or leased elsewhere. */
  skipped: number;
  /**
   * Handler succeeded but recording it lost to concurrent writers: the entry
   * stays pending with its attempt count unchanged and is redelivered with the
   * same delivery id on a later pass.
   */
  retried: number;
  outcomes: Array<{
    deliveryId: string;
    outcome: DispatchOutcome | "failed" | "retry";
    stale: boolean;
    ordering: Ordering;
    code?: string;
  }>;
};

export type EventInboxOptions = {
  /** Lets delivery notice a retired or re-approved subscription; the same store, read in the same transaction. */
  subscriptions?: SubscriptionRegistry;
  /** The connection's live generation, from the state layer; called outside any inbox transaction. */
  generation?: (input: {
    tenantId: string;
    connectionRef: string;
  }) => Promise<number | undefined>;
  reconcile?: ReconcileHook;
  leaseMs?: number;
};

export class EventInbox {
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly options: EventInboxOptions = {},
  ) {}

  private inboxKey(tenantId: string, deliveryId: string): RecordKey {
    return { tenant: tenantId, kind: INBOX_KIND, id: deliveryId };
  }
  private outboxKey(tenantId: string, deliveryId: string): RecordKey {
    return { tenant: tenantId, kind: "outbox", id: deliveryId };
  }
  private watermarkKey(
    tenantId: string,
    record: Pick<InboxRecord, "envelope" | "connectionRef" | "subscriptionId">,
  ): RecordKey {
    return {
      tenant: tenantId,
      kind: INBOX_KIND,
      id: `watermark:${digest(
        record.envelope.authority,
        record.connectionRef ?? record.subscriptionId ?? "",
      )}`,
    };
  }

  private async transact<T>(
    work: (tx: AsyncTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.store.transaction(work);
    } catch (error) {
      if (error instanceof PersistenceConflict)
        throw new ConnectorError("conflict", { cause: error });
      throw error;
    }
  }

  /**
   * Checks a delivery's fence taking locks in the order every other writer of
   * the entry does: its outbox record first, then its claim. Taking a claim
   * reads the outbox record before claiming it, so checking the fence first
   * would lock the two the other way round, and PostgreSQL breaks that cycle
   * by aborting one side as a deadlock victim. This is the order
   * `deliverContinuations` already uses for the same reason.
   */
  private async holdFence(
    tx: AsyncTransaction,
    outboxKey: RecordKey,
    fence: Fence,
  ): Promise<void> {
    await tx.get(outboxKey);
    await tx.assertFence(fence);
  }

  /**
   * Records an event once per (tenant, authority, eventId) and enqueues its
   * continuation in the same transaction. A repeated delivery returns
   * `duplicate` with the first admission's identity and writes nothing; under
   * concurrent writers the store's insert-if-absent decides who was first.
   */
  async admit(input: AdmitInput, tx?: AsyncTransaction): Promise<AdmitResult> {
    const tenantId = checkTenant(input.tenantId);
    const envelope = verifiedEventEnvelopeSchema.safeParse(input.envelope);
    if (!envelope.success)
      throw new ConnectorError("invalid-request", {
        detail: "events.envelope.invalid",
        cause: envelope.error,
      });
    const deliveryId = eventDeliveryId(
      envelope.data.authority,
      envelope.data.eventId,
    );
    const work = async (tx: AsyncTransaction): Promise<AdmitResult> => {
      const key = this.inboxKey(tenantId, deliveryId);
      const duplicate = (
        existing: { value: unknown } | undefined,
      ): AdmitResult | undefined => {
        if (!existing) return undefined;
        const parsed = inboxRecordSchema.safeParse(existing.value);
        return {
          outcome: "duplicate",
          deliveryId,
          admittedAt: parsed.success ? parsed.data.admittedAt : 0,
        };
      };
      const seen = duplicate(await tx.get(key));
      if (seen) return seen;
      const admittedAt = await tx.now();
      const record = inboxRecordSchema.parse(
        compact({
          schemaVersion: 1,
          deliveryId,
          tenantId,
          subjectId: input.subjectId,
          task: input.task ?? EVENT_TASK,
          connectionRef: input.connectionRef,
          subscriptionId: input.subscriptionId,
          generation: input.generation,
          envelope: envelope.data,
          lifecycle: input.lifecycle,
          admittedAt,
          status: "admitted",
          attempts: 0,
        }),
      );
      try {
        await tx.put(key, record, null);
      } catch (error) {
        if (!(error instanceof PersistenceConflict)) throw error;
        // Another writer committed first; its record is the one that counts.
        const raced = duplicate(await tx.get(key));
        if (raced) return raced;
        throw new ConnectorError("conflict", { cause: error });
      }
      const outbox: EventOutboxRecord = eventOutboxSchema.parse(
        compact({
          kind: "connector-event",
          task: record.task,
          subjectId: record.subjectId,
          connectionRef: record.connectionRef,
          status: "pending",
          deliveryId,
          authority: envelope.data.authority,
          admittedAt,
          attempts: 0,
        }),
      );
      await tx.put(this.outboxKey(tenantId, deliveryId), outbox, null);
      return { outcome: "admitted", deliveryId, admittedAt };
    };
    return tx ? work(tx) : this.transact(work);
  }

  async get(
    tenantId: string,
    deliveryId: string,
  ): Promise<InboxRecord | undefined> {
    const stored = await this.store.transaction((tx) =>
      tx.get(this.inboxKey(checkTenant(tenantId), deliveryId)),
    );
    if (!stored) return undefined;
    const parsed = inboxRecordSchema.safeParse(stored.value);
    return parsed.success ? parsed.data : undefined;
  }

  async outbox(
    tenantId: string,
    deliveryId: string,
  ): Promise<EventOutboxRecord | undefined> {
    const stored = await this.store.transaction((tx) =>
      tx.get(this.outboxKey(checkTenant(tenantId), deliveryId)),
    );
    if (!stored) return undefined;
    const parsed = eventOutboxSchema.safeParse(stored.value);
    return parsed.success ? parsed.data : undefined;
  }

  private async ordering(
    tx: AsyncTransaction,
    tenantId: string,
    record: InboxRecord,
  ): Promise<Ordering> {
    const sourceTime = record.envelope.sourceTime;
    if (sourceTime === undefined) return "unknown";
    const mark = await tx.get(this.watermarkKey(tenantId, record));
    if (!mark) return "in-order";
    const parsed = watermarkSchema.safeParse(mark.value);
    if (!parsed.success) return "unknown";
    if (sourceTime < parsed.data.sourceTime) return "out-of-order";
    if (
      sourceTime === parsed.data.sourceTime &&
      parsed.data.eventId !== record.envelope.eventId
    )
      return "ambiguous";
    return "in-order";
  }

  private async advanceWatermark(
    tx: AsyncTransaction,
    tenantId: string,
    record: InboxRecord,
  ): Promise<void> {
    const sourceTime = record.envelope.sourceTime;
    if (sourceTime === undefined) return;
    const key = this.watermarkKey(tenantId, record);
    const mark = await tx.get(key);
    const parsed = mark ? watermarkSchema.safeParse(mark.value) : undefined;
    if (parsed?.success && parsed.data.sourceTime > sourceTime) return;
    await tx.put(
      key,
      {
        schemaVersion: 1,
        sourceTime,
        eventId: record.envelope.eventId,
        updatedAt: await tx.now(),
      },
      mark?.revision ?? null,
    );
  }

  /** Stale when the subscription is gone, retired or re-approved under a newer generation. */
  private async subscriptionStale(
    tx: AsyncTransaction,
    record: InboxRecord,
  ): Promise<boolean> {
    if (!record.subscriptionId || !this.options.subscriptions) return false;
    const subscription = await this.options.subscriptions.readIn(
      tx,
      record.tenantId,
      record.subscriptionId,
    );
    if (!subscription || subscription.state === "retired") return true;
    return (
      record.generation !== undefined &&
      subscription.generation !== record.generation
    );
  }

  /**
   * Delivers pending continuations for one tenant. Each entry is leased under
   * a worker fence before its handler runs and released afterwards; a handler
   * failure keeps the entry pending with its attempt count, and a lost fence
   * leaves the outcome to the next worker. A successful handler whose outcome
   * cannot be recorded because of contention is reported as `retry` and
   * redelivered later without consuming an attempt.
   */
  async drain(input: DrainInput): Promise<DrainReport> {
    const tenantId = checkTenant(input.tenantId);
    const worker = input.worker ?? `events-${randomUUID()}`;
    const limit = input.limit ?? 100;
    const maxAttempts = input.maxAttempts ?? 8;
    const lease = this.options.leaseMs ?? 30_000;
    const report: DrainReport = {
      delivered: 0,
      stale: 0,
      failed: 0,
      skipped: 0,
      retried: 0,
      outcomes: [],
    };
    let after = OUTBOX_PREFIX;
    let attempted = 0;
    scan: for (;;) {
      const page = await this.store.transaction((tx) =>
        tx.list<unknown>(tenantId, "outbox", 100, after),
      );
      for (const entry of page) {
        if (!entry.id.startsWith(OUTBOX_PREFIX)) break scan;
        const parsed = eventOutboxSchema.safeParse(entry.value);
        if (!parsed.success) {
          report.skipped++;
          continue;
        }
        const pending = parsed.data;
        if (pending.status !== "pending") continue;
        const handler = input.handlers[pending.task];
        if (!handler) {
          report.skipped++;
          continue;
        }
        if (attempted >= limit) break scan;
        attempted++;
        const outboxKey = this.outboxKey(tenantId, entry.id);
        const inboxKey = this.inboxKey(tenantId, entry.id);
        const claimed = await this.store
          .transaction(async (tx) => {
            const current = await tx.get<unknown>(outboxKey);
            const value = current
              ? eventOutboxSchema.safeParse(current.value)
              : undefined;
            if (!current || !value?.success || value.data.status !== "pending")
              return undefined;
            const fence = await tx.claim(outboxKey, worker, lease);
            const stored = await tx.get<unknown>(inboxKey);
            const record = stored
              ? inboxRecordSchema.safeParse(stored.value)
              : undefined;
            if (!stored || !record?.success)
              return { fence, revision: current.revision, value: value.data };
            return {
              fence,
              revision: current.revision,
              value: value.data,
              inboxRevision: stored.revision,
              record: record.data,
              stale: await this.subscriptionStale(tx, record.data),
              ordering: await this.ordering(tx, tenantId, record.data),
            };
          })
          .catch(() => {
            // Taking the lease is speculative and contended: another worker
            // holds it (PersistenceConflict), or the database refused this
            // transaction outright because several workers touched the same
            // claim rows at once, which PostgreSQL reports as a deadlock
            // rather than as a conflict. Either way this worker does not own
            // the entry, so it moves on; the entry stays pending and the next
            // pass picks it up. Nothing has been delivered at this point, so
            // skipping cannot lose or duplicate an effect.
            return undefined;
          });
        if (!claimed) {
          report.skipped++;
          continue;
        }
        if (!claimed.record) {
          // An outbox entry without its inbox record cannot be delivered; park it.
          await this.store
            .transaction(async (tx) => {
              await this.holdFence(tx, outboxKey, claimed.fence);
              await tx.put(
                outboxKey,
                { ...claimed.value, status: "failed" },
                claimed.revision,
              );
              await tx.cancel(outboxKey);
            })
            .catch(() => {});
          report.failed++;
          report.outcomes.push({
            deliveryId: entry.id,
            outcome: "failed",
            stale: false,
            ordering: "unknown",
            code: "not-found",
          });
          continue;
        }
        const record = claimed.record;
        let stale = claimed.stale;
        if (
          !stale &&
          record.connectionRef &&
          record.generation !== undefined &&
          this.options.generation
        ) {
          const current = await this.options.generation({
            tenantId,
            connectionRef: record.connectionRef,
          });
          if (current !== undefined && current > record.generation)
            stale = true;
        }
        const delivery: EventDelivery = compact({
          tenantId,
          subjectId: record.subjectId,
          connectionRef: record.connectionRef,
          subscriptionId: record.subscriptionId,
          deliveryId: entry.id,
          envelope: record.envelope,
          generation: record.generation,
          stale,
          ordering: claimed.ordering,
          lifecycle: record.lifecycle,
          attempt: record.attempts + 1,
          reconcile: async () => {
            if (!this.options.reconcile || !record.connectionRef)
              return "unsupported";
            return this.options.reconcile(
              compact({
                tenantId,
                subjectId: record.subjectId,
                connectionRef: record.connectionRef,
                subscriptionId: record.subscriptionId,
                reason: stale
                  ? "stale"
                  : claimed.ordering === "ambiguous"
                    ? "ambiguous"
                    : "out-of-order",
              }),
            );
          },
        });
        let outcome: DispatchOutcome;
        try {
          outcome = (await handler(delivery)) ?? "applied";
        } catch (error) {
          report.failed++;
          report.outcomes.push({
            deliveryId: entry.id,
            outcome: "failed",
            stale,
            ordering: claimed.ordering,
            code: explainConnectorError(error).code,
          });
          // The handler may already have applied the effect: keep the delivery id and let a consumer deduplicate on retry.
          await this.store
            .transaction(async (tx) => {
              await this.holdFence(tx, outboxKey, claimed.fence);
              const attempts = claimed.value.attempts + 1;
              const exhausted = attempts >= maxAttempts;
              await tx.put(
                outboxKey,
                {
                  ...claimed.value,
                  attempts,
                  ...(exhausted ? { status: "failed" } : {}),
                },
                claimed.revision,
              );
              await tx.put(
                inboxKey,
                {
                  ...record,
                  attempts,
                  ...(exhausted ? { status: "failed" } : {}),
                },
                claimed.inboxRevision,
              );
              await tx.cancel(outboxKey);
            })
            .catch(() => {});
          continue;
        }
        const commit = () =>
          this.store.transaction(async (tx) => {
            await this.holdFence(tx, outboxKey, claimed.fence);
            const deliveredAt = await tx.now();
            await tx.put(
              outboxKey,
              {
                ...claimed.value,
                status: "delivered",
                outcome,
                attempts: claimed.value.attempts + 1,
              },
              claimed.revision,
            );
            await tx.put(
              inboxKey,
              {
                ...record,
                status: stale ? "stale" : "delivered",
                outcome,
                deliveredAt,
                attempts: record.attempts + 1,
              },
              claimed.inboxRevision,
            );
            if (!stale) await this.advanceWatermark(tx, tenantId, record);
            await tx.cancel(outboxKey);
          });
        /*
         * The handler succeeded; only recording that is left. Concurrent
         * workers delivering different events of one connection all advance
         * the same ordering watermark and race for the same claims, so this
         * commit can still lose a revision race, its fence, or be chosen as a
         * PostgreSQL deadlock or serialization victim (which the store reports
         * only as an opaque persistence error). That is contention, not a
         * failed attempt: counting it would park an effect that already
         * happened once enough commits lost. One immediate retry is safe
         * because each try re-asserts the fence and writes against the
         * revisions read at claim time, so it can only land while this worker
         * still owns an entry nobody else has touched. If it still loses, the
         * claim is released with the attempt count unchanged and the next pass
         * redelivers the same delivery id, which the consumer deduplicates.
         */
        let lost: unknown;
        let committed = false;
        for (let round = 0; round < COMMIT_ROUNDS && !committed; round++)
          await commit().then(
            () => {
              committed = true;
            },
            (error: unknown) => {
              lost = error;
            },
          );
        if (!committed) {
          await this.store
            .transaction(async (tx) => {
              await this.holdFence(tx, outboxKey, claimed.fence);
              await tx.cancel(outboxKey);
            })
            .catch(() => {});
          report.retried++;
          report.outcomes.push({
            deliveryId: entry.id,
            outcome: "retry",
            stale,
            ordering: claimed.ordering,
            code: explainConnectorError(lost).code,
          });
          continue;
        }
        if (stale) report.stale++;
        else report.delivered++;
        report.outcomes.push({
          deliveryId: entry.id,
          outcome,
          stale,
          ordering: claimed.ordering,
        });
      }
      if (page.length < 100) break;
      after = page.at(-1)!.id;
    }
    return report;
  }
}
