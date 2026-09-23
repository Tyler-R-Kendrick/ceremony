import { createHash } from "node:crypto";
import type {
  EffectIntent,
  EffectJournalPort,
  EffectOutcome,
  RandomPort,
} from "./ports.js";

/*
 * One journal entry per request actually sent.
 *
 * The durable effect journal records an outcome once: a repeated
 * (tenant, operation, digest) answers with the earlier outcome, and completing
 * a completed entry with a different status is `effect.already-completed`. An
 * adapter that reuses an entry for a second request therefore either loses
 * the second outcome or fails outright -- the in-memory double used to hide
 * this by overwriting. Two request shapes need a new entry each:
 *
 * - A read whose replay is `read-only`. Repeating it is a new observation,
 *   never a replay of the old one, so each request gets a fresh identity.
 * - An attempt at an effect after an earlier attempt was recorded
 *   `not-applied` (refused before it ran, including a 401 that a credential
 *   renewal then cures). That attempt never happened, so the next one is
 *   journaled as attempt n+1 of the same effect. Walking the chain from the
 *   first attempt keeps the property that matters: once any attempt was
 *   applied, or its outcome is unknown, every later caller gets that answer
 *   instead of a second effect.
 *
 * Attempt 0 keeps the effect's own digest, so entries written before this
 * existed still answer repeated requests.
 */

/** Attempts one effect may accumulate before the journal's answer stands; bounds the chain walk. */
export const MAX_EFFECT_ATTEMPTS = 16;

export type AttemptMode = "each-request" | "until-applied";

export type BegunAttempt = {
  effectRef: string;
  /** The outcome that answers this request instead of sending it; absent means send. */
  prior?: EffectOutcome;
  attempt: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Digest of the n-th attempt at one effect. */
export function attemptDigest(digest: string, attempt: number): string {
  return attempt === 0 ? digest : sha256(`${digest}\nattempt:${attempt}`);
}

/**
 * Begins the journal entry for the request about to be sent. A returned
 * `prior` is the effect's settled answer (applied, failed, reconciled,
 * indeterminate or in flight); after `MAX_EFFECT_ATTEMPTS` refusals the last
 * `not-applied` is returned as the answer rather than trying forever.
 */
export async function beginAttempt(
  effects: EffectJournalPort,
  intent: EffectIntent,
  options: { mode: AttemptMode; random: RandomPort },
): Promise<BegunAttempt> {
  if (options.mode === "each-request") {
    const begun = await effects.begin({
      ...intent,
      digest: sha256(`${intent.digest}\nrequest:${options.random.uuid()}`),
    });
    return { ...begun, attempt: 0 };
  }
  let last: BegunAttempt | undefined;
  for (let attempt = 0; attempt < MAX_EFFECT_ATTEMPTS; attempt++) {
    const begun = await effects.begin({
      ...intent,
      digest: attemptDigest(intent.digest, attempt),
    });
    if (!begun.prior || begun.prior.status !== "not-applied")
      return { ...begun, attempt };
    last = { ...begun, attempt };
  }
  return last!;
}
