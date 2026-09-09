import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeStage,
  requiredStages,
  coverageTotals,
} from "../scripts/verification-summary.js";

test("OPS: deterministic stages preserve required gates and fail closed on empty, missing or skipped summaries", () => {
  assert.deepEqual(requiredStages, [
    "format:check",
    "check",
    "test:coverage",
    "test:workflow",
    "test:security:mutation",
    "build",
    "build:hosted",
    "test:e2e",
  ]);
  for (const stage of [
    "test:coverage",
    "test:workflow",
    "test:e2e",
    "test:security:mutation",
  ] as const) {
    assert.equal(summarizeStage(stage, 0, "").exitCode, 1);
    assert.equal(summarizeStage(stage, null, "").exitCode, 1);
  }
  const node = "ℹ pass 12\nℹ fail 0\nℹ skipped 0\n";
  assert.equal(summarizeStage("test:coverage", 0, node).exitCode, 0);
  for (const output of [
    node.replace("pass 12", "pass 0"),
    node.replace("fail 0", "fail 1"),
    node.replace("skipped 0", "skipped 1"),
    "provider says pass 12",
  ])
    assert.equal(summarizeStage("test:coverage", 0, output).exitCode, 1);
  assert.equal(summarizeStage("test:coverage", 1, node).exitCode, 1);
  assert.equal(
    summarizeStage("test:workflow", 0, " Tests 2 passed (2)\n").exitCode,
    0,
  );
  for (const output of [
    "Tests 0 passed (0)",
    "Tests 1 passed | 1 skipped (2)",
    "Tests 1 passed (2)",
  ])
    assert.equal(summarizeStage("test:workflow", 0, output).exitCode, 1);
  assert.equal(summarizeStage("test:e2e", 0, "  10 passed (2m)\n").exitCode, 0);
  for (const suffix of [
    "  1 failed",
    "  1 flaky",
    "  1 skipped",
    "  1 did not run",
  ])
    assert.equal(
      summarizeStage("test:e2e", 0, `  10 passed (2m)\n${suffix}\n`).exitCode,
      1,
    );
  const report = (status: string) => ({
    files: { "src/guard.ts": { mutants: [{ status }] } },
  });
  assert.equal(
    summarizeStage("test:security:mutation", 0, "", report("Killed")).exitCode,
    0,
  );
  for (const status of [
    "Survived",
    "Timeout",
    "NoCoverage",
    "CompileError",
    "Ignored",
    "invented",
  ])
    assert.equal(
      summarizeStage("test:security:mutation", 0, "", report(status)).exitCode,
      1,
    );
  assert.equal(
    summarizeStage("check", null, "private-provider-diagnostic").exitCode,
    1,
  );
  assert.equal(
    JSON.stringify(
      summarizeStage("check", 1, "private-provider-diagnostic"),
    ).includes("private-provider"),
    false,
  );
});
test("OPS: retained coverage contains only numeric allowlisted aggregates", () => {
  const total = Object.fromEntries(
    ["lines", "statements", "branches", "functions"].map((key) => [
      key,
      { total: 10, covered: 9, skipped: 0, pct: 90, raw: "private" },
    ]),
  );
  assert.equal(
    JSON.stringify(coverageTotals({ total, error: "private" })).includes(
      "private",
    ),
    false,
  );
  for (const value of [
    null,
    {},
    { total: {} },
    { total: { ...total, lines: { total: "private" } } },
  ])
    assert.throws(() => coverageTotals(value));
});
