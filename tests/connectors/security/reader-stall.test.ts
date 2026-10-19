import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { readBoundedBytes } from "../../../src/core/bounded-body.js";

/*
 * What the deadline does when the stream under a read is not the one the
 * specification describes. A deadline that waits for the stream to settle a
 * pending read when it is cancelled is not a deadline for a stream that never
 * does, and neither is one that waits for a cancel to finish.
 */

const NEVER = new Promise<never>(() => {});
/** Far above anything a settled read takes here, far below a test's patience. */
const GUARD_MS = 2_000;
const TOO_LARGE = new Error("too large");

/** A response whose body is a reader that never answers, and never finishes being cancelled. */
function stalled(chunk?: Uint8Array): Response {
  let sent = false;
  return {
    body: {
      getReader: () => ({
        read: () =>
          chunk && !sent
            ? ((sent = true), Promise.resolve({ done: false, value: chunk }))
            : NEVER,
        cancel: () => NEVER,
      }),
    },
  } as unknown as Response;
}

const settledWithin = (work: Promise<unknown>) =>
  Promise.race([
    work.then(
      () => "resolved",
      (error: unknown) => error,
    ),
    sleep(GUARD_MS).then(() => "hung"),
  ]);

test("a deadline ends a read whose stream never answers and never finishes being cancelled", async () => {
  const caller = new AbortController();
  setTimeout(() => caller.abort(), 100);
  const outcome = await settledWithin(
    readBoundedBytes(
      stalled(),
      1_024,
      () => new Error("too large"),
      caller.signal,
    ),
  );
  assert.notEqual(outcome, "hung", "the read outlived its deadline");
  assert.ok(
    outcome instanceof DOMException && outcome.name === "AbortError",
    String(outcome),
  );
});

test("a body over its ceiling is refused though cancelling it never finishes", async () => {
  const outcome = await settledWithin(
    readBoundedBytes(stalled(new Uint8Array(2_048)), 1_024, () => TOO_LARGE),
  );
  assert.notEqual(outcome, "hung", "the refusal waited for the cancel");
  assert.equal(outcome, TOO_LARGE);
});
