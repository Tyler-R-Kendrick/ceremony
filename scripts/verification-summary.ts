export type TestCounts = { passed: number; failed: number; skipped: number };
export const requiredStages = [
  "format:check",
  "check",
  "test:coverage",
  "test:workflow",
  "test:security:mutation",
  "build",
  "build:hosted",
  "build:vercel",
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

/**
 * The same pair of answers for a browser run, whose reporter says it its own way.
 *
 * A failing `test:e2e` stage used to report the count and nothing else — "172
 * passed, 1 failed" with no file and no case — because the inventory the other
 * two functions read is the node suites' and stops at `tests/browser`. Which
 * of a hundred and seventy-two was the one is not something anybody could work
 * out from that, and re-running the suite to find out costs eleven minutes.
 *
 * Playwright names the failure in a header of its own — `1) [chromium] ›
 * file.spec.ts:12:3 › suite › case` — so both halves are already in the
 * output. They are read back the same way as everywhere else here: the header
 * decides which inventory entries are named, and only inventory entries are
 * returned, so nothing a provider, a page or an assertion message put in the
 * output can reach the retained record. A case whose title the inventory
 * cannot vouch for — interpolated, or escaped — is reported by file alone,
 * which is what every browser failure got before.
 *
 * The numbered prefix is what separates a failure from the progress line for
 * the same case, which the same reporter writes as `[86/172] [chromium] ›
 * file.spec.ts:12:3 › suite › case`. Requiring it means a run whose failure
 * headers are missing names nothing, rather than a run whose every case is
 * named as failing.
 */
export function failedBrowserTests(
  output: string,
  inventory: { files: readonly string[]; names: readonly string[] },
) {
  const headers = [
    ...output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .matchAll(
        /^[ \t]*\d+\) (?:\[[^\]\r\n]+\] \u203a )?([^\r\n]+?):\d+:\d+ \u203a ([^\r\n]+?)[ \t]*$/gm,
      ),
  ];
  const locations = headers.map((match) => match[1]!);
  /*
   * Every suffix of the describe chain, not just its last segment: the case is
   * the end of it, and a case whose own title contains the separator would
   * otherwise be cut in half and match nothing. The suites above it are not in
   * the inventory, so offering them costs nothing.
   */
  const titles = new Set(
    headers.flatMap((match) => {
      const chain = match[2]!.split(" \u203a ");
      return chain.map((_, index) => chain.slice(index).join(" \u203a "));
    }),
  );
  return {
    files: inventory.files.filter((file) =>
      locations.some(
        (location) => location === file || location.endsWith(`/${file}`),
      ),
    ),
    names: inventory.names.filter((name) => titles.has(name)),
  };
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
