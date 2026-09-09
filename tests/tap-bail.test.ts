import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
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
