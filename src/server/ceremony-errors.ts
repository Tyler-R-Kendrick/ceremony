import { refuseIfTooLarge } from "./connectors/auth/response-bound.js";

/*
 * The errors a ceremony step raises to the person running it: a message they
 * can read and the HTTP status the host answers with.
 */

export class CeremonyError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
/**
 * A request went out and its answer could not be read (it ran past the size
 * ceiling), so whether it did what it asked (minted a token, registered an
 * identity, spent a code) is unknown. The attempt ends here: nothing is
 * stored, and nothing is sent again on its strength.
 */
export class IndeterminateAnswer extends CeremonyError {
  readonly outcome = "indeterminate" as const;
  constructor() {
    super(
      "The provider's answer was too large to read, so whether it completed the request is unknown. Nothing was stored; check at the provider before trying again.",
      502,
    );
  }
}

/**
 * For `.catch` on `boundedResponseJson` where the request was already sent
 * (a handshake, a session opened at a remote browser service): an answer too
 * large to read is an `IndeterminateAnswer`, the same unknown every other
 * flow reports for it; anything else is the caller's to see.
 */
export const indeterminateIfTooLarge = refuseIfTooLarge(
  () => new IndeterminateAnswer(),
);

/** The reason a step that could not start reports: unknown when an answer went unread, else `otherwise`. */
export const unknownOr = (error: unknown, otherwise: string): string =>
  error instanceof IndeterminateAnswer ? "indeterminate" : otherwise;
