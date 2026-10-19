import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { PENDING_SESSION_STATE } from "../auth/pending-session.js";
import type { ConnectionRecord } from "../ports.js";
import { isReference, readRecord, transact } from "./common.js";
import { handoffKey } from "./keys.js";
import { storedHandoffSchema } from "./schemas.js";

/*
 * A connection that was waiting for a person's choice (an AWS account and
 * role, a Vercel team) before the waiting sign-in was recorded on the
 * connection itself (`pendingSession`, auth/pending-session.ts) does not say
 * where that sign-in is held. What such a record does hold is its open
 * choice: the connection's handoff summary names the handoff, and the adapter
 * put the custody reference in the private half of that handoff as
 * `sessionRef` (the only key of that name any handoff carries). Read here,
 * the record carries `pendingSession` as if the adapter had recorded it, so a
 * disconnect (by any actor), a cancel and the custody sweep find the sign-in;
 * the first write that names it keeps it.
 *
 * It is asked for only by the paths that act on a waiting sign-in, never by a
 * plain read of a connection. A status read is the hottest path there is, and
 * on PostgreSQL every read of a row is a `FOR UPDATE`: a read of the
 * connection that went on to read its handoff would lock the two rows in the
 * opposite order from a claim (the handoff, then the connection) and the two
 * would deadlock. So the handoff is read here in a transaction of its own,
 * after the one that read the connection has ended: no transaction holds the
 * lock on one of the two rows while it waits for the other. What the caller
 * does with the answer is checked by the compare-and-set on the connection's
 * revision that every write of it carries.
 *
 * A record that names `pendingSession` at all (a reference, or `null` once a
 * choice was made or abandoned) is never touched, and neither is one whose
 * handoff is not an input the person still owes: a choice that was made,
 * cancelled or superseded no longer holds a sign-in under its reference.
 */

const OWED = new Set(["issued", "waiting", "expired"]);

/**
 * The handoff a record's waiting sign-in would be found in, when the record
 * is of the kind that could have one: no `pendingSession` of its own, and an
 * input-required handoff that is owed at the record's current generation.
 * Decided from the record alone, so a caller that holds many records opens
 * only the ones that can.
 */
export function legacyHandoffOf(record: ConnectionRecord): string | undefined {
  const summary = record.handoff;
  if (
    Object.hasOwn(record.state, PENDING_SESSION_STATE) ||
    summary?.kind !== "input-required" ||
    !OWED.has(summary.state) ||
    summary.generation !== record.generation
  )
    return undefined;
  return summary.handoffRef;
}

/** Whether the record may be waiting on a sign-in held for an open choice. */
export const mayWaitOnSignIn = (record: ConnectionRecord): boolean =>
  typeof record.state[PENDING_SESSION_STATE] === "string" ||
  legacyHandoffOf(record) !== undefined;

export async function withLegacyPendingSession(
  store: AsyncCeremonyStore,
  tenantId: string,
  record: ConnectionRecord,
): Promise<ConnectionRecord> {
  const handoffRef = legacyHandoffOf(record);
  if (handoffRef === undefined) return record;
  const handoff = await transact(store, (tx) =>
    readRecord(tx, handoffKey(tenantId, handoffRef), storedHandoffSchema),
  );
  const ref = handoff?.value.private["sessionRef"];
  if (
    !handoff ||
    handoff.value.connectionRef !== record.connectionRef ||
    handoff.value.generation !== record.generation ||
    !OWED.has(handoff.value.state) ||
    !isReference(ref) ||
    ref === record.credentialRef
  )
    return record;
  return {
    ...record,
    state: { ...record.state, [PENDING_SESSION_STATE]: ref },
  };
}
