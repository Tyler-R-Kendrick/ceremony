import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("canonical runner caps file concurrency without dropping inventory or failure guards", () => {
  const directory = mkdtempSync(join(tmpdir(), "ceremony-runner-"));
  const runner = fileURLToPath(new URL("../scripts/test.mjs", import.meta.url));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  try {
    mkdirSync(join(directory, "tests/fixtures"), { recursive: true });
    mkdirSync(join(directory, "tests/nested"));
    mkdirSync(join(directory, "tests/workflow"));
    symlinkSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    const sentinel = join(directory, "tests/fixtures/runner-sentinel.ts");
    writeFileSync(
      sentinel,
      readFileSync(new URL("./fixtures/runner-sentinel.ts", import.meta.url)),
    );
    const passing = `import {test} from 'node:test'; import assert from 'node:assert/strict'; test('real fixture assertion',()=>assert.equal(1,1));`;
    // A name carrying an escape does not read the same in the file as it does
    // in a result, so the inventory leaves it out rather than entering it in a
    // form that is not in the source. It still runs and still passes; only its
    // name is unavailable to a sanitized report.
    const escaped = `\ntest("a name with \\"quotes\\" is not inventoried",()=>assert.equal(1,1));`;
    writeFileSync(join(directory, "tests/one.test.ts"), passing + escaped);
    writeFileSync(join(directory, "tests/nested/two.test.ts"), passing);
    writeFileSync(
      join(directory, "tests/workflow/excluded.test.ts"),
      "throw Error('Wrong runner');",
    );
    // Observe actual child arguments without substituting assertion execution.
    const preload = join(directory, "observe.mjs");
    writeFileSync(
      preload,
      `import childProcess from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const original=childProcess.spawnSync; childProcess.spawnSync=(command,args,options)=>{console.log('RUNNER_SPAWN:'+JSON.stringify(args));return original(command,args,options);}; syncBuiltinESMExports();`,
    );
    const expectedFiles = ["tests/nested/two.test.ts", "tests/one.test.ts"];
    const inventory = JSON.parse(
      execFileSync(process.execPath, [runner, "all", "--inventory"], {
        cwd: directory,
        env: environment,
        encoding: "utf8",
        timeout: 15000,
      }),
    );
    // The case-name inventory is part of the contract: a sanitized failure
    // report names the case from it, so a runner that stopped emitting it
    // would silently take that name away again.
    assert.deepEqual(inventory, {
      mode: "all",
      files: expectedFiles,
      names: ["real fixture assertion"],
    });
    const run = () =>
      spawnSync(process.execPath, ["--import", preload, runner, "all"], {
        cwd: directory,
        env: environment,
        encoding: "utf8",
        timeout: 15000,
      });
    const success = run();
    assert.equal(success.error, undefined);
    assert.equal(success.status, 0);
    const calls = success.stdout
      .split("\n")
      .filter((line) => line.startsWith("RUNNER_SPAWN:"))
      .map(
        (line) => JSON.parse(line.slice("RUNNER_SPAWN:".length)) as string[],
      );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.at(-1), "tests/fixtures/runner-sentinel.ts");
    assert.deepEqual(calls[1], [
      "--no-experimental-webstorage",
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=4",
      ...expectedFiles,
    ]);
    writeFileSync(
      join(directory, "tests/one.test.ts"),
      passing.replace("assert.equal(1,1)", "assert.equal(1,2)"),
    );
    const failure = run();
    assert.equal(failure.status, 1);
    assert.match(failure.stdout, /real fixture assertion/);
    writeFileSync(sentinel, passing);
    const missingNegativeGuard = run();
    assert.equal(missingNegativeGuard.status, 1);
    assert.match(
      missingNegativeGuard.stderr,
      /required negative assertion preflight/,
    );
    assert.equal(
      missingNegativeGuard.stdout
        .split("\n")
        .filter((line) => line.startsWith("RUNNER_SPAWN:")).length,
      1,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the inventory reaches its reader whole, and is written so that it can", () => {
  /*
   * The inventory is piped out of a child and parsed, so its size is part of
   * its contract. Written with `console.log` and followed by `process.exit`, it
   * arrived cut off mid-string once the case names joined the file list: a pipe
   * write is asynchronous and exiting does not drain it. Every caller then died
   * on an unterminated document rather than on anything about the tests.
   *
   * How much escapes before the exit depends on timing, so a test that tried to
   * force the loss would be the flaky kind. This asserts the two things that
   * are deterministic instead: that no bytes go missing between the two ways of
   * reading the same document, and that the write is the synchronous kind --
   * the second is what actually fails the moment someone reverts it.
   */
  const runner = fileURLToPath(new URL("../scripts/test.mjs", import.meta.url));
  const source = readFileSync(runner, "utf8");
  // Phrased against the mechanism rather than the spelling, deliberately. The
  // first version of this pinned the exact payload expression
  // (`{ mode, files, names }`), and the very next change to this file moved the
  // payload into an `inventory()` function -- so the assertion would have failed
  // for a change that kept the synchronous write, while a change that restored
  // `console.log` around the new expression would have passed. What must hold is
  // that the document leaves through a synchronous write and not through
  // `console.log`, whatever shape the payload takes next.
  assert.match(
    source,
    /writeSync\(1, `\$\{JSON\.stringify\(/,
    "the inventory must be written synchronously, or a large one is truncated",
  );
  assert.doesNotMatch(
    source,
    /console\.log\(JSON\.stringify\((inventory|\{ mode)/,
    "console.log to a pipe does not drain before the process exits",
  );

  // And end to end: a redirect to a file always receives the whole document, so
  // comparing it against what a pipe delivers catches any loss on that path.
  const directory = mkdtempSync(join(tmpdir(), "ceremony-inventory-"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  try {
    mkdirSync(join(directory, "tests"), { recursive: true });
    symlinkSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    for (let file = 0; file < 40; file++) {
      const cases = Array.from({ length: 40 }, (_, index) =>
        JSON.stringify(
          `case ${file}-${index} with enough words in its name to take up room in the inventory document`,
        ),
      ).map((name) => `test(${name},()=>assert.equal(1,1));`);
      writeFileSync(
        join(directory, `tests/bulk-${file}.test.ts`),
        `import {test} from 'node:test'; import assert from 'node:assert/strict'; ${cases.join(" ")}`,
      );
    }
    const piped = execFileSync(
      process.execPath,
      [runner, "all", "--inventory"],
      { cwd: directory, env: environment, encoding: "utf8", timeout: 30000 },
    );
    const target = join(directory, "inventory.json");
    const redirected = spawnSync(
      process.execPath,
      [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(target)}, require("node:child_process").execFileSync(process.execPath, [${JSON.stringify(runner)}, "all", "--inventory"], { cwd: ${JSON.stringify(directory)}, stdio: ["ignore", "pipe", "inherit"] }))`,
      ],
      { cwd: directory, env: environment, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.ok(
      Buffer.byteLength(piped) > 65536,
      `the payload must exceed a pipe buffer to be worth comparing, got ${Buffer.byteLength(piped)}`,
    );
    assert.equal(
      piped,
      readFileSync(target, "utf8"),
      "the piped inventory lost bytes the file did not",
    );
    const inventory = JSON.parse(piped) as { files: string[]; names: string[] };
    assert.equal(inventory.files.length, 40);
    assert.equal(inventory.names.length, 1600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
