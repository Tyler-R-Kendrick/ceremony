import type { AdapterCallContext, CompletionResult } from "../../adapter.js";
import type { DevicePollState } from "../../auth/index.js";
import { ConnectorError } from "../../errors.js";
import { oidcFailure, type AwsReply } from "./client.js";
import {
  AWS_IDENTITY_CENTER_ADAPTER_ID,
  SLOW_DOWN_INCREMENT_S,
} from "./contracts.js";
import { sessionScope } from "./material.js";

/*
 * What one poll of the device code can end in, and the bookkeeping around it:
 * the pending answer with the next allowed poll time, the signals that end a
 * poll from inside custody's rotation without rewriting the record, how a
 * refused CreateToken maps onto them, and settling or discarding what the
 * sign-in registered. The poll itself is in device.ts.
 */

const code = (suffix: string) => `${AWS_IDENTITY_CENTER_ADAPTER_ID}.${suffix}`;

export function pending(
  codeSuffix: string,
  poll: DevicePollState,
): CompletionResult {
  return {
    state: "pending",
    claims: [],
    code: code(codeSuffix),
    adapterState: { devicePoll: poll },
  };
}

export function devicePollState(
  ctx: AdapterCallContext,
): DevicePollState | undefined {
  const raw = ctx.connection?.state["devicePoll"];
  if (!raw || typeof raw !== "object") return undefined;
  const { interval, nextPollAt } = raw as Record<string, unknown>;
  if (
    typeof interval !== "number" ||
    typeof nextPollAt !== "number" ||
    !Number.isFinite(interval) ||
    !Number.isFinite(nextPollAt)
  )
    return undefined;
  return { interval, nextPollAt };
}

/** The sign-in will not continue, so nothing it registered is kept. */
export async function discardRegistration(
  ctx: AdapterCallContext,
  ref: string | undefined,
): Promise<void> {
  if (ref)
    await ctx.environment.credentials
      .revoke(sessionScope(ctx), ref)
      .catch(() => {});
}

/** Thrown inside the custody callback to end a poll without rewriting the record. */
export class PollEnded extends Error {
  constructor(readonly result: CompletionResult) {
    super("poll ended");
  }
}

/** A definitive refusal of the device code: not retried, never an indeterminate outcome. */
export class Refusal extends Error {
  constructor(readonly failure: ConnectorError) {
    super("refused");
  }
}

export async function settleHandoff(
  ctx: AdapterCallContext,
  state: "completed" | "denied" | "expired",
  options: { bestEffort?: boolean } = {},
): Promise<void> {
  try {
    await ctx.environment.handoffs.complete(
      ctx.handoff!.handoffRef,
      ctx.generation,
      state,
    );
  } catch (error) {
    // A handoff past its own expiry may refuse to be completed; it is over
    // either way, and what matters is that the attempt ends as expired.
    if (options.bestEffort) return;
    throw new ConnectorError("conflict", {
      detail: "oauth.handoff.stale-generation",
      cause: error,
    });
  }
}

export async function indeterminate(
  ctx: AdapterCallContext,
  poll: DevicePollState,
  settle: (status: "indeterminate", outcome: string) => Promise<void>,
): Promise<CompletionResult> {
  await settle("indeterminate", code("device.indeterminate"));
  return {
    state: "indeterminate",
    claims: [],
    code: code("device.indeterminate"),
    adapterState: {
      devicePoll: {
        interval: poll.interval,
        nextPollAt: ctx.environment.now() + poll.interval * 1000,
      },
    },
  };
}

/** Maps a refused CreateToken to the signal that ends this poll. */
export async function refused(
  ctx: AdapterCallContext,
  reply: Extract<AwsReply<unknown>, { ok: false }>,
  poll: DevicePollState,
  settle: (
    status: "not-applied" | "failed" | "indeterminate",
    outcome: string,
  ) => Promise<void>,
): Promise<PollEnded | Refusal> {
  const now = ctx.environment.now();
  if (reply.status >= 500)
    return new PollEnded(await indeterminate(ctx, poll, settle));
  switch (reply.error) {
    case "authorization_pending":
      await settle("not-applied", code("device.pending"));
      return new PollEnded(
        pending("device.pending", {
          interval: poll.interval,
          nextPollAt: now + poll.interval * 1000,
        }),
      );
    case "slow_down": {
      const interval = poll.interval + SLOW_DOWN_INCREMENT_S;
      await settle("not-applied", code("device.slow-down"));
      return new PollEnded(
        pending("device.slow-down", {
          interval,
          nextPollAt: now + interval * 1000,
        }),
      );
    }
    case "access_denied":
      await settle("failed", code("device.access-denied"));
      await settleHandoff(ctx, "denied");
      return new PollEnded({
        state: "denied",
        claims: [],
        code: code("device.access-denied"),
        handoffSettled: true,
      });
    case "expired_token":
      await settle("failed", code("device.expired"));
      await settleHandoff(ctx, "expired");
      return new PollEnded({
        state: "expired",
        claims: [],
        code: code("device.expired"),
        handoffSettled: true,
      });
    default:
      await settle("failed", code("device.rejected"));
      await settleHandoff(ctx, "denied");
      return new Refusal(oidcFailure(reply));
  }
}
