import type {
  AdapterCallContext,
  DisconnectOutcome,
  DisconnectResult,
  SessionRelease,
} from "../../adapter.js";
import {
  combineReleases,
  discardPending,
  heldSessions,
  revokeUpstreamGrantWithReason,
  sessionReleaseOf,
  type HeldSession,
  type Revocation,
} from "../../auth/index.js";
import type { ConnectorOAuthOptions } from "../../auth/connector-oauth.js";
import { resolveSignIn, sessionScope } from "./session.js";

/*
 * Ending the Vercel sign-in when the connection ends: the refresh token, then
 * the access token, go to Vercel's revocation endpoint (RFC 7009, with the
 * `none` client's `client_id`). The connection may hold more than one session:
 * its own, and the one a team choice is waiting on (a first sign-in has only
 * the second; a reconnect has both). Each is presented, and the one that
 * belongs to the open choice is dropped from custody whatever became of the
 * revocation, because nothing but this adapter would ever release it. Not
 * attempted, and said so, when the issuer policy turned revocation off, when
 * Vercel's metadata names no revocation endpoint, or when custody holds
 * nothing to present.
 */

const GONE = "oauth.revoke.credential-gone";

type Attempt = { held: HeldSession; revocation: Revocation };

/**
 * Every held session, revoked and (if it belonged to a choice) discarded.
 * `unresolved` when the issuer's endpoints could not be found: nothing could be
 * presented, but a session held for a choice is still dropped.
 */
async function revokeHeld(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<Attempt[] | "unresolved"> {
  const held = heldSessions(ctx);
  let oauth;
  try {
    oauth = await resolveSignIn(ctx, options);
  } catch {
    await Promise.all(held.map((session) => discardPending(ctx, session)));
    return "unresolved";
  }
  return Promise.all(
    held.map(async (session) => {
      const revocation = await revokeUpstreamGrantWithReason(ctx, {
        server: oauth.server,
        client: oauth.client,
        policy: oauth.policy,
        scope: sessionScope(ctx),
        credentialRef: session.ref,
      });
      await discardPending(ctx, session);
      return { held: session, revocation };
    }),
  );
}

/** A session held for a choice whose record is already gone has nothing to say. */
const counted = (attempts: Attempt[]) =>
  attempts.filter(
    ({ held, revocation }) => !(held.pending && revocation.reason === GONE),
  );

/**
 * Presents the held tokens to Vercel's revocation endpoint as part of a
 * disconnect that did not ask for it. Best effort: the answer is what
 * happened, never an error, and says so with a stable code and no token.
 */
export async function releaseSignIn(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<SessionRelease> {
  if (!heldSessions(ctx).length)
    return { revoked: "unavailable", reason: "oauth.revoke.no-session" };
  const attempts = await revokeHeld(ctx, options);
  if (attempts === "unresolved")
    return { revoked: false, reason: "oauth.revoke.unresolved" };
  return (
    combineReleases(
      attempts.map(({ held, revocation }) => ({
        held,
        release: sessionReleaseOf(revocation),
      })),
      (release) => release.reason === GONE,
    ) ?? { revoked: "unavailable", reason: "oauth.revoke.no-session" }
  );
}

/**
 * Ends the grant at Vercel (RFC 7009) when the host's reviewed policy asked
 * for it and Vercel's metadata advertises an endpoint; otherwise it says why
 * it did not. Local custody is released by the command layer either way. With
 * more than one session held, a failure of any is the failure reported.
 */
export async function endSignIn(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<DisconnectResult["upstream"]> {
  if (!heldSessions(ctx).length) return "not-attempted";
  const attempts = await revokeHeld(ctx, options);
  if (attempts === "unresolved") return "failed";
  const outcomes = counted(attempts).map(
    ({ revocation }) => revocation.outcome,
  );
  const first = (outcome: DisconnectOutcome) =>
    outcomes.find((value) => value === outcome);
  return (
    first("failed") ??
    first("indeterminate") ??
    first("applied") ??
    outcomes[0] ??
    "not-attempted"
  );
}
