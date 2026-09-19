import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? discover(join(directory, entry.name))
      : entry.name.endsWith(".test.ts")
        ? [join(directory, entry.name)]
        : [],
  );
}
const mode = process.argv[2] ?? "all";
const all = discover("tests").filter(
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
if (!Object.hasOwn(patterns, mode)) throw new Error("Unknown test profile");
const files = all.filter((file) => patterns[mode].test(file)).sort();
if (!files.length) throw new Error("No tests discovered for required profile");
/**
 * The case names a discovered file authors, as written.
 *
 * This is an inventory in the same sense the file list is: names that exist in
 * the repository, gathered so a sanitized failure report can name one without
 * ever echoing a line of test output. Only single-line string literals are
 * collected — a template literal can interpolate a value at runtime, and a name
 * that is not fixed in the source is not a name this inventory can vouch for.
 */
function caseNames(file) {
  return [
    ...readFileSync(file, "utf8").matchAll(
      /(?:^|[^\w.$])(?:test|it)\s*\(\s*(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1/g,
    ),
  ].map((match) => match[2].replace(/\\(.)/g, "$1"));
}
if (process.argv.includes("--inventory")) {
  const names = [...new Set(files.flatMap(caseNames))].sort();
  console.log(JSON.stringify({ mode, files, names }));
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
