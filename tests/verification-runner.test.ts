import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeStage,
  requiredStages,
  coverageTotals,
  failedTestFiles,
} from "../scripts/verification-summary.js";
import {
  browserVersions,
  profileFingerprint,
} from "../scripts/verification-metadata.js";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

test("OPS: failed test diagnostics retain only known inventory names", () => {
  const inventory = ["tests/one.test.ts", "tests/nested/two.test.ts"];
  const output = [
    "test at tests/one.test.ts:12:3",
    "private-provider-error password=synthetic-secret",
    "  location: '/private-user/checkout/tests/nested/two.test.ts:2:8'",
    "test at tests/private-secret.test.ts:1:1",
    "test at tests/one.test.ts:13:1",
    "test at tests/one.test.ts:12:3 private-secret",
    "provider says test at tests/one.test.ts:12:3",
  ].join("\n");
  assert.deepEqual(failedTestFiles(output, inventory), inventory);
  assert.deepEqual(failedTestFiles(output, []), []);
  assert.deepEqual(failedTestFiles("private-provider-error", inventory), []);
  assert.deepEqual(
    failedTestFiles(
      "\u001b[31mtest at tests/one.test.ts:1:2\u001b[0m",
      inventory,
    ),
    [inventory[0]],
  );
});

test("OPS: actual Node assertion failures identify a file without retaining diagnostics", () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const fixture = "tests/fixtures/runner-sentinel.ts";
  for (const reporter of ["spec", "tap"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--no-experimental-webstorage",
        "--import",
        "tsx",
        "--test",
        `--test-reporter=${reporter}`,
        fixture,
      ],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CEREMONY_EXPECTED_ASSERTION_FAILURE/);
    assert.deepEqual(failedTestFiles(result.stdout, [fixture]), [fixture]);
  }
});

test("OPS: runtime metadata fingerprints actual profile and never substitutes unavailable browser versions", async () => {
  const profile = JSON.parse(
    await readFile(
      new URL(
        "../docs/implementation-evidence/ceremony-teaching/local-profile.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(profileFingerprint(profile).profile, "local");
  assert.notEqual(
    profileFingerprint(profile).configurationDigest,
    profileFingerprint({ ...profile, configurationVersion: "changed" })
      .configurationDigest,
  );
  assert.throws(() => profileFingerprint({ ...profile, apiKey: "forbidden" }));
  let closed = 0;
  const launch = async () => ({
    version: () => "123.4",
    close: async () => {
      closed++;
    },
  });
  assert.deepEqual(
    await browserVersions({
      chromium: launch,
      firefox: launch,
      webkit: launch,
    }),
    { chromium: "123.4", firefox: "123.4", webkit: "123.4" },
  );
  assert.equal(closed, 3);
  await assert.rejects(
    browserVersions({
      chromium: launch,
      firefox: async () => {
        throw new Error("missing binary");
      },
      webkit: launch,
    }),
  );
  assert.equal(closed, 4);
  await assert.rejects(
    browserVersions({
      chromium: async () => ({
        version: () => "",
        close: async () => {
          closed++;
        },
      }),
      firefox: launch,
      webkit: launch,
    }),
  );
  assert.equal(closed, 5);
});

test("OPS: deterministic stages preserve required gates and fail closed on empty, missing or skipped summaries", () => {
  // The build stages precede the test stages deliberately. A stage passes only
  // when nothing was skipped, asserted below, so a test whose prerequisite this
  // pipeline builds later can only ever skip and so fail its stage. Building
  // first makes that prerequisite true instead of relaxing the rule.
  assert.deepEqual(requiredStages, [
    "format:check",
    "check",
    "build",
    "build:hosted",
    "build:vercel",
    "test:coverage",
    "test:workflow",
    "test:security:mutation",
    "test:e2e",
  ]);
  assert.ok(
    requiredStages.indexOf("build") < requiredStages.indexOf("test:coverage"),
    "build must precede the stage whose tests need its output",
  );
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
