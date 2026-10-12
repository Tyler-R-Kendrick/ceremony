import { sessionReleaseSchema } from "../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  ConnectorAdapter,
  SessionRelease,
} from "../adapter.js";

/*
 * Ending a held sign-in at the provider, as part of a disconnect that was not
 * asked to. An adapter that keeps a session of its own for a connection (a
 * refresh token it will never present again once custody is released) says how
 * to end it at the provider; the command layer asks, bounded in time, just
 * before the held tokens are dropped. The ask is best effort by construction:
 * nothing the adapter does, throws or answers can stop the disconnect, and
 * what comes back is a value-blind outcome, never a token, a body or the
 * provider's text.
 */

/** The longest a disconnect waits for the provider to answer. */
export const SESSION_RELEASE_TIMEOUT_MS = 10_000;

const failed = (reason: string): SessionRelease => ({
  revoked: false,
  reason,
});

/**
 * The adapter's release outcome, or `undefined` when it holds no session.
 * `context` must carry a signal that ends the attempt at the timeout; the race
 * here is the backstop for an adapter that ignores it.
 */
export async function releaseSession(
  adapter: ConnectorAdapter | undefined,
  context: AdapterCallContext,
  timeoutMs: number = SESSION_RELEASE_TIMEOUT_MS,
): Promise<SessionRelease | undefined> {
  if (!adapter?.releaseSession) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      adapter.releaseSession(context),
      new Promise<SessionRelease>((resolve) => {
        timer = setTimeout(
          () => resolve(failed("session.release.timeout")),
          timeoutMs,
        );
      }),
    ]);
    // An answer is held to the schema a person reads it under.
    const checked = sessionReleaseSchema.safeParse(answer);
    return checked.success ? checked.data : failed("session.release.invalid");
  } catch {
    return failed("session.release.failed");
  } finally {
    clearTimeout(timer);
  }
}
