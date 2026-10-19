import type { AsyncTransaction } from "../../persistence/index.js";
import { readRecord, scanPrefix } from "./common.js";
import { withoutClaim } from "./handoff-claims.js";
import { correlationKey, handoffKey, handoffPointerPrefix } from "./keys.js";
import {
  correlationIndexSchema,
  handoffPointerSchema,
  storedHandoffSchema,
  type StoredHandoff,
} from "./schemas.js";

/*
 * THE LOCK ORDER of a connection and its handoffs.
 *
 * On PostgreSQL every read of a row locks it (`get` and `list` are
 * `SELECT ... FOR UPDATE`, persistence/index.ts) until the transaction ends,
 * so two transactions that take the same two rows in opposite orders deadlock
 * and the database kills one after its deadlock timeout: the caller sees
 * "Persistence operation unavailable". The rule that keeps the connector
 * state free of that, for every writer:
 *
 *     handoff rows first (a connection's pointer rows, then its handoff rows,
 *     in id order), then the connection row, never the other way round.
 *
 * A claim, a completion and a release take the handoff and then read the
 * connection (handoff-claims.ts, handoffs.ts). A writer that fences a
 * connection (a disconnect, a revoke or a reconnect advance its generation,
 * a drift invalidation, a recorded disconnect) and settles its handoffs in
 * the same transaction therefore asks for the handoffs first,
 * `lockHandoffs`, before it reads the connection, and settles the ones
 * still pending after it has written it, `settleLocked`. Transactions that
 * touch only one of the two (a cancel of every handoff, a status read, the
 * sweep's write, an expiry) need no order. A status read of a connection takes
 * no handoff lock at all (legacy-pending.ts reads the handoff in a transaction
 * of its own), so it cannot be one half of a cycle.
 *
 * A writer that asks for the handoffs before it knows the connection is its
 * caller's holds their locks for a moment: the connection read that follows
 * refuses a connection it does not own and the transaction ends.
 *
 * Not covered here, and not changed: the correlation index row is taken after
 * a handoff by a settlement and before one by `issue` (a handoff issued on a
 * correlation another handoff still holds), and two disconnects of connections
 * that share an upstream grant read each other's connection row. Neither
 * involves the pair this rule orders.
 */

export const pending = (state: StoredHandoff["state"]) =>
  state === "issued" || state === "waiting";

/** A connection's handoffs as they were when they were locked. */
export type LockedHandoffs = {
  tenantId: string;
  entries: Array<{
    handoffRef: string;
    record: { revision: number; value: StoredHandoff } | undefined;
  }>;
};

/**
 * Locks every handoff of a connection (its pointer rows, then each handoff
 * row, in id order) and reads them. Call it before reading the connection
 * row, in a transaction that will write the connection and settle these
 * handoffs, and hand the result to `settleLocked`.
 */
export async function lockHandoffs(
  tx: AsyncTransaction,
  tenantId: string,
  connectionRef: string,
): Promise<LockedHandoffs> {
  const refs: string[] = [];
  await scanPrefix(
    tx,
    tenantId,
    "connector-handoff",
    handoffPointerPrefix(connectionRef),
    handoffPointerSchema,
    ({ value }) => {
      refs.push(value.handoffRef);
    },
  );
  const entries: LockedHandoffs["entries"] = [];
  for (const handoffRef of refs)
    entries.push({
      handoffRef,
      record: await readRecord(
        tx,
        handoffKey(tenantId, handoffRef),
        storedHandoffSchema,
      ),
    });
  return { tenantId, entries };
}

/** Marks every handoff of `locked` that is still pending; used by cancel, unlink and generation fences in the same transaction. */
export async function settleLocked(
  tx: AsyncTransaction,
  locked: LockedHandoffs,
  state: "cancelled" | "superseded",
  reason: string,
  at: number,
): Promise<number> {
  let count = 0;
  for (const { handoffRef, record } of locked.entries) {
    if (!record || !pending(record.value.state)) continue;
    await tx.put(
      handoffKey(locked.tenantId, handoffRef),
      {
        ...withoutClaim(record.value),
        state,
        reason,
        completedAt: at,
      } satisfies StoredHandoff,
      record.revision,
    );
    await dropCorrelation(tx, locked.tenantId, record.value);
    count++;
  }
  return count;
}

/** Locks and settles a connection's pending handoffs in one go: for a writer that does not touch the connection row. */
export async function settlePendingHandoffs(
  tx: AsyncTransaction,
  tenantId: string,
  connectionRef: string,
  state: "cancelled" | "superseded",
  reason: string,
  at: number,
): Promise<number> {
  return settleLocked(
    tx,
    await lockHandoffs(tx, tenantId, connectionRef),
    state,
    reason,
    at,
  );
}

export async function dropCorrelation(
  tx: AsyncTransaction,
  tenantId: string,
  record: StoredHandoff,
): Promise<void> {
  if (record.correlationKey === undefined) return;
  const key = correlationKey(tenantId, record.correlationKey);
  const index = await readRecord(tx, key, correlationIndexSchema);
  if (index && index.value.handoffRef === record.handoffRef)
    await tx.delete(key, index.revision);
}
