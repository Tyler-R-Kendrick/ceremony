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
 * choice, nothing can use that sign-in any more: it is dropped from custody
 * here, and the connection stops pointing at it. It is the same drop every
 * other abandoned sign-in gets (a failed listing, an expired choice, a refused
 * switch of account); the provider is not told, which is what a disconnect is
 * for. The connection's own credential, if it has one (a reconnect), is not
 * touched.
 */
export async function abandonPendingSession(
  credentials: CredentialCustodyPort,
  scope: CredentialScope,
  record: ConnectionRecord,
): Promise<Pick<Partial<ConnectionRecord>, "state">> {
  const waiting = record.state[PENDING_SESSION_STATE];
  if (typeof waiting !== "string") return {};
  if (waiting !== record.credentialRef)
    await credentials.revoke(scope, waiting).catch(() => {});
  return { state: { ...record.state, [PENDING_SESSION_STATE]: null } };
}
