export type TestCounts = { passed: number; failed: number; skipped: number };
export const requiredStages = [
  "format:check",
  "check",
  "test:coverage",
  "test:workflow",
  "test:security:mutation",
  "build",
  "build:hosted",
  "test:e2e",
] as const;
export type VerificationStage = (typeof requiredStages)[number];
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
