import { readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function discover(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? discover(join(directory, entry.name), suffix)
      : entry.name.endsWith(suffix)
        ? [join(directory, entry.name)]
        : [],
  );
}
const mode = process.argv[2] ?? "all";
const all = discover("tests", ".test.ts").filter(
  (file) => !file.startsWith("tests/workflow/"),
);
const patterns = {
  all: /.*/,
  integration:
    /persistence|maintenance|collections|environment|identity|commands|recipes|github|hosted|integration|teaching-http/,
  security:
    /security|teaching-contracts|webmcp-unit|identity|commands|persistence/,
  agent: /agent/,
};
/*
 * Playwright owns running the browser suites, but nothing owned saying what
 * they contain — so a failing `test:e2e` could report a count and no name.
 * One script answers "what cases does this repository author" for both
 * runners, from one expression, which is the only way the two answers cannot
 * drift apart. Running is still refused here, because running them is not
 * this script's job and a caller that thinks otherwise should be told.
 */
if (mode === "browser") {
  if (!process.argv.includes("--inventory"))
    throw new Error("Browser suites are run by Playwright, not this script");
  console.log(
    JSON.stringify(
      inventory(mode, discover("tests/browser", ".spec.ts").sort()),
    ),
  );
  process.exit(0);
}
if (!Object.hasOwn(patterns, mode)) throw new Error("Unknown test profile");
const files = all.filter((file) => patterns[mode].test(file)).sort();
if (!files.length) throw new Error("No tests discovered for required profile");
/**
 * The case names a discovered file authors, as written.
 *
 * This is an inventory in the same sense the file list is: names that exist in
 * the repository, gathered so a sanitized failure report can name one without
 * ever echoing a line of test output. Only plain single-line string literals
 * count. A template literal can interpolate a value at run time, and a literal
 * carrying an escape does not read the same in the file as it does in a
 * result — `"say \\"hi\\""` is five characters shorter once unescaped. Either
 * way the name is not fixed in the source, so this inventory cannot vouch for
 * it and does not carry it: the failure is then reported by file alone, which
 * is what it was before. Requiring the closing quote to be followed by the
 * argument separator keeps a half-matched literal from entering as a truncated
 * name.
 *
 * `test(` and `it(` are the node suites' spelling and Playwright's alike, so
 * one expression inventories both. Excluding a leading `.` is what keeps
 * `test.describe(` out: a suite is not a case and no failure is reported
 * under one.
 */
function caseNames(file) {
  return [
    ...readFileSync(file, "utf8").matchAll(
      /(?:^|[^\w.$])(?:test|it)\s*\(\s*(["'])([^\\\r\n]*?)\1\s*[,)]/g,
    ),
  ].map((match) => match[2]);
}
/** What a profile contains: its files, and the names they author. */
function inventory(profile, discovered) {
  return {
    mode: profile,
    files: discovered,
    names: [...new Set(discovered.flatMap(caseNames))].sort(),
  };
}
if (process.argv.includes("--inventory")) {
  /*
   * Written synchronously, not with `console.log`. Writing to a pipe is
   * asynchronous and `process.exit` does not wait for the queue to drain, so a
   * payload larger than one pipe buffer reaches the reader cut off mid-string.
   * Once the case names joined the file list this document passed 140 kB and
   * every caller that parses it -- the mutation runner and the verification
   * runner both do -- died on an unterminated string rather than on anything
   * about the tests.
   *
   * The payload is `inventory()`'s, so whatever that grows to is written whole.
   * That matters more than it looks: this document only gets bigger, and the
   * defect appears when it crosses a buffer boundary rather than when the code
   * changes, so the two halves of it can be written months apart by people who
   * never see each other's failure.
   */
  writeSync(1, `${JSON.stringify(inventory(mode, files))}\n`);
  process.exit(0);
}
const probe = spawnSync(
  process.execPath,
  [
    "--no-experimental-webstorage",
    "--import",
    "tsx",
    "--test",
    "tests/fixtures/runner-sentinel.ts",
  ],
  { encoding: "utf8", env: process.env },
);
if (
  probe.status === 0 ||
  !`${probe.stdout ?? ""}${probe.stderr ?? ""}`.includes(
    "CEREMONY_EXPECTED_ASSERTION_FAILURE",
  )
) {
  console.error(
    "Node test execution unavailable: the required negative assertion preflight did not execute correctly.",
  );
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  // Files also launch browsers, databases and covered children. Bound the outer
  // pool rather than exhausting each nested fixture's unchanged deadline.
  [
    "--no-experimental-webstorage",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=4",
    ...files,
  ],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
