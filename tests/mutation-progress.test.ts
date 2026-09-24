import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findTestyLookingFiles } from "../node_modules/@stryker-mutator/tap-runner/dist/src/tap-helper.js";
import { mutationProgress } from "../scripts/verify-mutation.js";

test("mutation profile isolates fixture ports and bounded failures", () => {
  const profile = JSON.parse(
    readFileSync(new URL("../stryker.config.json", import.meta.url), "utf8"),
  );
  assert.equal(profile.concurrency, 1);
  assert.equal(profile.tap.testFiles[0], "tests/authoring-termination.test.ts");
  const workflow = readFileSync(
    new URL("../.github/workflows/verify.yml", import.meta.url),
    "utf8",
  );
  assert.equal(
    /--concurrency\b/.test(workflow),
    false,
    "CI must retain the profile's fixture isolation",
  );
});

test("the mutation dry run runs unit tests only, never a real browser", async () => {
  // The dry run runs every one of the profile's test files once, in one
  // process, to establish a green baseline and record per-test coverage. A
  // file that launches a real browser engine has no business there: it covers
  // `src/server/browser-*.ts`, which nothing in the mutation targets, and it
  // is the one kind of file that has ever held the whole dry run. Three
  // shards in one day died after such a file started - `browser-executor`
  // twice under the five-minute bound, `chaos` (real Chromium) once in a hook
  // the bound does not reach. The gate is not weakened by leaving them out.
  // Thirty-three of the heavy files are the sole killer of no target mutant,
  // read off the last green run's per-test coverage; the one that was -
  // `chaos`, for the `serverEventSchema` object literal - is replaced by a
  // direct unit test (`storage-events.test.ts`) that kills the same mutant
  // without a browser. They still run and still gate in the coverage and
  // browser-login jobs. This resolves the profile's globs exactly as the tap
  // runner does, so a glob that let a browser file back in fails here.
  const profile = JSON.parse(
    readFileSync(new URL("../stryker.config.json", import.meta.url), "utf8"),
  ) as { tap: { testFiles: string[] } };
  const files = await findTestyLookingFiles(profile.tap.testFiles);
  const launchesABrowser = files
    .filter((file) =>
      /(^|\/)(browser-|extension-)|(^|\/)(chaos|cloudflare)\.test\.ts$|\.e2e\.test\.ts$/.test(
        file,
      ),
    )
    .sort();
  assert.deepEqual(
    launchesABrowser,
    [],
    "no browser-launching test file may enter the mutation dry run",
  );
  // The unit and contract tests that actually cover the mutation targets are
  // still there - a negation group that excluded too much would empty the
  // baseline.
  for (const present of [
    "tests/execution.test.ts",
    "tests/resolution.test.ts",
    "tests/services.test.ts",
    "tests/arazzo.test.ts",
    "tests/environment.test.ts",
    "tests/connector-authoring.test.ts",
    "tests/contracts/services.test.ts",
  ])
    assert.ok(
      files.includes(present),
      `${present} covers a mutation target and must stay in the dry run`,
    );
  assert.ok(
    files.length >= 90,
    `the dry run kept only ${files.length} files; the negation group is too greedy`,
  );
});

test("a dry-run failure is named by the file it happened in, and nothing else", async () => {
  // Without this the baseline says only "exit 1". The dry run executes the whole
  // suite before a single mutant exists, so a genuine failure there is invisible
  // in exactly the way a genuine failure must not be.
  //
  // The line below is Stryker's, copied from a real failed dry run rather than
  // imagined. That distinction is the whole reason this case is worth having:
  // it used to feed a `not ok 4 - ...` line on the assumption that the test
  // process's TAP stream reaches Stryker's stdout. It does not, the tap runner
  // consumes it, and so the detector never fired on a real failure while this
  // case passed. A double may stand in for a slow dependency; it may not
  // invent the output the dependency produces.
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("16:00:00 (1) DEBUG TapTestRunner Running: `node \\"tests/one.test.ts\\"` in /private-checkout")',
    'console.log("not ok 4 - a private assertion message nobody may retain")',
    'console.log("16:00:01 (612) ERROR DryRunExecutor One or more tests failed in the initial test run:")',
    'console.log("\\ttests/one.test.ts")',
    'console.log("16:00:01 (612) ERROR Stryker There were failed tests in the initial test run.")',
    "setTimeout(() => process.exit(1), 30)",
  ].join(";");
  const code = await mutationProgress(
    process.execPath,
    ["-e", source],
    ["tests/one.test.ts", "tests/two.test.ts"],
    (record) => records.push(record),
  );
  assert.equal(code, 1);
  const failures = records.filter((r) => r.phase === "initial-failure");
  assert.deepEqual(failures, [
    {
      elapsedMs: failures[0]?.elapsedMs,
      phase: "initial-failure",
      file: "tests/one.test.ts",
    },
  ]);
  // The allowlist still holds: the failing assertion's own text never appears,
  // and neither does the line that follows Stryker's list.
  assert.equal(
    JSON.stringify(records).includes("a private assertion message"),
    false,
  );
  assert.equal(
    JSON.stringify(records).includes("There were failed tests"),
    false,
  );
});

