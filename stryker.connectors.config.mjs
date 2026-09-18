import { readFileSync } from "node:fs";
import { guard } from "./scripts/stryker-guard.mjs";

const base = JSON.parse(
  readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"),
);

const identity = "src/core/connectors/identity.ts";
const binding = "src/server/connectors/binding.ts";

/*
 * Mutation over the connector guards.
 *
 * These are the checks that decide what an approved binding may reach and what
 * an identifier may say, so a test that passes whether or not the check is
 * there is not evidence of anything. Mutation is how that gets measured: each
 * entry below is a guard whose removal or inversion must make a test fail.
 *
 * Narrow line ranges, not whole files, for the same reason the security config
 * uses them. `binding.ts` also carries approval bookkeeping that these test
 * files do not reach, and mutating it here would report survivors that say
 * nothing about the guards and drag the score under the threshold — a number
 * that punishes the wrong code teaches its reader to raise the threshold
 * rather than fix the test.
 *
 * The ranges stop at the condition and exclude the `throw` beneath it. A
 * mutant that empties an error message leaves the guard refusing exactly what
 * it refused before, so every `assert.throws` still passes and the mutant
 * survives. Counting that as an escaped guard would understate the guards that
 * are genuinely covered, and the message wording is not what these tests are
 * for.
 *
 * The test files are scoped for cost, not convenience: `coverageAnalysis` is
 * per test and concurrency is one, so every additional file is paid for on
 * every mutant. These cover the guards densely, including the property-based
 * identifier tests, and need no database, network or browser.
 */
export default {
  ...base,
  concurrency: 1,
  mutate: [
    // An identifier is what a reviewer reads before deciding what a connector
    // may touch, so what it may contain is a security boundary.
    guard(identity, "const noControlCharacters = ", 0),
    guard(identity, "const noControlCharactersOrEmpty = ", 0),
    guard(identity, "const noBidiControls =", 1),
    guard(identity, "const traversal = ", 0),
    guard(identity, "const notBlank = ", 0),
    // Encoded exactly once, at the boundary. A mutant that drops the extra
    // escapes, or re-encodes, must not survive.
    guard(identity, "return encodeURIComponent(value).replace(", 3),
    // A digest must not become a stack overflow.
    guard(identity, "if (depth > CANONICAL_DEPTH)", 0),
    // Containment in the plain builder: shape, origin, then prefix.
    guard(binding, 'if (!path.startsWith("/") || path.startsWith("//")', 0),
    guard(binding, "if (url.origin !== destination.origin)", 0),
    guard(binding, 'normalized.split("/").includes("..") ||', 5, -1),
    // Containment in the segment builder, which additionally refuses a value
    // that is inert as sent but traverses once something decodes it.
    guard(binding, 'if (value === "") throw new Error(', 0),
    guard(binding, 'if (encoded === "." || encoded === "..")', 0),
    guard(binding, "if (url.origin !== checked.origin)", 0),
    guard(binding, "if (url.pathname !== pathname)", 0),
    guard(binding, 'url.pathname.split("/").includes("..") ||', 8, -1),
  ].flat(),
  tap: {
    ...base.tap,
    testFiles: [
      "tests/connectors/contracts/*.test.ts",
      "tests/connectors/binding/segments.test.ts",
    ],
  },
  jsonReporter: { fileName: "artifacts/connector-mutation/mutation.json" },
  htmlReporter: { fileName: "artifacts/connector-mutation/index.html" },
};
