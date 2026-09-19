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
