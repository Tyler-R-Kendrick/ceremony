import type { AsyncTransaction } from "../../persistence/index.js";
import { PENDING_SESSION_STATE } from "../auth/pending-session.js";
import type { ConnectionRecord } from "../ports.js";
import { isReference, readRecord } from "./common.js";
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
 * the first write of the record keeps it.
 *
 * A record that names `pendingSession` at all (a reference, or `null` once a
 * choice was made or abandoned) is never touched, and neither is one whose
 * handoff is not an input the person still owes: a choice that was made,
 * cancelled or superseded no longer holds a sign-in under its reference.
 */

const OWED = new Set(["issued", "waiting", "expired"]);

export async function withLegacyPendingSession(
  tx: AsyncTransaction,
  tenantId: string,
  record: ConnectionRecord,
): Promise<ConnectionRecord> {
  const summary = record.handoff;
  if (
    Object.hasOwn(record.state, PENDING_SESSION_STATE) ||
    summary?.kind !== "input-required" ||
    !OWED.has(summary.state) ||
    summary.generation !== record.generation
  )
    return record;
  const handoff = await readRecord(
    tx,
    handoffKey(tenantId, summary.handoffRef),
    storedHandoffSchema,
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