test("every file in the dry run's failure list is named, not just the first", async () => {
  // Stryker says "one or more", and means it. Reporting the first would be a
  // diagnostic that is right often enough to be trusted and wrong exactly when
  // several suites go at once — which is the shape every intermittent in this
  // repository has had.
  //
  // The list is two lines per file, and this case used to feed only the first
  // kind: file after file, no message lines between. Under that invented
  // shape the detector named both files; under the real one - captured below
  // from a run with an induced failure - the message line ended the list and
  // the second file went unnamed. The shape is Stryker's now.
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("16:00:01 (612) ERROR DryRunExecutor One or more tests failed in the initial test run:")',
    'console.log("\\ttests/one.test.ts")',
    'console.log("\\t\\tone case: one case")',
    'console.log("\\ttests/two.test.ts")',
    'console.log("\\t\\ttwo case: two case")',
    'console.log("16:00:01 (612) ERROR Stryker There were failed tests in the initial test run.")',
    "setTimeout(() => process.exit(1), 30)",
  ].join(";");
  const code = await mutationProgress(
    process.execPath,
    ["-e", source],
    ["tests/one.test.ts", "tests/two.test.ts"],
    (record) => records.push(record),
  );
  assert.equal(code, 1);
  assert.deepEqual(
    records.filter((r) => r.phase === "initial-failure").map((r) => r.file),
    ["tests/one.test.ts", "tests/two.test.ts"],
  );
  // With no case inventory given, the message lines name nothing.
  assert.equal(JSON.stringify(records).includes("one case"), false);
});

test("a dry-run failure names the case that failed, from the inventory and nothing else", async () => {
  // The line is Stryker's, captured from a dry run of the one-file profile
  // with a failing case induced: the tap runner names the file as the test
  // and gives the TAP failures as `fullname: name`, so the case that failed
  // is on the second line and nowhere else. A hang the profile's bound turns
  // into a failure lands here with the hung test's name. The same line is
  // made to carry a name nobody listed, which must not travel.
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("20:42:01 (13202) ERROR DryRunExecutor One or more tests failed in the initial test run:")',
    'console.log("\\ttests/browser-snapshot.test.ts")',
    'console.log("\\t\\tsynthetic probe: a case that fails on purpose: synthetic probe: a case that fails on purpose, private case nobody listed: private case nobody listed")',
    'console.log("20:42:01 (13202) ERROR Stryker There were failed tests in the initial test run.")',
    "setTimeout(() => process.exit(1), 30)",
  ].join(";");
  const code = await mutationProgress(
    process.execPath,
    ["-e", source],
    ["tests/browser-snapshot.test.ts"],
    (record) => records.push(record),
    ["synthetic probe: a case that fails on purpose", "some other listed case"],
  );
  assert.equal(code, 1);
  const failures = records.filter((r) => r.phase === "initial-failure");
  assert.deepEqual(
    failures.map(({ elapsedMs: _elapsed, ...rest }) => rest),
    [
      { phase: "initial-failure", file: "tests/browser-snapshot.test.ts" },
      {
        phase: "initial-failure",
        file: "tests/browser-snapshot.test.ts",
        case: "synthetic probe: a case that fails on purpose",
      },
    ],
  );
  assert.equal(JSON.stringify(records).includes("nobody listed"), false);
});

test("a case is not attributed to a file the inventory does not know", async () => {
  // Half a diagnostic is worse than none: a case name with no file it belongs
  // to reads as a claim about the wrong suite, and the file on that line is
  // the one thing there nobody allowlisted.
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("16:00:01 (612) ERROR DryRunExecutor One or more tests failed in the initial test run:")',
    'console.log("\\t/private-checkout/tests/unlisted-private.test.ts")',
    'console.log("\\t\\tlisted case: listed case")',
    "setTimeout(() => process.exit(1), 30)",
  ].join(";");
  const code = await mutationProgress(
    process.execPath,
    ["-e", source],
    ["tests/one.test.ts"],
    (record) => records.push(record),
    ["listed case"],
  );
  assert.equal(code, 1);
  assert.equal(
    records.some((r) => r.phase === "initial-failure"),
    false,
  );
  assert.equal(JSON.stringify(records).includes("unlisted-private"), false);
});

