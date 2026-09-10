import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type {
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

const projects = new Set(["chromium", "firefox", "webkit", "native-webmcp"]);
const statuses = new Set([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);

/** Positive allowlist: no test titles, raw exceptions, attachments or captured output. */
export function safeBrowserResult(
  input: {
    file: unknown;
    line: unknown;
    project: unknown;
    status: unknown;
    retry: unknown;
    duration: unknown;
    lastStepLine?: unknown;
    firstFailureLine?: unknown;
  },
  root = process.cwd(),
) {
  if (typeof input.file !== "string") return undefined;
  const file = relative(root, input.file).replaceAll("\\", "/");
  if (!/^tests\/browser\/[a-z0-9-]+\.spec\.ts$/.test(file)) return undefined;
  if (typeof input.project !== "string" || !projects.has(input.project))
    return undefined;
  if (typeof input.status !== "string" || !statuses.has(input.status))
    return undefined;
  for (const value of [input.line, input.retry, input.duration])
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      return undefined;
  for (const line of [input.lastStepLine, input.firstFailureLine])
    if (
      line !== undefined &&
      (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1)
    )
      return undefined;
  return {
    file,
    line: input.line,
    project: input.project,
    status: input.status,
    retry: input.retry,
    duration: input.duration,
    ...(input.lastStepLine === undefined
      ? {}
      : { lastStepLine: input.lastStepLine }),
    ...(input.firstFailureLine === undefined
      ? {}
      : { firstFailureLine: input.firstFailureLine }),
  };
}

export default class SafeBrowserReporter implements Reporter {
  private results: NonNullable<ReturnType<typeof safeBrowserResult>>[] = [];
  private lastSteps = new WeakMap<TestResult, number>();
  private failures = new WeakMap<TestResult, number>();
  onBegin() {
    this.results = [];
    this.lastSteps = new WeakMap();
    this.failures = new WeakMap();
    this.save();
  }
  onStepBegin(test: TestCase, result: TestResult, step: TestStep) {
    if (step.location?.file === test.location.file)
      this.lastSteps.set(result, step.location.line);
  }
  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    if (
      step.error &&
      step.location?.file === test.location.file &&
      !this.failures.has(result)
    )
      this.failures.set(result, step.location.line);
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const safe = safeBrowserResult({
      file: test.location.file,
      line: test.location.line,
      project: test.parent.project()?.name,
      status: result.status,
      retry: result.retry,
      duration: result.duration,
      lastStepLine: this.lastSteps.get(result),
      firstFailureLine: this.failures.get(result),
    });
    if (safe) this.results.push(safe);
    this.save();
  }
  private save() {
    const directory = resolve("artifacts/browser");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, "results.json"),
      JSON.stringify({ schemaVersion: 1, cases: this.results }),
      { mode: 0o600 },
    );
  }
}
