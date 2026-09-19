export type TestCounts = { passed: number; failed: number; skipped: number };
/*
 * Order matters, and `build` comes before the test stages for a reason.
 *
 * A stage passes only when nothing was skipped -- see `summarizeStage`, where
 * `skipped === 0` is part of the condition. That is a deliberately strict rule:
 * a suite that quietly skips is a suite whose green is worth less. But it means
 * a test whose prerequisite this pipeline builds later can never pass, only
 * skip, and so fails the stage every time however healthy the code is.
 *
 * The packed-consumer test needs `dist/`. With `build` at stage six and
 * `test:coverage` at stage three it skipped on every run, and the stage failed
 * reporting "0 failed" -- a contradiction that says nothing about what to fix.
 * Building first makes the prerequisite true rather than relaxing the rule that
 * caught it, and a compile failure now arrives before the longest stage instead
 * of after it.
 */
export const requiredStages = [
  "format:check",
  "check",
  "build",
  "build:hosted",
  "build:vercel",
  "test:coverage",
  "test:workflow",
  "test:security:mutation",
  "test:e2e",
] as const;
export type VerificationStage = (typeof requiredStages)[number];

/** Retain known test files only, never diagnostic messages or absolute prefixes. */
export function failedTestFiles(output: string, inventory: readonly string[]) {
  const locations = [
    ...output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .matchAll(
        /^(?:test at |[ \t]*location: ['"])([^\r\n]+?):\d+:\d+['"]?[ \t]*$/gm,
      ),
  ].map((match) => match[1]!);
  return inventory.filter((file) =>
    locations.some(
      (location) => location === file || location.endsWith(`/${file}`),
    ),
  );
}

/**
 * Retain known test names only, never diagnostic messages or interpolated values.
 *
 * The file a failure lived in is rarely enough to act on: a suite that runs the
 * same eight cases against three browser engines reports "1 failed" in one file
 * and leaves every one of the twenty-four indistinguishable. The name is the
 * missing half, and it is authored repository content exactly as the file
 * inventory is — so it is matched the same way. Nothing from `output` is ever
 * returned; the output decides only which inventory entries are named, which is
 * what keeps a provider error, a stack frame or a credential echoed into a
 * failure message out of the retained record.
 */
export function failedTestNames(output: string, inventory: readonly string[]) {
  const reported = new Set(
    [
      ...output
        .replace(/\u001b\[[0-9;]*m/g, "")
        .matchAll(
          /^[ \t]*(?:not ok \d+ - |\u2716 )(.+?)(?: \(\d+(?:\.\d+)?ms\))?[ \t]*$/gm,
        ),
    ].map((match) => match[1]!),
  );
  return inventory.filter((name) => reported.has(name));
}

export function coverageTotals(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("total" in value) ||
    !value.total ||
    typeof value.total !== "object"
  )
    throw new Error("Missing coverage summary");
  const result: Record<string, Record<string, number>> = {};
  for (const metric of ["lines", "statements", "branches", "functions"]) {
    const source = Reflect.get(value.total, metric);
    if (!source || typeof source !== "object")
      throw new Error("Missing coverage metric");
    const target: Record<string, number> = {};
    for (const key of ["total", "covered", "skipped", "pct"]) {
      const number = Reflect.get(source, key);
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
        throw new Error("Invalid coverage metric");
      target[key] = number;
    }
    result[metric] = target;
  }
  return result;
}

/** Only aggregate counts leave this function; input diagnostics are never retained. */
export function summarizeStage(
  stage: VerificationStage,
  status: number | null,
  output: string,
  mutation?: unknown,
) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const match = (pattern: RegExp) => {
    const value = [...clean.matchAll(pattern)].at(-1)?.[1];
    return value === undefined ? null : Number(value);
  };
  let tests: TestCounts | null = null;
  let valid = true;
  if (stage === "test:coverage") {
    const passed = match(/^(?:ℹ|#) pass (\d+)\s*$/gm),
      failed = match(/^(?:ℹ|#) fail (\d+)\s*$/gm),
      skipped = match(/^(?:ℹ|#) skipped (\d+)\s*$/gm);
    valid = passed !== null && failed !== null && skipped !== null;
    tests = { passed: passed ?? 0, failed: failed ?? 0, skipped: skipped ?? 0 };
  } else if (stage === "test:workflow") {
    const summary = clean
      .split("\n")
      .findLast((line) => /^\s*Tests\s+/.test(line));
    valid = !!summary && /\(\d+\)/.test(summary);
    tests = {
      passed: Number(summary?.match(/(\d+) passed/)?.[1] ?? 0),
      failed: Number(summary?.match(/(\d+) failed/)?.[1] ?? 0),
      skipped:
        Number(summary?.match(/(\d+) skipped/)?.[1] ?? 0) +
        Number(summary?.match(/(\d+) todo/)?.[1] ?? 0),
    };
    if (
      Number(summary?.match(/\((\d+)\)/)?.[1]) !==
      tests.passed + tests.failed + tests.skipped
    )
      valid = false;
  } else if (stage === "test:e2e") {
    const passed = match(/^\s*(\d+) passed(?:\s+\([^\n]*\))?\s*$/gm);
    tests = {
      passed: passed ?? 0,
      failed:
        (match(/^\s*(\d+) failed\s*$/gm) ?? 0) +
        (match(/^\s*(\d+) flaky\s*$/gm) ?? 0),
      skipped:
        (match(/^\s*(\d+) skipped\s*$/gm) ?? 0) +
        (match(/^\s*(\d+) did not run\s*$/gm) ?? 0),
    };
    valid = passed !== null;
  } else if (stage === "test:security:mutation") {
    tests = { passed: 0, failed: 0, skipped: 0 };
    if (
      !mutation ||
      typeof mutation !== "object" ||
      !("files" in mutation) ||
      !mutation.files ||
      typeof mutation.files !== "object"
    )
      valid = false;
    else
      for (const file of Object.values(mutation.files)) {
        if (
          !file ||
          typeof file !== "object" ||
          !("mutants" in file) ||
          !Array.isArray(file.mutants)
        ) {
          valid = false;
          continue;
        }
        for (const mutant of file.mutants) {
          if (
            !mutant ||
            typeof mutant !== "object" ||
            typeof mutant.status !== "string"
          ) {
            valid = false;
            continue;
          }
          if (mutant.status === "Killed") tests.passed++;
          else if (["Ignored", "CompileError"].includes(mutant.status))
            tests.skipped++;
          else tests.failed++;
        }
      }
  }
  const exitCode =
    status === 0 &&
    valid &&
    (!tests || (tests.passed > 0 && tests.failed === 0 && tests.skipped === 0))
      ? 0
      : 1;
  return {
    command: `npm run ${stage}`,
    exitCode,
    processExitCode: status,
    tests,
  };
}