test("of two nested inventory names only the one that failed is reported", async () => {
  // "a window" is part of "a window that closes"; when the longer one fails,
  // reporting the shorter too would read as a second failure that never
  // happened.
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("16:00:01 (612) ERROR DryRunExecutor One or more tests failed in the initial test run:")',
    'console.log("\\ttests/one.test.ts")',
    'console.log("\\t\\ta window that closes: a window that closes")',
    "setTimeout(() => process.exit(1), 30)",
  ].join(";");
  await mutationProgress(
    process.execPath,
    ["-e", source],
    ["tests/one.test.ts"],
    (record) => records.push(record),
    ["a window", "a window that closes"],
  );
  assert.deepEqual(
    records
      .filter((r) => r.phase === "initial-failure" && r.case !== undefined)
      .map((r) => r.case),
    ["a window that closes"],
  );
});

test("a failure naming something outside the inventory names nothing at all", async () => {
  // Guessing would be worse than silence, and an unrecognised name is the one
  // case where guessing is tempting: it is right there in the output. It is
  // also the only thing in that output nobody has allowlisted, so it is
  // exactly what must not travel.
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("16:00:01 (612) ERROR DryRunExecutor One or more tests failed in the initial test run:")',
    'console.log("\\t/private-checkout/tests/unlisted-private.test.ts")',
    "setTimeout(() => process.exit(1), 30)",
  ].join(";");
  const code = await mutationProgress(
    process.execPath,
    ["-e", source],
    ["tests/one.test.ts"],
    (record) => records.push(record),
  );
  assert.equal(code, 1);
  assert.equal(
    records.some((r) => r.phase === "initial-failure"),
    false,
  );
  assert.equal(JSON.stringify(records).includes("unlisted-private"), false);
});

test("mutation progress retains live inventory filenames and exit status, not diagnostics", async () => {
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("DEBUG ConfigReader synthetic-private-config")',
    'console.error("private-provider-diagnostic")',
    'console.log("16:00:00 (1) DEBUG TapTestRunner Running: `node \\\"tests/one.test.ts\\\"` in /private-checkout")',
    'console.log("16:00:00 (1) DEBUG TapTestRunner Running: `node \\\"tests/unknown-private.test.ts\\\"` in /private-checkout")',
    'console.error("16:00:01 (1) DEBUG TapTestRunner Running: `node \\\"tests/two.test.ts\\\"` in /private-checkout")',
    'console.error("16:00:02 (1) ERROR DryRunExecutor Initial test run timed out!")',
    "setTimeout(() => process.exit(7), 30)",
  ].join(";");
  const code = await mutationProgress(
    process.execPath,
    ["-e", source],
    ["tests/one.test.ts", "tests/two.test.ts"],
    (record) => records.push(record),
  );
  assert.equal(code, 7);
  assert.deepEqual(
    records
      .filter((r) => r.file)
      .map((r) => r.file)
      .sort(),
    ["tests/one.test.ts", "tests/two.test.ts"],
  );
  assert.equal(records.at(-1)?.phase, "exit");
  assert.equal(records.at(-1)?.code, 7);
  assert.equal(
    records.some((r) => r.phase === "initial-timeout"),
    true,
  );
  assert.equal(JSON.stringify(records).includes("private"), false);
  assert.ok(
    records.every((r) => typeof r.elapsedMs === "number" && r.elapsedMs >= 0),
  );
});

test("mutation progress stops logging file starts after the initial run and preserves success", async () => {
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("\\u001b[32mINFO DryRunExecutor Initial test run succeeded. Ran 98 tests\\u001b[0m")',
    'console.log("DEBUG TapTestRunner Running: `node \\\"tests/one.test.ts\\\"` in /private-checkout")',
    'console.log("Mutation testing 50% (elapsed: 1 minute, remaining: private-estimate) 10/20 tested (2 survived, 1 timed out)")',
    'console.log("Mutation testing 50% (elapsed: 1 minute) 10/20 tested (2 survived, 1 timed out) private-diagnostic")',
  ].join(";");
  assert.equal(
    await mutationProgress(
      process.execPath,
      ["-e", source],
      ["tests/one.test.ts"],
      (record) => records.push(record),
    ),
    0,
  );
  assert.deepEqual(
    records.map((r) => r.phase),
    ["mutants", "progress", "exit"],
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(records[1]!).filter(([key]) => key !== "elapsedMs"),
    ),
    { phase: "progress", tested: 10, total: 20, survived: 2, timedOut: 1 },
  );
  assert.equal(records.at(-1)?.code, 0);
  assert.equal(JSON.stringify(records).includes("private"), false);
});

