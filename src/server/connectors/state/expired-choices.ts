import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { PENDING_SESSION_STATE } from "../auth/pending-session.js";
import { abandonedSession, recordScope } from "../dropped-credentials.js";
import type { ConnectionRecord, CredentialCustodyPort } from "../ports.js";
import { isoAt, readRecord, transact, type TimeSource } from "./common.js";
import { loadConnection, saveConnection } from "./connections.js";
import { handoffKey } from "./keys.js";
import { storedHandoffSchema } from "./schemas.js";

/*
 * A sign-in waiting for a person's choice (auth/pending-session.ts) can only
 * be used through that open choice. When the choice expires with nobody
 * answering it, the sign-in is held for nothing, so the custody sweep lets go
 * of it: the same way a cancel does (dropped-credentials.ts), the connection
 * stops pointing at it and notes the drop in one compare-and-set, and the
 * sweep then drops what was noted. Nothing is dropped while the choice can
 * still be answered, while a submission holds its claim (the submission may
 * be binding that very sign-in), or once a submission has settled it.
 */

const OPEN = new Set(["issued", "waiting"]);

/** Whether the connection's handoff, as the handoff store holds it, can no longer use a waiting sign-in. */
async function choiceIsOver(
  store: AsyncCeremonyStore,
  tenantId: string,
  record: ConnectionRecord,
  at: number,
): Promise<boolean> {
  const summary = record.handoff;
  if (!summary) return true;
  const handoff = await transact(store, (tx) =>
    readRecord(
      tx,
      handoffKey(tenantId, summary.handoffRef),
      storedHandoffSchema,
    ),
  );
  if (!handoff) return Date.parse(summary.expiresAt) <= at;
  const { state, expiresAt, claim } = handoff.value;
  if (claim && at < claim.expiresAt) return false;
  if (state === "completed") return false;
  return !OPEN.has(state) || expiresAt <= at;
}

/**
 * For one connection: if it waits on a sign-in for a choice that is over and
 * custody still holds that sign-in, writes the connection so that it no
 * longer names it and notes the drop. Returns the record as written, for the
 * sweep to drop what it noted, or undefined when there was nothing to do.
 */
export async function abandonExpiredChoice(
  store: AsyncCeremonyStore,
  custody: Pick<CredentialCustodyPort, "describe">,
  tenantId: string,
  connectionRef: string,
  time: TimeSource,
): Promise<ConnectionRecord | undefined> {
  const loaded = await transact(store, (tx) =>
    loadConnection(tx, tenantId, connectionRef),
  );
  const record = loaded?.value.record;
  const waiting = record?.state[PENDING_SESSION_STATE];
  if (!record || typeof waiting !== "string") return undefined;
  const at = await transact(store, time);
  if (!(await choiceIsOver(store, tenantId, record, at))) return undefined;
  if (!(await custody.describe(recordScope(record), waiting))) return undefined;
  return transact(store, async (tx) => {
    const current = await loadConnection(tx, tenantId, connectionRef);
    // A write in between (a submission, a cancel, a reconnect) decides instead.
    if (!current || current.revision !== loaded!.revision) return undefined;
    const written: ConnectionRecord = {
      ...current.value.record,
      ...abandonedSession(current.value.record).patch,
      updatedAt: isoAt(at),
    };
    await saveConnection(
      tx,
      tenantId,
      written,
      current.value.disconnect ? { disconnect: current.value.disconnect } : {},
      current.revision,
    );
    return written;
  });
}
