import { readdirSync } from "node:fs";
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
    /persistence|identity|commands|recipes|github-children|integration|teaching-http/,
  security:
    /security|teaching-contracts|webmcp-unit|identity|commands|persistence/,
  agent: /agent/,
};
if (!Object.hasOwn(patterns, mode)) throw new Error("Unknown test profile");
const files = all.filter((file) => patterns[mode].test(file)).sort();
if (!files.length) throw new Error("No tests discovered for required profile");
if (process.argv.includes("--inventory")) {
  console.log(JSON.stringify({ mode, files }));
  process.exit(0);
}
const result = spawnSync(
  process.execPath,
  ["--no-experimental-webstorage", "--import", "tsx", "--test", ...files],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
