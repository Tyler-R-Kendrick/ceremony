import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { canonicalConnectorJson } from "../../../core/connectors/index.js";
import type { CompletionInput } from "../adapter.js";
import { ConnectorError } from "../errors.js";
import type { HandoffPort, HandoffRecord } from "../ports.js";

/*
 * One submission works a handoff at a time. A person's values complete an
 * input-required handoff through an adapter that may share work between
 * callers (a single-flight rotation answers a second caller from the first
 * caller's run), so which values were acted on cannot be left to whichever
 * caller settles the handoff first. The handoff is claimed for one attempt of
 * one submission before any adapter runs. A different submission is refused
 * and nothing on the connection changes; an identical one is answered from the
 * first run.
 *
 * Redirects and provider events are not claimed here: their effect journal
 * entry is keyed by the handoff alone and already admits one.
 */

/** How often a joined submission looks again at the run it joined. */
const POLL_MS = 25;

/**
 * A digest of what was submitted, bound to this handoff and generation. The
 * values cannot be read back from it, and it is kept only inside the sealed
 * handoff record while the handoff is pending.
 */
export function submissionOf(
  handoff: Pick<HandoffRecord, "handoffRef" | "generation">,
  input: CompletionInput,
): string | undefined {
  if (input.kind !== "input") return undefined;
  return createHash("sha256")
    .update(
      canonicalConnectorJson([
        "handoff.submission",
        handoff.handoffRef,
        handoff.generation,
        input.values,
      ]),
    )
    .digest("hex");
}

/**
 * Claims the handoff for one attempt of a submission. `claimed` means the
 * caller runs it (and must give the claim back if it does not settle the
 * handoff); `settled` means an identical submission was in flight and has
 * since settled the handoff, so the caller's answer is the connection as that
 * run left it. Anything else is a refusal from the port. A joined submission
 * whose run failed takes the claim over and runs for itself, as a second try
 * would.
 */
export async function claimHandoff(
  handoffs: HandoffPort,
  handoff: Pick<HandoffRecord, "handoffRef" | "generation">,
  submission: string,
  attempt: string,
  leaseMs: number,
): Promise<"claimed" | "settled"> {
  const claim = () =>
    handoffs.claim(
      handoff.handoffRef,
      handoff.generation,
      submission,
      attempt,
      leaseMs,
    );
  let outcome = await claim();
  for (let waited = 0; outcome === "shared"; waited += POLL_MS) {
    if (waited >= leaseMs)
      throw new ConnectorError("conflict", { detail: "handoff.claim-timeout" });
    await sleep(POLL_MS);
    try {
      outcome = await claim();
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        error.code === "conflict" &&
        error.detail === "handoff.already-completed"
      )
        return "settled";
      throw error;
    }
  }
  return "claimed";
}

export type ClaimContext = {
  handoffs: HandoffPort;
  /** A fresh random token naming one attempt. */
  newAttempt(): string;
  leaseMs: number;
  /**
   * Whether the connection no longer shows the handoff as pending. A run
   * settles the handoff before it writes the connection, so a waiter answers
   * only once this is true (or the wait runs out).
   */
  landed(): Promise<boolean>;
};

/** Polls `check` until it holds or `budgetMs` of polling has passed; says whether it held. */
async function pollUntil(
  check: () => Promise<boolean>,
  budgetMs: number,
): Promise<boolean> {
  for (let waited = 0; ; waited += POLL_MS) {
    if (await check()) return true;
    if (waited >= budgetMs) return false;
    await sleep(POLL_MS);
  }
}

/**
 * Runs `run` while holding the handoff's claim, if a person's values are being
 * submitted (any other completion runs as it always did, `attempt` undefined).
 * `run` gets the attempt token, which it presents when it settles the handoff.
 * The claim is given back when `run` ends, so an attempt that failed or left
 * the handoff pending lets the next try in; settling the handoff took it
 * already. A submission that joined another's run is answered by
 * `answerSettled` once that run has settled the handoff.
 */
export async function withHandoffClaim<T>(
  context: ClaimContext,
  handoff: Pick<HandoffRecord, "handoffRef" | "generation">,
  input: CompletionInput,
  run: (attempt: string | undefined) => Promise<T>,
  answerSettled: () => Promise<T>,
): Promise<T> {
  const submission = submissionOf(handoff, input);
  if (submission === undefined) return run(undefined);
  const attempt = context.newAttempt();
  const claimed = await claimHandoff(
    context.handoffs,
    handoff,
    submission,
    attempt,
    context.leaseMs,
  );
  if (claimed === "settled") {
    // The run that held the claim has settled the handoff; its write to the
    // connection may be a step behind. What is answered is what it wrote.
    await pollUntil(context.landed, context.leaseMs);
    return answerSettled();
  }
  try {
    return await run(attempt);
  } finally {
    await context.handoffs.release(handoff.handoffRef, attempt).catch(() => {});
  }
}
