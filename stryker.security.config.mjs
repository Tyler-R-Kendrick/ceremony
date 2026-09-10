import { readFileSync } from "node:fs";
const base = JSON.parse(
  readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"),
);
function guard(file, marker, lines = 1, offset = 0, expectedMatches = 1) {
  const source = readFileSync(file, "utf8").split("\n");
  const matches = source.flatMap((line, index) =>
    line.includes(marker) ? [index + 1] : [],
  );
  if (matches.length !== expectedMatches)
    throw new Error("Security mutation guard count changed");
  return matches.map(
    (line) => `${file}:${line + offset}-${line + offset + lines}`,
  );
}
export default {
  ...base,
  // Isolate mutation workers to avoid timeout-only results under CPU contention.
  // The tests still exercise independent database workers concurrently.
  concurrency: 1,
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
    guard("src/server/github-runtime.ts", 'connectorId !== "github" ||'),
    guard("src/server/services.ts", "user.id !== expectedUserId ||"),
    guard("src/server/jira-auth.ts", "url.origin !== callback.origin ||"),
    guard("src/server/jira-auth.ts", "parsed.data.expiresAt <= now() ||"),
    guard("src/server/jira-auth.ts", "resource.scopes.includes(scope)"),
    guard("src/server/jira-auth.ts", "if (ids.size !== 1)"),
    guard("src/server/jira-auth.ts", 'user.accountId === "unknown" ||', 3),
    guard(
      "src/server/oauth-handoff.ts",
      "record.value.runId !== context.runId ||",
    ),
    guard(
      "src/server/oauth-handoff.ts",
      "index.subjectId !== actor.subjectId ||",
      2,
    ),
    guard(
      "src/server/oauth-handoff.ts",
      "const session = this.options.sessionSchema.parse(",
      5,
    ),
    guard("src/server/supabase-auth.ts", 'verified.claims.aal !== "aal2"'),
    guard("src/server/supabase-auth.ts", "factor.id === factorId &&", 3),
    guard(
      "src/server/recipes/supabase.ts",
      'context.actor.actorKind !== "human"',
      1,
      0,
      2,
    ),
    guard(
      "src/server/recipes/stripe.ts",
      'context.actor.actorKind !== "human"',
    ),
    guard(
      "src/server/recipes/stripe.ts",
      'balance.livemode !== token.includes("_live_")',
    ),
    guard("src/server/recipes/github.ts", "setup_url:"),
    guard(
      "src/server/recipes/github.ts",
      'current.value.phase !== "uncertain"',
      3,
    ),
  ].flat(),
  tap: {
    ...base.tap,
    testFiles: [
      "tests/commands.test.ts",
      "tests/teaching-contracts.test.ts",
      "tests/persistence.test.ts",
      "tests/github-children.test.ts",
      "tests/github-runtime-http.test.ts",
      "tests/stripe-children.test.ts",
      "tests/services.test.ts",
      "tests/jira-auth.test.ts",
      "tests/oauth-handoff.test.ts",
      "tests/supabase-auth.test.ts",
      "tests/supabase-mfa.test.ts",
      "tests/supabase-children.test.ts",
      "tests/security/*.test.ts",
    ],
  },
  jsonReporter: { fileName: "artifacts/security-mutation/mutation.json" },
  htmlReporter: { fileName: "artifacts/security-mutation/index.html" },
};
