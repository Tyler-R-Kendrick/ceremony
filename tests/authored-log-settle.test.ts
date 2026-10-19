import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { progressLog, SETTLE_TIMEOUT_MS } from "../src/server/authored-log.js";

/*
 * An authored run waits for its progress lines before it settles
 * (authored-log.ts). The wait is bounded: a store whose write never settles
 * holds the run open for the bound and no longer, and the lines it never
 * wrote are counted in a warning. The wait never fails, so it cannot replace
 * the step's own error.
 */

/** Resolves when the test says the bound has passed. */
function clock() {
  const waited: number[] = [];
  let pass: () => void = () => {};
  const passed = new Promise<void>((resolve) => (pass = resolve));
  return {
    waited,
    pass: () => pass(),
    wait: (ms: number) => {
      waited.push(ms);
      return passed;
    },
  };
}

const NEVER = new Promise<void>(() => {});
const GUARD_MS = 2_000;
const within = <T>(work: Promise<T>) =>
  Promise.race([work, sleep(GUARD_MS).then(() => "hung" as const)]);

test("a write that never settles holds settled() for the bound, and the unwritten lines are counted", async () => {
  const time = clock();
  const warned: number[] = [];
  const written: string[] = [];
  const log = progressLog(
    (text) =>
      text === "stuck" ? NEVER : (written.push(text), Promise.resolve()),
    { wait: time.wait, warn: (unwritten) => warned.push(unwritten) },
  );
  log.log("first");
  log.log("stuck");
  log.log("behind it");
  const settling = log.settled();
  assert.deepEqual(
    time.waited,
    [SETTLE_TIMEOUT_MS],
    "the bound is the documented one",
  );
  // The first line lands long before the bound passes.
  await sleep(20);
  time.pass();
  assert.notEqual(
    await within(settling),
    "hung",
    "settled() outlived its bound",
  );
  assert.deepEqual(written, ["first"]);
  assert.deepEqual(warned, [2], "two lines were never written");
});

test("settled() waits for the writes when they land within the bound, and warns of nothing", async () => {
  const time = clock();
  const warned: number[] = [];
  const written: string[] = [];
  const log = progressLog(
    async (text) => {
      await sleep(20);
      written.push(text);
    },
    { wait: time.wait, warn: (unwritten) => warned.push(unwritten) },
  );
  log.log("a");
  log.log("b");
  await log.settled();
  assert.deepEqual(written, ["a", "b"]);
  assert.deepEqual(warned, []);
});

test("a step's own error is not replaced by a log that never settles", async () => {
  const time = clock();
  const log = progressLog(() => NEVER, { wait: time.wait, warn: () => {} });
  log.log("stuck");
  const ownError = new Error("the step failed");
  const step = (async () => {
    try {
      throw ownError;
    } finally {
      await log.settled();
    }
  })();
  step.catch(() => {});
  time.pass();
  const outcome = await within(
    step.then(
      () => "resolved",
      (error: unknown) => error,
    ),
  );
  assert.equal(outcome, ownError);
});

test("a write that throws is dropped and does not count as unwritten", async () => {
  const warned: number[] = [];
  const log = progressLog(
    async (text) => {
      if (text === "bad") throw new Error("store down");
    },
    { warn: (unwritten) => warned.push(unwritten) },
  );
  log.log("bad");
  log.log("good");
  await log.settled();
  assert.deepEqual(warned, []);
});
