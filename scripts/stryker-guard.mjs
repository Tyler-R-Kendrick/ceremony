import { readFileSync } from "node:fs";

/**
 * Pin a mutation target to a guard's current line range by the text of the
 * guard itself, rather than to a line number that any edit above it moves.
 *
 * `expectedMatches` is the point of the exercise. Mutating a line range that
 * no longer holds the guard reports a healthy score over code nobody is
 * checking, which is worse than not mutating it at all: it is a green light
 * with nothing behind it. So a marker that stops matching, or starts matching
 * somewhere new, fails the run instead of silently moving the target.
 *
 * @param file source file containing the guard
 * @param marker substring identifying the guard's first line
 * @param lines how many lines after the marker belong to the guard
 * @param offset shift applied to the marker line, for a guard whose condition
 *   begins above its marker
 * @param expectedMatches how many times the marker must appear
 */
export function guard(
  file,
  marker,
  lines = 1,
  offset = 0,
  expectedMatches = 1,
) {
  const source = readFileSync(file, "utf8").split("\n");
  const matches = source.flatMap((line, index) =>
    line.includes(marker) ? [index + 1] : [],
  );
  if (matches.length !== expectedMatches)
    throw new Error(
      `Mutation guard marker ${JSON.stringify(marker)} in ${file} matched ` +
        `${matches.length} lines, expected ${expectedMatches}. The guard moved ` +
        `or changed spelling: update the marker rather than the expectation.`,
    );
  return matches.map(
    (line) => `${file}:${line + offset}-${line + offset + lines}`,
  );
}
