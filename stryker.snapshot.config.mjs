import { readFileSync } from "node:fs";
const base = JSON.parse(
  readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"),
);
// Browser-evaluated code must run in-process for Stryker's coverage helpers.
// The real browser label regressions remain in browser-executor.test.ts.
const file = "src/server/browser-executor.ts";
const lines = readFileSync(file, "utf8").split("\n");
const matches = lines.flatMap((line, index) =>
  line.includes("input.labels?.[0]?.textContent?.trim() ??") ? [index + 1] : [],
);
if (matches.length !== 1) throw new Error("Snapshot label guard count changed");
export default {
  ...base,
  mutate: matches.map((line) => `${file}:${line}-${line}`),
  tap: { ...base.tap, testFiles: ["tests/browser-snapshot.test.ts"] },
  jsonReporter: { fileName: "artifacts/auth-mutation/snapshot.json" },
  htmlReporter: { fileName: "artifacts/auth-mutation/snapshot.html" },
};
