import { readFileSync } from "node:fs";
const base = JSON.parse(
  readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"),
);
function guard(file, marker, lines = 1, offset = 0) {
  const source = readFileSync(file, "utf8").split("\n");
  const matches = source.flatMap((line, index) =>
    line.includes(marker) ? [index + 1] : [],
  );
  if (matches.length !== 1)
    throw new Error("Security mutation guard must resolve exactly once");
  return `${file}:${matches[0] + offset}-${matches[0] + offset + lines}`;
}
export default {
  ...base,
  mutate: [
    guard("src/core/schema.ts", 'field.type === "password" ||', 5, -2),
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
    guard("src/server/recipes/github.ts", 'actor.actorKind !== "human"', 7),
    guard(
      "src/server/recipes/github.ts",
      "record.value.subject !== actor.subjectId",
      3,
    ),
    guard("src/server/recipes/github.ts", 'account.type === "Organization"'),
    guard("src/server/recipes/github.ts", "setup_url:"),
    guard(
      "src/server/recipes/github.ts",
      'current.value.phase !== "uncertain"',
      3,
    ),
  ],
  tap: {
    ...base.tap,
    testFiles: [
      "tests/commands.test.ts",
      "tests/teaching-contracts.test.ts",
      "tests/persistence.test.ts",
      "tests/github-children.test.ts",
      "tests/security/*.test.ts",
    ],
  },
  jsonReporter: { fileName: "artifacts/security-mutation/mutation.json" },
  htmlReporter: { fileName: "artifacts/security-mutation/index.html" },
};
