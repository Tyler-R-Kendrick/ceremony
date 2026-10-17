import { PENDING_SESSION_STATE } from "./auth/pending-session.js";
import type {
  ConnectionRecord,
  CredentialCustodyPort,
  CredentialScope,
} from "./ports.js";

/*
 * Write first, drop second: wherever a sign-in is abandoned (a cancelled
 * choice) or replaced (a completion that binds a new credential), the
 * connection is written before the old custody record is dropped, so a lost
 * write drops nothing. The cost is that a drop which fails, or a process that
 * stops between the write and the drop, leaves a custody record that nothing
 * names. So the write also notes the reference it is about to drop, in the
 * same compare-and-set, and the sweep (`state/custody-sweep.ts`) drops what a
 * record noted and no longer names. Only references the service itself
 * decided to drop are ever swept: custody holds records that no connection
 * names on purpose (a trigger's signing key, a cached management token).
 */

export const DROPPED_CREDENTIALS_STATE = "droppedCredentials";
const KEPT = 8;

/** `state` with `ref` noted as dropped; the most recent eight are kept. */
export function noteDropped(
  state: Record<string, unknown>,
  ref: string,
): Record<string, unknown> {
  const prior = state[DROPPED_CREDENTIALS_STATE];
  const noted = Array.isArray(prior)
    ? prior.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...state,
    [DROPPED_CREDENTIALS_STATE]: [
      ...noted.filter((item) => item !== ref),
      ref,
    ].slice(-KEPT),
  };
}

/** What the record noted as dropped and does not name (as its credential or a waiting sign-in). */
export function droppedRefs(record: ConnectionRecord): string[] {
  const noted = record.state[DROPPED_CREDENTIALS_STATE];
  if (!Array.isArray(noted)) return [];
  return noted.filter(
    (ref): ref is string =>
      typeof ref === "string" &&
      ref !== record.credentialRef &&
      ref !== record.state[PENDING_SESSION_STATE],
  );
}

export const recordScope = (record: ConnectionRecord): CredentialScope => ({
  tenantId: record.tenantId,
  ownerKind: record.ownerKind,
  ownerId: record.ownerId,
  connectionRef: record.connectionRef,
  bindingRef: record.bindingRef,
  custody: record.custody,
});

/** Drops what `record` noted as dropped and custody still holds; the number dropped. */
export async function sweepDropped(
  custody: Pick<CredentialCustodyPort, "describe" | "revoke">,
  record: ConnectionRecord,
): Promise<number> {
  let swept = 0;
  const scope = recordScope(record);
  for (const ref of droppedRefs(record))
    if (await custody.describe(scope, ref)) {
      await custody.revoke(scope, ref);
      swept++;
    }
  return swept;
}
