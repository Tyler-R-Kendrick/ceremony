import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeStage,
  requiredStages,
  coverageTotals,
  failedTestFiles,
  failedTestNames,
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

test("OPS: a failed case is named from the inventory, never quoted from output", () => {
  const inventory = [
    "AUTH-COMBINED: a combined form logs the expected account in",
    "LIFE-RETURN: the session still works after the call returns",
  ];
  const output = [
    "    not ok 1 - AUTH-COMBINED: a combined form logs the expected account in",
    "      error: |-",
    "        password=synthetic-secret refused by https://provider.invalid",
    "    not ok 2 - a case name no file in this repository authors",
    "\u2716 LIFE-RETURN: the session still works after the call returns (1640.635375ms)",
  ].join("\n");
  // Both reporters are read, and only names the inventory already holds come
  // back — the unlisted one on the same line shape is dropped with the rest.
  assert.deepEqual(failedTestNames(output, inventory), inventory);
  assert.deepEqual(failedTestNames(output, []), []);
  assert.equal(
    failedTestNames(output, inventory).join("\n"),
    inventory.join("\n"),
  );
  // A passing case is not a failing one, whatever its name.
  assert.deepEqual(failedTestNames(`ok 1 - ${inventory[0]}`, inventory), []);
  assert.deepEqual(
    failedTestNames(`\u001b[31mnot ok 1 - ${inventory[1]}\u001b[0m`, inventory),
    [inventory[1]],
  );
});

test("OPS: an actual Node failure names its case, retaining no diagnostics", () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const fixture = "tests/fixtures/runner-sentinel.ts";
  const name = "Node must actually execute assertions";
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
    assert.deepEqual(failedTestNames(result.stdout, [name]), [name]);
    // The sentinel's own failure text is in that output and stays there.
    assert.deepEqual(
      failedTestNames(result.stdout, ["CEREMONY_EXPECTED_ASSERTION_FAILURE"]),
      [],
    );
  }
});

test("OPS: every inventoried case name is verbatim repository content", async () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/test.mjs", "all", "--inventory"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0);
  const { files, names } = JSON.parse(result.stdout) as {
    files: string[];
    names: string[];
  };
  assert.ok(names.length > 0, "the inventory must carry case names");
  assert.deepEqual(names, [...new Set(names)].sort());
  // The conformance suite is why this exists: twenty-four cases across three
  // engines that a file name alone cannot tell apart.
  assert.ok(
    names.includes(
      "AUTH-COMBINED: a combined form logs the expected account in",
    ),
  );
  const sources = (
    await Promise.all(files.map((file) => readFile(file, "utf8")))
  ).join("\n");
  for (const name of names)
    assert.ok(
      sources.includes(name),
      `${name} must be authored in a test file`,
    );
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
  assert.deepEqual(requiredStages, [
    "format:check",
    "check",
    "test:coverage",
    "test:workflow",
    "test:security:mutation",
    "build",
    "build:hosted",
    "build:vercel",
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
