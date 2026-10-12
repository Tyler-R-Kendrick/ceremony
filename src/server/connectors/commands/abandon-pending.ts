import { PENDING_SESSION_STATE } from "../auth/pending-session.js";
import type {
  ConnectionRecord,
  CredentialCustodyPort,
  CredentialScope,
} from "../ports.js";

/*
 * A sign-in that is waiting on a person's choice (an AWS account and role, a
 * Vercel team) is held in custody under a reference the adapter recorded on the
 * connection's state (`auth/pending-session.ts`). When the person cancels the
 * choice, nothing can use that sign-in any more, so the connection stops
 * pointing at it and it is dropped from custody. It is the same drop every
 * other abandoned sign-in gets (a failed listing, an expired choice, a refused
 * switch of account); the provider is not told, which is what a disconnect is
 * for. The connection's own credential, if it has one (a reconnect), is not
 * touched.
 *
 * The waiting sign-in is the very custody record that becomes the connection's
 * credential when the choice is made, so the order matters: the state is
 * cleared in the compare-and-set that cancels, and the record is dropped only
 * after that write has landed and only if the connection does not carry it.
 * A cancel that loses the race to a submission revokes nothing.
 */

/** The waiting sign-in's reference, and the state patch that stops pointing at it. */
export function abandonedSession(record: ConnectionRecord): {
  ref?: string;
  patch: Pick<Partial<ConnectionRecord>, "state">;
} {
  const waiting = record.state[PENDING_SESSION_STATE];
  if (typeof waiting !== "string") return { patch: {} };
  return {
    ref: waiting,
    patch: { state: { ...record.state, [PENDING_SESSION_STATE]: null } },
  };
}

/** Drops `ref` from custody, unless the record that was written carries it as its own credential. */
export async function dropAbandoned(
  credentials: CredentialCustodyPort,
  scope: CredentialScope,
  ref: string | undefined,
  written: ConnectionRecord,
): Promise<void> {
  if (ref !== undefined && ref !== written.credentialRef)
    await credentials.revoke(scope, ref).catch(() => {});
}
