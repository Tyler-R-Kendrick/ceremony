import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { safeWorkflowResult } from "./fixtures/workflow-safe-reporter.js";

test("Workflow CI diagnostics retain only state and allowlisted source locations", () => {
  const canary = randomUUID();
  const result = safeWorkflowResult({
    state: "failed",
    file: "/workspace/tests/workflow/agent.test.ts",
    line: 12,
    stacks: [
      `Error: ${canary}\n at fixture (/workspace/tests/workflow/agent.test.ts:184:7)\n provider body: ${canary}`,
    ],
  });
  assert.deepEqual(result, {
    state: "failed",
    file: "tests/workflow/agent.test.ts",
    declarationLine: 12,
    failureLocation: {
      file: "tests/workflow/agent.test.ts",
      line: 184,
      column: 7,
    },
  });
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.deepEqual(
    safeWorkflowResult({
      state: canary,
      file: `/private/${canary}`,
      stacks: [canary],
    }),
    { state: "failed", file: "unknown-test" },
  );
});
