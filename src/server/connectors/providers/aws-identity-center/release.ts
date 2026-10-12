import type {
  AdapterCallContext,
  DisconnectResult,
  SessionRelease,
} from "../../adapter.js";
import {
  combineReleases,
  discardPending,
  heldSessions,
} from "../../auth/index.js";
import { ConnectorError } from "../../errors.js";
import { AWS_IDENTITY_CENTER_ADAPTER_ID } from "./contracts.js";
import { sentNothing } from "./client.js";
import { rotateSession } from "./material.js";
import { logout, type LogoutAnswer } from "./portal.js";

/*
 * Ending the sign-in session at the portal (`Logout`) when the connection ends.
 * The connection may hold more than one session: its own, and the one a role
 * choice is waiting on (a first sign-in has only the second; a reconnect has
 * both). Each is ended, and the one that belongs to the open choice is dropped
 * from custody whatever became of its Logout, because nothing but this adapter
 * would ever release it. Role sessions already issued continue until their own
 * expiry, which the portal reference says outright, so none of this ever
 * claims to have revoked a role. The OIDC API has no operation that revokes a
 * refresh token; that token is dropped with custody and is not known to be
 * ended.
 */

const code = (suffix: string) => `${AWS_IDENTITY_CENTER_ADAPTER_ID}.${suffix}`;

/** What each answer of the portal's Logout is reported as. */
const RELEASE_OF: Record<LogoutAnswer, SessionRelease> = {
  ended: { revoked: true, reason: code("release.session-ended") },
  gone: { revoked: "unavailable", reason: code("release.session-gone") },
  unknown: { revoked: false, reason: code("release.indeterminate") },
  refused: { revoked: false, reason: code("release.refused") },
};

/** Why custody would not hand over the session: it is gone, it is busy, or something else failed. */
function rotationFailure(error: unknown): SessionRelease {
  const detail =
    error instanceof ConnectorError && error.code === "not-found"
      ? "credential-gone"
      : error instanceof ConnectorError && error.code === "conflict"
        ? "busy"
        : "failed";
  return { revoked: false, reason: code(`release.${detail}`) };
}

/** `Logout` for one held session, and what came of it. Never throws. */
async function endSession(
  ctx: AdapterCallContext,
  ref: string,
): Promise<SessionRelease> {
  let release: SessionRelease = {
    revoked: "unavailable",
    reason: code("release.no-token"),
  };
  // A caller that joins a rotation already in flight is answered when it ends
  // without its own callback running (custody shares one run per credential),
  // so the session has not been looked at yet: look again, once, at what the
  // rotation left. That one is the new token's turn.
  let looked = false;
  try {
    for (let round = 0; round < 2 && !looked; round++)
      await rotateSession(ctx, ref, async (current) => {
        looked = true;
        if (!current.accessToken) return current;
        try {
          release = RELEASE_OF[await logout(ctx, current.accessToken)];
        } catch (error) {
          // Nothing listening is `unreachable`; a request that went out and
          // did not come back as an answer (a timeout, an abort, a body too
          // large or of the wrong shape) is unknown.
          release = {
            revoked: false,
            reason: code(
              sentNothing(error)
                ? "release.unreachable"
                : "release.indeterminate",
            ),
          };
        }
        return current;
      });
    if (!looked)
      release = { revoked: false, reason: code("release.rotation-in-flight") };
  } catch (error) {
    // Custody would not rotate the session: say why, unless a Logout was made.
    if (release.revoked === "unavailable") release = rotationFailure(error);
  }
  return release;
}

/**
 * Ends every sign-in session this connection holds as part of a disconnect that
 * did not ask for it. Best effort: what happened is the answer, with a stable
 * code and no token, and nothing here stops the disconnect. `revoked: true`
 * means the session was ended and never that the role credentials were.
 */
export async function releaseSignIn(
  ctx: AdapterCallContext,
): Promise<SessionRelease> {
  const held = heldSessions(ctx);
  const parts = await Promise.all(
    held.map(async (session) => {
      const release = await endSession(ctx, session.ref);
      await discardPending(ctx, session);
      return { held: session, release };
    }),
  );
  return (
    combineReleases(
      parts,
      (release) => release.reason === code("release.credential-gone"),
    ) ?? { revoked: "unavailable", reason: code("release.no-session") }
  );
}

/** The portal session ended, as the upstream scope reports it. */
export async function endSignIn(
  ctx: AdapterCallContext,
): Promise<DisconnectResult> {
  const result: DisconnectResult = {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "not-attempted",
  };
  if (!heldSessions(ctx).length) return result;
  return { ...result, upstream: upstreamOf(await releaseSignIn(ctx)) };
}

/**
 * The upstream scope's outcome for what the release came to: applied only when
 * the portal acknowledged; a session that was already gone had nothing done to
 * it; a Logout the portal did not process is unknown; the rest did not work.
 */
function upstreamOf(release: SessionRelease): DisconnectResult["upstream"] {
  if (release.revoked === true) return "applied";
  if (release.reason === code("release.session-gone")) return "not-attempted";
  if (release.reason === code("release.indeterminate")) return "indeterminate";
  return "failed";
}
