import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { HandoffPort } from "../../../src/server/connectors/ports.js";
import {
  claimHandoff,
  submissionOf,
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
const completed = new ConnectorError("conflict", {
  detail: "handoff.already-completed",
});

test("a claim that is ours is answered at once, with the handoff, generation and lease it named", async () => {
  const { handoffs, calls } = scripted("claimed");
  assert.equal(
    await claimHandoff(handoffs, handoff, SUBMISSION, 1000),
    "claimed",
  );
  assert.deepEqual(calls, [["handoff:one", 0, SUBMISSION, 1000]]);
});

test("an identical submission in flight is waited for, and its settling is our answer", async () => {
  const { handoffs, calls } = scripted("shared", "shared", completed);
  assert.equal(
    await claimHandoff(handoffs, handoff, SUBMISSION, 1000),
    "settled",
  );
  assert.equal(calls.length, 3);
});

test("an identical submission whose run failed hands us the claim", async () => {
  const { handoffs } = scripted("shared", "claimed");
  assert.equal(
    await claimHandoff(handoffs, handoff, SUBMISSION, 1000),
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
      claimHandoff(handoffs, handoff, SUBMISSION, 1000),
      (error: unknown) => error === script.at(-1),
    );
  }
  // A completed handoff at the first look is the caller's to refuse, not an answer.
  await assert.rejects(
    claimHandoff(scripted(completed).handoffs, handoff, SUBMISSION, 1000),
    (error: unknown) => error === completed,
  );
});

test("waiting on an identical submission ends at the lease, with a typed refusal", async () => {
  const { handoffs, calls } = scripted(
    ...Array.from({ length: 50 }, () => "shared" as const),
  );
  await assert.rejects(
    claimHandoff(handoffs, handoff, SUBMISSION, 60),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "conflict" &&
      error.detail === "handoff.claim-timeout",
  );
  assert.ok(calls.length >= 2 && calls.length < 10, `${calls.length} looks`);
});
