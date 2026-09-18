import { z } from "zod";
import {
  effectRefSchema,
  mintReference,
  runRefSchema,
} from "../core/browser-session-contracts.js";
import type { ActorContext } from "../core/operation-contracts.js";
import { AuthorizationError } from "./identity.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";

/**
 * What a login attempt did to the outside world, recorded before it does it.
 *
 * A browser login is not a pure function. Somewhere in the middle of it a form
 * carrying a credential is posted to a provider, and from that moment the
 * provider's state may have changed whether or not this process ever learns
 * what happened. Two failures follow from that, and both of them are lies the
 * code told before this module existed:
 *
 * - **Reporting nothing happened.** A navigation that times out after the post
 *   was dispatched came back as `blocked` / `provider-error`, which a caller
 *   reads as "safe to retry". It is not safe: the submission may have landed,
 *   a session may exist, a rate limiter may have been charged, and a second
 *   attempt can trip a provider's lockout on a login that already worked.
 * - **Retrying it silently.** Calling `login` twice with the same request
 *   submitted twice, because nothing connected the second call to the first.
 *
 * The ledger's one rule is **write the intent before performing it**. A record
 * reaches `dispatched` before the click that dispatches, so a process that dies
 * between the two leaves evidence that something *might* have been sent. The
 * uncertain state is the point: `dispatched` and never `observed` is exactly
 * the situation the `indeterminate` outcome exists to describe, and it must not
 * collapse into either success or failure.
 *
 * Nothing here holds a credential, a cookie or a response body. An effect
 * records that a submission was aimed at an origin, never what was in it.
 */

/**
 * The life of one effect. States only move forward, and `dispatched` is the
 * only one that can be left behind by a crash.
 */
export const effectStates = [
  /** Claimed, nothing sent. A crash here means nothing reached anyone. */
  "reserved",
  /** A submission was about to be, or has been, dispatched. Outcome unknown. */
  "dispatched",
  /** The attempt ran to a conclusion this process saw. */
  "observed",
  /** Abandoned before dispatch. Distinct from a dispatch that failed. */
  "abandoned",
] as const;
export const effectStateSchema = z.enum(effectStates);
export type EffectState = z.infer<typeof effectStateSchema>;

/**
 * The persisted effect.
 *
 * `idempotencyKey` is the caller's name for "the same request". It is scoped by
 * tenant, subject and effective plan digest, so one client's key can never
 * collide with another's and a revised plan is never treated as a replay of the
 * plan it replaced.
 */
