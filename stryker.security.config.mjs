import { readFileSync } from "node:fs";
const base = JSON.parse(
  readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"),
);
function guard(file, marker, lines = 1) {
  const source = readFileSync(file, "utf8").split("\n");
  const matches = source.flatMap((line, index) =>
    line.includes(marker) ? [index + 1] : [],
  );
  if (matches.length !== 1)
    throw new Error("Security mutation guard must resolve exactly once");
  return `${file}:${matches[0]}-${matches[0] + lines}`;
}
export default {
  ...base,
  mutate: [
    guard(
      "src/server/commands.ts",
      "if (!run || run.value.subjectId !== actor.subjectId)",
    ),
    guard("src/server/commands.ts", "if (prior.value.digest !== intent)"),
    guard("src/server/commands.ts", 'ownState?.value.state === "uncertain"', 2),
    guard(
      "src/server/commands.ts",
      'operation.classifications[name]?.classification !== "public"',
    ),
    guard("src/server/commands.ts", "verified = Boolean(", 3),
    guard(
      "src/server/persistence/index.ts",
      "Number(row.generation) !== fence.generation ||",
    ),
  ],
  tap: {
    ...base.tap,
    testFiles: [
      "tests/commands.test.ts",
      "tests/persistence.test.ts",
      "tests/security/*.test.ts",
    ],
  },
  jsonReporter: { fileName: "artifacts/security-mutation/mutation.json" },
  htmlReporter: { fileName: "artifacts/security-mutation/index.html" },
};
