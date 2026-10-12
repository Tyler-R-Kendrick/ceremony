import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { HandoffPort } from "../../../src/server/connectors/ports.js";
import {
  claimHandoff,
  submissionOf,
  withHandoffClaim,
} from "../../../src/server/connectors/commands/handoff-claim.js";

/*
 * How the command layer names a submission and waits on an identical one.
 * The port rules (who may hold a claim, the lease, the compare-and-set) are
 * the state suite's; these are the two decisions the service makes on top.
 */

const handoff = { handoffRef: "handoff:one", generation: 0 };
const input = (values: Record<string, string>) =>
  ({ kind: "input", values }) as const;

test("a submission is a digest of the handoff, its generation and the values", () => {
  const base = submissionOf(handoff, input({ a: "1", b: "2" }));
  assert.match(base ?? "", /^[a-f0-9]{64}$/);
  // Values are not in it, even when they are long enough to be seen.
  const secret = "vtok_dummy_marker_0123456789abcdef";
  assert.equal(
    submissionOf(handoff, input({ token: secret }))?.includes(secret),
    false,
  );
  // The same values in any order are the same submission.
  assert.equal(submissionOf(handoff, input({ b: "2", a: "1" })), base);
  // Another value, another handoff or another generation is another submission.
  for (const other of [
    submissionOf(handoff, input({ a: "1", b: "3" })),
    submissionOf(
      { ...handoff, handoffRef: "handoff:two" },
      input({ a: "1", b: "2" }),
    ),
    submissionOf({ ...handoff, generation: 1 }, input({ a: "1", b: "2" })),
  ])
    assert.notEqual(other, base);
});

test("only a person's input is claimed; a redirect, an event and a poll are not", () => {
  const url = new URL("https://app.example/callback?state=s&code=c");
  assert.equal(submissionOf(handoff, { kind: "redirect", url }), undefined);
  assert.equal(submissionOf(handoff, { kind: "poll" }), undefined);
  assert.equal(
    submissionOf(handoff, {
      kind: "event",
      event: {} as never,
    }),
    undefined,
  );
});

/** A port that answers each claim from a script. */
function scripted(...script: Array<"claimed" | "shared" | ConnectorError>) {
  const calls: unknown[][] = [];
  const handoffs = {
    claim: async (...args: unknown[]) => {
      calls.push(args);
      const next = script.shift();
      if (next === undefined)
        throw new Error("claimed more often than scripted");
      if (next instanceof ConnectorError) throw next;
      return next;
    },
  } as unknown as HandoffPort;
  return { handoffs, calls };
}
const SUBMISSION = "c".repeat(64);
const ATTEMPT = "attempt-one-0001";
const completed = new ConnectorError("conflict", {
  detail: "handoff.already-completed",
});

test("a claim that is ours is answered at once, with the handoff, generation and lease it named", async () => {
  const { handoffs, calls } = scripted("claimed");
  assert.equal(
    await claimHandoff(handoffs, handoff, SUBMISSION, ATTEMPT, 1000),
    "claimed",
  );
  assert.deepEqual(calls, [["handoff:one", 0, SUBMISSION, ATTEMPT, 1000]]);
});

test("an identical submission in flight is waited for, and its settling is our answer", async () => {
  const { handoffs, calls } = scripted("shared", "shared", completed);
  assert.equal(
    await claimHandoff(handoffs, handoff, SUBMISSION, ATTEMPT, 1000),
    "settled",
  );
  assert.equal(calls.length, 3);
});

test("an identical submission whose run failed hands us the claim", async () => {
  const { handoffs } = scripted("shared", "claimed");
  assert.equal(
    await claimHandoff(handoffs, handoff, SUBMISSION, ATTEMPT, 1000),
    "claimed",
  );
});

test("a refusal from the port is not swallowed, at the first look or a later one", async () => {
  const claimed = new ConnectorError("conflict", {
    detail: "handoff.already-claimed",
  });
  const expired = new ConnectorError("expired", { detail: "handoff.expired" });
  for (const script of [
    [claimed],
    ["shared", expired],
    ["shared", claimed],
  ] as const) {
    const { handoffs } = scripted(...script);
    await assert.rejects(
      claimHandoff(handoffs, handoff, SUBMISSION, ATTEMPT, 1000),
      (error: unknown) => error === script.at(-1),
    );
  }
  // A completed handoff at the first look is the caller's to refuse, not an answer.
  await assert.rejects(
    claimHandoff(
      scripted(completed).handoffs,
      handoff,
      SUBMISSION,
      ATTEMPT,
      1000,
    ),
    (error: unknown) => error === completed,
  );
});

test("waiting on an identical submission ends at the lease, with a typed refusal", async () => {
  const { handoffs, calls } = scripted(
    ...Array.from({ length: 50 }, () => "shared" as const),
  );
  await assert.rejects(
    claimHandoff(handoffs, handoff, SUBMISSION, ATTEMPT, 60),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "conflict" &&
      error.detail === "handoff.claim-timeout",
  );
  assert.ok(calls.length >= 2 && calls.length < 10, `${calls.length} looks`);
});

/** A port that says "shared" once, then that the run settled the handoff. */
const joined = () => scripted("shared", completed);
const submitted = {
  kind: "input",
  values: { choice: "a" },
} as const;