export const effectRecordSchema = z
  .strictObject({
    effectRef: effectRefSchema,
    tenant: z.string().min(1).max(128),
    subject: z.string().min(1).max(128),
    runRef: runRefSchema,
    effectivePlanDigest: z.string().length(64),
    idempotencyKey: z.string().min(1).max(200),
    state: effectStateSchema,
    /**
     * Where a dispatch was aimed, as an origin. Never a full URL: a login URL
     * can carry an identifier or a token in its query string.
     */
    destination: z.string().max(200).optional(),
    /** How many dispatches this effect covers. A resume is not a new effect. */
    dispatches: z.number().int().nonnegative(),
    /** The settled outcome, recorded only once the attempt was seen through. */
    outcome: z.string().min(1).max(64).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .readonly();
export type EffectRecord = z.infer<typeof effectRecordSchema>;

/**
 * What `begin` found. A caller must branch on this: `fresh` may be executed,
 * and `replay` may not be executed again under any circumstances.
 */
export type EffectClaim =
  | { kind: "fresh"; record: EffectRecord }
  | { kind: "replay"; record: EffectRecord };

/**
 * Two callers raced for the same idempotency key and this one lost.
 *
 * Reported rather than resolved: the loser must not dispatch, and the winner's
 * record is the one that describes what the world saw.
 */
export class EffectConflict extends Error {
  constructor(readonly idempotencyKey: string) {
    super("Another attempt already claimed this request");
    this.name = "EffectConflict";
  }
}

/**
 * The durable key for one idempotency claim.
 *
 * The key is a claim *slot*, not the effect record: the slot is what makes the
 * claim atomic under the store's optimistic concurrency, and it holds only the
 * reference of the effect that won it.
 */
const claimKey = (
  actor: ActorContext,
  planDigest: string,
  idempotencyKey: string,
) => ({
  tenant: actor.tenantId,
  kind: "effect" as const,
  id: `claim:${actor.subjectId}:${planDigest}:${idempotencyKey}`,
});

const effectKey = (actor: ActorContext, effectRef: string) => ({
  tenant: actor.tenantId,
  kind: "effect" as const,
  id: `browser:${effectRef}`,
});

export type EffectLedger = ReturnType<typeof createEffectLedger>;

export function createEffectLedger(options: {
  store: AsyncCeremonyStore;
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());

  const load = async (
    actor: ActorContext,
    effectRef: string,
  ): Promise<{ record: EffectRecord; revision: number }> => {
    const stored = await options.store.transaction((tx) =>
      tx.get<EffectRecord>(effectKey(actor, effectRef)),
    );
    if (!stored) throw new AuthorizationError("denied");
    const record = effectRecordSchema.parse(stored.value);
    // Ownership is re-derived from the authenticated actor every time. Holding
    // an effect reference is not holding permission to read what it did.
    if (record.tenant !== actor.tenantId || record.subject !== actor.subjectId)
      throw new AuthorizationError("denied");
    return { record, revision: stored.revision };
  };

  const write = async (
    actor: ActorContext,
    record: EffectRecord,
    expectedRevision: number | null,
  ) => {
    await options.store.transaction((tx) =>
      tx.put(effectKey(actor, record.effectRef), record, expectedRevision),
    );
  };

  return {
    /**
     * Claim the right to perform one request, or discover that it is already
     * spoken for.
     *
     * A `replay` result is not an error and not a retry signal. It is the
     * answer: this exact request has a record, and whatever that record says
     * is what the caller must report instead of doing the work again.
     */
    async begin(
      actor: ActorContext,
      input: {
        runRef: string;
        effectivePlanDigest: string;
        idempotencyKey: string;
      },
    ): Promise<EffectClaim> {
      const slot = claimKey(
        actor,
        input.effectivePlanDigest,
        input.idempotencyKey,
      );
      const existing = await options.store.transaction((tx) =>
        tx.get<{ effectRef: string }>(slot),
      );
      if (existing) {
        const { record } = await load(actor, existing.value.effectRef);
        return { kind: "replay", record };
      }

      const effectRef = mintReference("beff");
      const stamp = new Date(now()).toISOString();
      const record = effectRecordSchema.parse({
        effectRef,
        tenant: actor.tenantId,
        subject: actor.subjectId,
        runRef: input.runRef,
        effectivePlanDigest: input.effectivePlanDigest,
        idempotencyKey: input.idempotencyKey,
        state: "reserved",
        dispatches: 0,
        createdAt: stamp,
        updatedAt: stamp,
      } satisfies EffectRecord);

      // The effect row first, then the claim slot. Written the other way round,
      // a crash between them would leave a claim pointing at nothing, and every
      // later attempt at this request would fail to load it forever.
      await write(actor, record, null);
      try {
        await options.store.transaction((tx) =>
          tx.put(slot, { effectRef }, null),
        );
      } catch {
        // Somebody else claimed it between the read and the write. The store's
        // expected-revision check is what makes that detectable rather than a
        // silent overwrite, and losing means not dispatching.
        throw new EffectConflict(input.idempotencyKey);
      }
      return { kind: "fresh", record };
    },

    /**
     * Record that a submission is about to leave.
     *
     * Called *before* the action, never after. Everything about this module's
     * usefulness depends on that ordering: a record written afterwards is a
     * record that is missing in exactly the case it was built for.
     */
    async dispatching(
      actor: ActorContext,
      effectRef: string,
      destination: string,
    ): Promise<EffectRecord> {
      const { record, revision } = await load(actor, effectRef);
      if (record.state === "observed" || record.state === "abandoned")
        throw new EffectConflict(record.idempotencyKey);
      const next = effectRecordSchema.parse({
        ...record,
        state: "dispatched",
        destination,
        dispatches: record.dispatches + 1,
        updatedAt: new Date(now()).toISOString(),
      } satisfies EffectRecord);
      await write(actor, next, revision);
      return next;
    },

    /**
     * Record that the attempt was seen through to a conclusion.
     *
     * `outcome` is a status name from the login result, never a message, a URL
     * or a provider payload — a caller reading an effect must not learn
     * anything it could not have learned from the result it already had.
     */
    async observed(
      actor: ActorContext,
      effectRef: string,
      outcome: string,
    ): Promise<EffectRecord> {
      const { record, revision } = await load(actor, effectRef);
      const next = effectRecordSchema.parse({
        ...record,
        state: "observed",
        outcome,
        updatedAt: new Date(now()).toISOString(),
      } satisfies EffectRecord);
      await write(actor, next, revision);
      return next;
    },

    /**
     * Close an effect that never dispatched.
     *
     * Refused once anything has been dispatched: calling a possible submission
     * "abandoned" is the specific false claim this module exists to prevent.
     */
    async abandon(
      actor: ActorContext,
      effectRef: string,
    ): Promise<EffectRecord> {
      const { record, revision } = await load(actor, effectRef);
      if (record.dispatches > 0)
        throw new EffectConflict(record.idempotencyKey);
      const next = effectRecordSchema.parse({
        ...record,
        state: "abandoned",
        updatedAt: new Date(now()).toISOString(),
      } satisfies EffectRecord);
      await write(actor, next, revision);
      return next;
    },

    /** Read one effect. Authorization is re-derived, not assumed. */
    async read(actor: ActorContext, effectRef: string): Promise<EffectRecord> {
      const { record } = await load(actor, effectRef);
      return record;
    },
  };
}

/**
 * Whether an effect's record leaves the provider's state genuinely unknown.
 *
 * This is the single place that decision is made, so a caller cannot reach a
 * cheerier answer by reasoning about the fields itself.
 */
export function effectIsIndeterminate(record: EffectRecord): boolean {
  return record.state === "dispatched";
}
