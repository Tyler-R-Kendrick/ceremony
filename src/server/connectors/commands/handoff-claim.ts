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
 * caller settles the handoff first. The handoff is claimed for one submission
 * before any adapter runs. A different submission is refused and nothing on
 * the connection changes; an identical one is answered from the first run.
 *
 * Redirects and provider events are not claimed here: their effect journal
 * entry is keyed by the handoff alone and already admits only one.
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
 * Claims the handoff for a submission. `claimed` means the caller runs it (and
 * must give the claim back if it does not settle the handoff); `settled` means
 * an identical submission was in flight and has since settled the handoff, so
 * the caller's answer is the connection as that run left it. Anything else is
 * a refusal from the port. A joined submission whose run failed takes the
 * claim over and runs for itself, as a second try would.
 */
export async function claimHandoff(
  handoffs: HandoffPort,
  handoff: Pick<HandoffRecord, "handoffRef" | "generation">,
  submission: string,
  leaseMs: number,
): Promise<"claimed" | "settled"> {
  const claim = () =>
    handoffs.claim(handoff.handoffRef, handoff.generation, submission, leaseMs);
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
