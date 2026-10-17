import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
} from "../../persistence/index.js";
import { sha256HexSchema } from "../../../core/connectors/index.js";
import { ConnectorError } from "../errors.js";
import type { HandoffPort } from "../ports.js";
import {
  isReference,
  readRecord,
  resolveRef,
  transact,
  type TimeSource,
} from "./common.js";
import { connectionKey, handoffKey } from "./keys.js";
import {
  storedConnectionSchema,
  storedHandoffSchema,
  type StoredHandoff,
} from "./schemas.js";

/*
 * Who is working a pending handoff. A handoff is completed once, but the work
 * that completes it (a provider call, a credential rotation) is not done in
 * one transaction, so two submissions with different values would both run
 * and the faster one could be answered from the slower one's work. The claim
 * is taken first, as a compare-and-set on the handoff record, and names the
 * submission by a digest only: the values are never stored here. The caller's
 * digest is a plain SHA-256 and is not what is kept: the record keeps an
 * HMAC of it under a key derived from the vault key (persistence/sealing.ts),
 * so a short submitted code cannot be guessed back from the record without
 * that key. It is given back when the attempt fails, goes with the handoff
 * when it settles, and is void after its lease, so a worker that died holding
 * it does not hold the handoff.
 */

/** What the keyed digest of a submission is for; it keys nothing else. */
export const SUBMISSION_DIGEST = "handoff.submission";

/**
 * Whether a held claim names this submission. A claim written before claims
 * were keyed holds the plain digest itself; it is still recognised until its
 * lease runs out (twice the call timeout), and nothing writes that form now.
 */
const names = (held: string, plain: string, keyed: readonly string[]) =>
  keyed.includes(held) || held === plain;

/** Reads again, this many times, when another worker changed the handoff between our read and our write. */
const ATTEMPTS = 5;

const lostRace = (error: unknown) =>
  error instanceof ConnectorError && error.cause instanceof PersistenceConflict;

async function untilDecided<T>(
  store: AsyncCeremonyStore,
  work: (tx: AsyncTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++)
    try {
      return await transact(store, work);
    } catch (error) {
      if (!lostRace(error) || attempt >= ATTEMPTS) throw error;
    }
}

const open = (state: StoredHandoff["state"]) =>
  state === "issued" || state === "waiting";

/** The handoff without its claim: no claim outlives the attempt, or the handoff's pending state. */
export function withoutClaim(record: StoredHandoff): StoredHandoff {
  const { claim: _claim, ...rest } = record;
  void _claim;
  return rest;
}

const attemptPattern = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether a settled handoff was settled by an attempt other than the one a waiter joined. */
export const settledByOther = (
  record: Pick<StoredHandoff, "settledBy">,
  joining: string | undefined,
) =>
  joining !== undefined &&
  record.settledBy !== undefined &&
  record.settledBy !== joining;

/**
 * A settlement made by an attempt is refused while another attempt holds a
 * live claim: the run whose claim lapsed and was taken over has lost the
 * handoff to its successor. A settlement with no attempt, or on a handoff no
 * one holds, is not fenced here.
 */
export function assertNotClaimedByAnother(
  record: StoredHandoff,
  attempt: string | undefined,
  at: number,
): void {
  const held = record.claim;
  if (
    attempt !== undefined &&
    held &&
    held.attempt !== attempt &&
    at < held.expiresAt
  )
    throw new ConnectorError("conflict", { detail: "handoff.claim-lost" });
}

export function createHandoffClaims(
  store: AsyncCeremonyStore,
  time: TimeSource,
): Pick<HandoffPort, "claim" | "release"> {
  const unknown = () =>
    new ConnectorError("not-found", { detail: "handoff.unknown" });
  return {
    async claim(
      handoffRef,
      expectedGeneration,
      submission,
      attempt,
      leaseMs,
      joining,
    ) {
      if (
        !sha256HexSchema.safeParse(submission).success ||
        !attemptPattern.test(attempt) ||
        !Number.isSafeInteger(expectedGeneration) ||
        !Number.isSafeInteger(leaseMs) ||
        leaseMs <= 0
      )
        throw new ConnectorError("invalid-request", {
          detail: "handoff.claim",
        });
      if (!isReference(handoffRef)) throw unknown();
      return untilDecided(store, async (tx) => {
        const tenantId = await resolveRef(tx, "connector-handoff", handoffRef);
        if (!tenantId) throw unknown();
        const key = handoffKey(tenantId, handoffRef);
        const record = await readRecord(tx, key, storedHandoffSchema);
        if (!record) throw unknown();
        const current = record.value;
        const at = await time(tx);
        // Expiry is only read here; `present` and `complete` are what settle it.
        if (
          current.state === "expired" ||
          (open(current.state) && current.expiresAt <= at)
        )
          throw new ConnectorError("expired", { detail: "handoff.expired" });
        if (current.generation !== expectedGeneration)
          throw new ConnectorError("conflict", {
            detail: "handoff.stale-generation",
          });
        if (!open(current.state))
          throw new ConnectorError("conflict", {
            detail: settledByOther(current, joining)
              ? "handoff.settled-by-another"
              : "handoff.already-completed",
          });
        const connection = await readRecord(
          tx,
          connectionKey(tenantId, current.connectionRef),
          storedConnectionSchema,
        );
        if (
          connection &&
          connection.value.record.generation !== current.generation
        )
          throw new ConnectorError("conflict", {
            detail: "handoff.stale-generation",
          });
        const keyed = tx.keyedDigests(SUBMISSION_DIGEST, submission);
        const held = current.claim;
        if (held && at < held.expiresAt) {
          if (names(held.submission, submission, keyed))
            return { shared: held.attempt };
          throw new ConnectorError("conflict", {
            detail: "handoff.already-claimed",
          });
        }
        await tx.put(
          key,
          {
            ...current,
            claim: {
              submission: keyed[0]!,
              attempt,
              expiresAt: at + leaseMs,
            },
          },
          record.revision,
        );
        return "claimed";
      });
    },

    async release(handoffRef, attempt) {
      if (!isReference(handoffRef) || !attemptPattern.test(attempt)) return;
      await untilDecided(store, async (tx) => {
        const tenantId = await resolveRef(tx, "connector-handoff", handoffRef);
        if (!tenantId) return;
        const key = handoffKey(tenantId, handoffRef);
        const record = await readRecord(tx, key, storedHandoffSchema);
        if (record?.value.claim?.attempt !== attempt) return;
        await tx.put(key, withoutClaim(record.value), record.revision);
      });
    },
  };
}
