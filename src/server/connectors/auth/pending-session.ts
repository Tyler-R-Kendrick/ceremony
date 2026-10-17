import type { AdapterCallContext, SessionRelease } from "../adapter.js";
import { connectionCredentialScope } from "./connector-oauth.js";

/*
 * A sign-in that is waiting on a person. After the person approves at the
 * provider and before they choose what the connection is for (an AWS account
 * and role, a Vercel team), the tokens are in custody under a reference that
 * only the open choice knows, and the connection has no `credentialRef` yet.
 * The command layer releases only the connection's own `credentialRef`, so
 * anything that ends the connection in that window (a disconnect of any scope,
 * by any actor) would leave those tokens in custody, live at the provider and
 * unreachable.
 *
 * The adapter therefore records the reference in the connection's own adapter
 * state when it asks for the choice (and clears it when the choice is made).
 * It is read from the connection, not from the handoff, so it does not depend
 * on who is disconnecting: the handoff's private half can be read only by the
 * person who signed in.
 */

export const PENDING_SESSION_STATE = "pendingSession";

/** Adapter state for a completion that leaves a sign-in waiting (`ref`) or ends the wait (`null`). */
export const pendingSession = (
  ref: string | null,
): Record<string, unknown> => ({
  [PENDING_SESSION_STATE]: ref,
});

export type HeldSession = {
  ref: string;
  /** Held for an open choice rather than as the connection's own credential. */
  pending: boolean;
};

/**
 * Every custody record this connection's sign-in is held in: its own
 * credential, and the one an open choice holds (a reconnect has both: the
 * credential it is replacing and the sign-in that will).
 */
export function heldSessions(ctx: AdapterCallContext): HeldSession[] {
  const own = ctx.connection?.credentialRef;
  const waiting = ctx.connection?.state[PENDING_SESSION_STATE];
  const held: HeldSession[] = own ? [{ ref: own, pending: false }] : [];
  if (typeof waiting === "string" && waiting !== own)
    held.push({ ref: waiting, pending: true });
  return held;
}

const dropped = (ctx: AdapterCallContext, ref: string) =>
  ctx.environment.credentials
    .revoke(connectionCredentialScope(ctx), ref)
    .catch(() => {});

/**
 * Drops a sign-in held for an open choice. The command layer releases the
 * connection's own credential, so only a pending one is this adapter's to
 * drop. Best effort, as everything about a disconnect is.
 */
export async function discardPending(
  ctx: AdapterCallContext,
  held: HeldSession,
): Promise<void> {
  if (held.pending) await dropped(ctx, held.ref);
}

/**
 * A new sign-in has reached its own choice (or binding): the one an earlier
 * choice was holding can never be chosen from again, because the earlier
 * choice was cancelled when this sign-in began. It is dropped here, so it is
 * not left in custody with nothing but the connection's state pointing at it.
 */
export async function discardSuperseded(
  ctx: AdapterCallContext,
  keep: string,
): Promise<void> {
  const earlier = ctx.connection?.state[PENDING_SESSION_STATE];
  if (
    typeof earlier === "string" &&
    earlier !== keep &&
    earlier !== ctx.connection?.credentialRef
  )
    await dropped(ctx, earlier);
}

/**
 * One result for a connection that held more than one session. A pending
 * session whose record is already gone (the choice expired or was refused and
 * discarded it) is not a failure of this disconnect and is left out. Of the
 * rest, a failure is what is reported, then an acknowledgement, then "nothing
 * to try with".
 */
export function combineReleases(
  parts: Array<{ held: HeldSession; release: SessionRelease }>,
  isGone: (release: SessionRelease) => boolean,
): SessionRelease | undefined {
  const counted = parts.filter(
    (part) => !(part.held.pending && isGone(part.release)),
  );
  return (
    counted.find((part) => part.release.revoked === false)?.release ??
    counted.find((part) => part.release.revoked === true)?.release ??
    counted[0]?.release
  );
}
