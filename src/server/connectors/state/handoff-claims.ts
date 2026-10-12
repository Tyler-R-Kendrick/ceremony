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
 * submission by a digest only: the values are never stored here. It is given
 * back when the attempt fails, goes with the handoff when it settles, and is
 * void after its lease, so a worker that died holding it does not hold the
 * handoff.
 */

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

export function createHandoffClaims(
  store: AsyncCeremonyStore,
  time: TimeSource,
): Pick<HandoffPort, "claim" | "release"> {
  const unknown = () =>
    new ConnectorError("not-found", { detail: "handoff.unknown" });
  return {
    async claim(handoffRef, expectedGeneration, submission, leaseMs) {
      if (
        !sha256HexSchema.safeParse(submission).success ||
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
            detail: "handoff.already-completed",
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
        const held = current.claim;
        if (held && at - held.claimedAt < leaseMs) {
          if (held.submission === submission) return "shared";
          throw new ConnectorError("conflict", {
            detail: "handoff.already-claimed",
          });
        }
        await tx.put(
          key,
          { ...current, claim: { submission, claimedAt: at } },
          record.revision,
        );
        return "claimed";
      });
    },

    async release(handoffRef, submission) {
      if (
        !isReference(handoffRef) ||
        !sha256HexSchema.safeParse(submission).success
      )
        return;
      await untilDecided(store, async (tx) => {
        const tenantId = await resolveRef(tx, "connector-handoff", handoffRef);
        if (!tenantId) return;
        const key = handoffKey(tenantId, handoffRef);
        const record = await readRecord(tx, key, storedHandoffSchema);
        if (record?.value.claim?.submission !== submission) return;
        await tx.put(key, withoutClaim(record.value), record.revision);
      });
    },
  };
}
