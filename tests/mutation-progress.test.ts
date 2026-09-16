import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mutationProgress } from "../scripts/verify-mutation.js";

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
