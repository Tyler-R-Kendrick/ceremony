import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { captureTapResult } from "../node_modules/@stryker-mutator/tap-runner/dist/src/tap-helper.js";

test("mutation runner records a real failed assertion before stopping a later hung test", async () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      "--test-reporter=tap",
      "--test",
      "--experimental-test-isolation=none",
      fileURLToPath(new URL("./fixtures/tap-bail.cjs", import.meta.url)),
    ],
    { env: environment },
  );
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
  }, 3000);
  try {
    const result = await captureTapResult(child, true);
    assert.equal(
      expired,
      false,
      "TAP assertion must trigger bailout before deadline",
    );
    assert.ok(result.failedTests.length > 0);
    assert.equal(result.result.ok, false);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});

test("a hung test with no failure before it is bounded by the runner's own timeout, and named", async () => {
  // The case above covers a hang that follows a failure: bail-out ends it. A
  // hang with nothing failing before it had no bound at all. The profile runs
  // every file in one process, so one test that never settled held the whole
  // dry run until Stryker's 25-minute timeout, which names nothing.
  // `browser-executor.test.ts` did exactly that three times in one day, on
  // main as well as on a pull request, and the log said only that the file
  // had started.
  //
  // The bound is two flags, and it takes both. `--test-timeout` fails a test
  // that never settles, but under the profile's single-process mode a leaked
  // handle keeps the process alive afterwards - a timer was enough to hold
  // it, and a browser is a bigger handle than a timer - and the failure
  // record was still being written out eight seconds later, cut mid-line when
  // the process was killed. The runner's reader never saw a parseable
  // failure. `--test-force-exit` is what ends the process once the tests are
  // done, which is what delivers the record. Established by running this
  // fixture with each flag alone.
  //
  // Both live in the profile's own node arguments, so they reach every
  // shard, and this reads them from there rather than restating them: a
  // profile that lost either flag fails here, not in a 25-minute run. The
  // value is shortened for the demonstration; what is under test is that the
  // runner turns a hang into a failure that names the test, in time.
  const profile = JSON.parse(
    readFileSync(new URL("../stryker.config.json", import.meta.url), "utf8"),
  ) as { tap: { nodeArgs: string[] } };
  const bound = profile.tap.nodeArgs.find((argument) =>
    argument.startsWith("--test-timeout="),
  );
  assert.ok(bound, "the mutation profile must bound every test");
  const ms = Number(bound.slice("--test-timeout=".length));
  assert.ok(
    Number.isInteger(ms) && ms > 0 && ms <= 300_000,
    `${ms}ms is not a bound a hang would meet before the dry run's own`,
  );
  assert.ok(
    profile.tap.nodeArgs.includes("--test-force-exit"),
    "the bound is not reported without the runner being made to exit",
  );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      ...profile.tap.nodeArgs.map((argument) =>
        argument === bound ? "--test-timeout=1500" : argument,
      ),
      fileURLToPath(new URL("./fixtures/tap-hang.cjs", import.meta.url)),
    ],
    { env: environment },
  );
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
  }, 10_000);
  try {
    const result = await captureTapResult(child, true);
    assert.equal(
      expired,
      false,
      "the runner's own bound must end the hang before the deadline",
    );
    assert.equal(result.result.ok, false);
    assert.ok(
      JSON.stringify(result.failedTests).includes(
        "an operation that never settles",
      ),
      "the failure must name the test that hung",
    );
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});