test("a waiter answers only once the connection shows the run's write, and then from it", async () => {
  const { handoffs } = joined();
  let looks = 0;
  const answered = await withHandoffClaim(
    {
      handoffs,
      newAttempt: () => ATTEMPT,
      leaseMs: 1000,
      landed: async () => ++looks >= 4,
    },
    handoff,
    submitted,
    async () => "ran",
    async () => `answered after ${looks} looks`,
  );
  assert.equal(answered, "answered after 4 looks");
});

test("a waiter whose winner never writes answers when the wait runs out, and does not throw", async () => {
  const { handoffs } = joined();
  const started = Date.now();
  const answered = await withHandoffClaim(
    {
      handoffs,
      newAttempt: () => ATTEMPT,
      leaseMs: 80,
      landed: async () => false,
    },
    handoff,
    submitted,
    async () => "ran",
    async () => "answered anyway",
  );
  assert.equal(answered, "answered anyway");
  assert.ok(Date.now() - started < 2_000);
});

test("a completion that is not a person's input runs without a claim", async () => {
  let claimed = 0;
  const handoffs = {
    claim: async () => ++claimed,
  } as unknown as HandoffPort;
  const ran = await withHandoffClaim(
    {
      handoffs,
      newAttempt: () => ATTEMPT,
      leaseMs: 1000,
      landed: async () => true,
    },
    handoff,
    { kind: "poll" },
    async (attempt) => `ran with ${attempt}`,
    async () => "answered",
  );
  assert.equal(ran, "ran with undefined");
  assert.equal(claimed, 0);
});

test("a claim is given back when the run ends, whichever way it ends", async () => {
  for (const ending of ["returns", "throws"] as const) {
    const released: unknown[][] = [];
    const handoffs = {
      claim: async () => "claimed",
      release: async (...args: unknown[]) => void released.push(args),
    } as unknown as HandoffPort;
    const work = withHandoffClaim(
      {
        handoffs,
        newAttempt: () => ATTEMPT,
        leaseMs: 1000,
        landed: async () => true,
      },
      handoff,
      submitted,
      async (attempt) => {
        assert.equal(attempt, ATTEMPT);
        if (ending === "throws") throw new Error("run failed");
        return "done";
      },
      async () => "answered",
    );
    if (ending === "throws") await assert.rejects(work, /run failed/);
    else assert.equal(await work, "done");
    assert.deepEqual(released, [["handoff:one", ATTEMPT]]);
  }
});

test("a waiter stops waiting when its request is aborted, long before the lease", async () => {
  const forever = scripted(
    ...Array.from({ length: 400 }, () => "shared" as const),
  );
  const request = new AbortController();
  setTimeout(() => request.abort(), 60);
  const started = Date.now();
  await assert.rejects(
    withHandoffClaim(
      {
        handoffs: forever.handoffs,
        newAttempt: () => ATTEMPT,
        leaseMs: 60_000,
        signal: request.signal,
        landed: async () => true,
      },
      handoff,
      submitted,
      async () => "ran",
      async () => "answered",
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "cancelled",
  );
  assert.ok(Date.now() - started < 2_000, "it did not wait out the 60 s lease");
  assert.ok(forever.calls.length < 20, `${forever.calls.length} looks`);
});

test("a waiter whose winner has settled also stops waiting for the write when aborted", async () => {
  const request = new AbortController();
  setTimeout(() => request.abort(), 60);
  await assert.rejects(
    withHandoffClaim(
      {
        handoffs: joined().handoffs,
        newAttempt: () => ATTEMPT,
        leaseMs: 60_000,
        signal: request.signal,
        landed: async () => false,
      },
      handoff,
      submitted,
      async () => "ran",
      async () => "answered",
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "cancelled",
  );
});

/** The budget is time that has passed, not loops that were made: a slow store does not stretch it. */
const slow = (ms: number, answers: Array<"shared" | ConnectorError>) =>
  ({
    claim: async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      const next = answers.shift();
      if (next === undefined)
        throw new Error("claimed more often than scripted");
      if (next instanceof ConnectorError) throw next;
      return next;
    },
  }) as unknown as HandoffPort;

test("waiting on an identical submission is bounded by elapsed time even when each look is slow", async () => {
  const started = Date.now();
  await assert.rejects(
    claimHandoff(
      slow(
        100,
        Array.from({ length: 100 }, () => "shared" as const),
      ),
      handoff,
      SUBMISSION,
      ATTEMPT,
      500,
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "handoff.claim-timeout",
  );
  // Counting 25 ms per loop, twenty slow looks would have taken 2.5 s.
  assert.ok(Date.now() - started < 1_500, `${Date.now() - started} ms`);
});

test("waiting for the winner's write is bounded by elapsed time even when each look is slow", async () => {
  const started = Date.now();
  let looks = 0;
  const answered = await withHandoffClaim(
    {
      handoffs: joined().handoffs,
      newAttempt: () => ATTEMPT,
      leaseMs: 400,
      landed: async () => {
        looks++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return false;
      },
    },
    handoff,
    submitted,
    async () => "ran",
    async () => "answered anyway",
  );
  assert.equal(answered, "answered anyway");
  assert.ok(looks < 10, `${looks} looks`);
  assert.ok(Date.now() - started < 1_200, `${Date.now() - started} ms`);
});