test("a dry-run file that never ends is named and stopped, not left to the whole run's limit", async () => {
  // A stall outside any test - while loading, or in a hook - is bounded by
  // nothing but Stryker's 25-minute dry-run limit, which then names no file.
  const records: Array<Record<string, string | number | null>> = [];
  const source = [
    'console.log("DEBUG TapTestRunner Running: `node \\"tests/quick.test.ts\\"` in /private-checkout")',
    'console.log("DEBUG TapTestRunner Running: `node \\"tests/stuck.test.ts\\"` in /private-checkout")',
    "setTimeout(() => process.exit(0), 20_000)",
  ].join(";");
  const began = performance.now();
  const code = await mutationProgress(
    process.execPath,
    ["-e", source],
    ["tests/quick.test.ts", "tests/stuck.test.ts"],
    (record) => records.push(record),
    [],
    300,
  );
  assert.ok(performance.now() - began < 10_000, "the stall was not cut short");
  assert.equal(code, 1);
  assert.deepEqual(
    records
      .filter((r) => r.phase === "initial-stall")
      .map(({ phase, file }) => ({ phase, file })),
    [{ phase: "initial-stall", file: "tests/stuck.test.ts" }],
  );
  assert.equal(records.at(-1)?.code, 1);
  assert.equal(JSON.stringify(records).includes("private"), false);
});

test("a dry run that keeps starting files is never stopped for a stall", async () => {
  const records: Array<Record<string, string | number | null>> = [];
  const source = `
    let n = 0;
    const tick = setInterval(() => {
      console.log('DEBUG TapTestRunner Running: \`node "tests/f' + (n % 2) + '.test.ts"\` in /x');
      if (++n === 8) { clearInterval(tick); console.log("INFO DryRunExecutor Initial test run succeeded."); }
    }, 100);
  `;
  assert.equal(
    await mutationProgress(
      process.execPath,
      ["-e", source],
      ["tests/f0.test.ts", "tests/f1.test.ts"],
      (record) => records.push(record),
      [],
      400,
    ),
    0,
  );
  assert.equal(
    records.some((r) => r.phase === "initial-stall"),
    false,
  );
});

test("mutation progress fails closed without retaining spawn errors", async () => {
  const records: Array<Record<string, string | number | null>> = [];
  assert.equal(
    await mutationProgress("/nonexistent-private-command", [], [], (record) =>
      records.push(record),
    ),
    1,
  );
  assert.equal(records.at(-1)?.code, null);
  assert.equal(JSON.stringify(records).includes("private"), false);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`mutation progress forwards ${signal}, waits for cleanup and rejects interrupted success`, async () => {
    const source = `
      const deadline = setTimeout(() => process.exit(9), 2000);
      process.on(${JSON.stringify(signal)}, () => setTimeout(() => {
        console.error("private cleanup diagnostic");
        console.log("INFO DryRunExecutor Initial test run succeeded.");
        clearTimeout(deadline);
        process.exit(0);
      }, 20));
      console.log('DEBUG TapTestRunner Running: \`node "tests/ready.test.ts"\` in /private-checkout');
    `;
    const wrapper = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import { mutationProgress } from ${JSON.stringify(new URL("../scripts/verify-mutation.ts", import.meta.url).href)};
          const before = process.listenerCount(${JSON.stringify(signal)});
          const deadline = setTimeout(() => process.exit(9), 5000);
          process.exitCode = await mutationProgress(process.execPath, ["-e", ${JSON.stringify(source)}], ["tests/ready.test.ts"], record => console.log(JSON.stringify(record)));
          clearTimeout(deadline);
          console.log(JSON.stringify({ restored: process.listenerCount(${JSON.stringify(signal)}) === before }));
        `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let interrupted = false;
    wrapper.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (!interrupted && output.includes('"file":"tests/ready.test.ts"')) {
        interrupted = true;
        wrapper.kill(signal);
      }
    });
    wrapper.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => {
      wrapper.once("error", reject);
      wrapper.once("close", resolve);
    });
    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(interrupted, true);
    assert.equal(code, signal === "SIGINT" ? 130 : 143);
    assert.deepEqual(
      records.filter((record) => record.phase).map((record) => record.phase),
      ["initial", "mutants", "exit"],
    );
    assert.equal(records.at(-2)?.code, code);
    assert.deepEqual(records.at(-1), { restored: true });
    assert.equal(output.includes("private"), false);
  });
}
