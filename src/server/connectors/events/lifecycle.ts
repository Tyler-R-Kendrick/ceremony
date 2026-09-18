import { z } from "zod";
import type { CompletionInput } from "../adapter.js";
import type { VerifiedEventEnvelopeV1 } from "./envelope.js";

/*
 * Delivery vocabulary shared by the inbox, the receiver and the dispatcher.
 * A lifecycle signal is what a receiver policy read out of a provider's event
 * type; it is a hint about intent, not a state change. The dispatcher turns a
 * delivery into a CompletionInput for the owning adapter, and it is the one
 * place that knows a stale delivery must be ignored and an out-of-order status
 * must be reconciled against the authority rather than applied.
 */

export const lifecycleKinds = [
  "revoked",
  "expired",
  "reconnected",
  "deleted",
  "suspended",
  "error",
] as const;
export const lifecycleSignalSchema = z.strictObject({
  kind: z.enum(lifecycleKinds),
  /** The provider's identifier for the affected connection, when the event names one. */
  externalId: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
});
export type LifecycleSignal = z.infer<typeof lifecycleSignalSchema>;

export const dispatchOutcomes = [
  "applied",
  "ignored",
  "reconciled",
  "indeterminate",
] as const;
export const dispatchOutcomeSchema = z.enum(dispatchOutcomes);
export type DispatchOutcome = z.infer<typeof dispatchOutcomeSchema>;

/** Where a delivery sits relative to what this connection already saw; decided from sourceTime, never arrival. */
export const orderings = [
  "in-order",
  "out-of-order",
  "ambiguous",
  "unknown",
] as const;
export type Ordering = (typeof orderings)[number];

export type ReconcileOutcome = "reconciled" | "unavailable" | "unsupported";
export type ReconcileHook = (input: {
  tenantId: string;
  subjectId: string;
  connectionRef: string;
  subscriptionId?: string;
  reason: "out-of-order" | "ambiguous" | "stale";
}) => Promise<ReconcileOutcome>;

export type EventDelivery = {
  tenantId: string;
  subjectId: string;
  connectionRef?: string;
  subscriptionId?: string;
  deliveryId: string;
  envelope: VerifiedEventEnvelopeV1;
  /** Connection generation recorded at admission. */
  generation?: number;
  /** The generation advanced (cancel, reconnect, unlink) after admission; a consumer must not apply it. */
  stale: boolean;
  ordering: Ordering;
  lifecycle?: LifecycleSignal;
  attempt: number;
  /** Asks the authoritative API for the connection's real status instead of trusting event order. */
  reconcile(): Promise<ReconcileOutcome>;
};
export type EventHandler = (
  delivery: EventDelivery,
) => Promise<DispatchOutcome | void>;

export type EventCompletion = (
  delivery: EventDelivery,
  input: Extract<CompletionInput, { kind: "event" }>,
) => Promise<DispatchOutcome | void>;

/**
 * The reference dispatcher. The command layer supplies `complete`, which runs
 * the owning adapter's `complete(ctx, { kind: "event", event })` and persists
 * what it returns; everything about staleness and ordering is decided here so
 * no adapter has to remember it.
 */
export function createEventDispatcher(options: {
  complete: EventCompletion;
  /** Observes every decision; never receives the payload. */
  observe?: (event: {
    deliveryId: string;
    outcome: DispatchOutcome;
    reason: "stale" | "ordering" | "applied" | "adapter";
  }) => void;
}): EventHandler {
  return async (delivery) => {
    if (delivery.stale) {
      options.observe?.({
        deliveryId: delivery.deliveryId,
        outcome: "ignored",
        reason: "stale",
      });
      return "ignored";
    }
    if (
      delivery.lifecycle &&
      (delivery.ordering === "out-of-order" ||
        delivery.ordering === "ambiguous")
    ) {
      const reconciled = await delivery.reconcile();
      const outcome: DispatchOutcome =
        reconciled === "reconciled" ? "reconciled" : "indeterminate";
      options.observe?.({
        deliveryId: delivery.deliveryId,
        outcome,
        reason: "ordering",
      });
      return outcome;
    }
    const result =
      (await options.complete(delivery, {
        kind: "event",
        event: delivery.envelope,
      })) ?? "applied";
    options.observe?.({
      deliveryId: delivery.deliveryId,
      outcome: result,
      reason: "adapter",
    });
    return result;
  };
}
